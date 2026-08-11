/**
 * @file main.c
 * @brief Punto de entrada del firmware CALI CSI Node.
 *
 * Target-agnostic: compila para ESP32-S3, ESP32-C6 o ESP32-C3 vía
 * `idf.py set-target`. El API CSI (esp_wifi_set_csi + WIFI_EVENT_CSI)
 * es idéntico en los 3 targets, por lo que la lógica no requiere
 * condicionales de compilación por target.
 *
 * Inicializa NVS, lee la configuración del nodo, valida campos obligatorios,
 * inicializa Wi-Fi en modo STA, configura el motor CSI y el transmisor de
 * tramas ping, conecta al broker MQTT con autenticación PSK, y registra
 * el callback de recepción CSI para alimentar el motor de detección de movimiento.
 *
 * Cada 2 segundos (cuando la ventana deslizante está llena) se calcula
 * motion_probability y se publica via MQTT en cali/zone/{zone_id}/csi.
 *
 * Requisitos implementados: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 6.5
 */

#include <stdio.h>
#include <string.h>
#include <math.h>

#include "esp_log.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include "nvs_config.h"
#include "csi_engine.h"
#include "csi_transmitter.h"
#include "csi_publisher.h"
#include "led_indicator.h"
#include "power_mgmt.h"
#include "cali_mqtt.h"
#include "wifi_manager.h"

static const char *TAG = "cali_main";

/** Configuración global del nodo (leída desde NVS). */
static node_config_t s_node_config;

/**
 * Callback de recepción CSI.
 *
 * Se invoca cada vez que el driver Wi-Fi recibe una trama con información
 * CSI. Extrae las amplitudes de subportadora de los datos I/Q crudos y
 * las alimenta al motor CSI.
 *
 * Los datos CSI vienen como pares (I, Q) de int8_t para cada subportadora.
 * El formato es idéntico en ESP32-S3 / ESP32-C6 / ESP32-C3.
 * La amplitud se calcula como sqrt(I² + Q²).
 */
static void wifi_csi_rx_callback(void *ctx, wifi_csi_info_t *info)
{
    if (info == NULL || info->buf == NULL || info->len == 0) {
        return;
    }

    csi_frame_t frame;
    frame.timestamp_ms = esp_timer_get_time() / 1000; /* us → ms */

    /*
     * Extraer amplitudes de subportadora de los datos I/Q crudos.
     * Los datos CSI son pares (I, Q) como int8_t, 2 bytes por subportadora.
     * Procesamos hasta 64 subportadoras o lo que esté disponible.
     */
    int8_t *raw_data = (int8_t *)info->buf;
    int num_available = info->len / 2; /* Pares I/Q disponibles */
    int num_subcarriers = (num_available < CSI_NUM_SUBCARRIERS)
                          ? num_available
                          : CSI_NUM_SUBCARRIERS;

    /* Calcular amplitud para cada subportadora: |H| = sqrt(I² + Q²) */
    for (int i = 0; i < num_subcarriers; i++) {
        float i_val = (float)raw_data[i * 2];
        float q_val = (float)raw_data[i * 2 + 1];
        frame.subcarrier_amplitudes[i] = sqrtf(i_val * i_val + q_val * q_val);
    }

    /* Rellenar con ceros si hay menos subportadoras disponibles */
    for (int i = num_subcarriers; i < CSI_NUM_SUBCARRIERS; i++) {
        frame.subcarrier_amplitudes[i] = 0.0f;
    }

    /* Alimentar trama al motor CSI */
    csi_engine_feed_frame(&frame);
}

/**
 * Configurar la recepción CSI en el driver Wi-Fi.
 *
 * Habilita la captura de CSI para todas las tramas recibidas y registra
 * el callback que alimenta al motor de procesamiento.
 */
static esp_err_t csi_init_rx(void)
{
    /* Configuración CSI: capturar de todas las tramas */
    wifi_csi_config_t csi_config = {
        .lltf_en = true,           /* Long Training Field */
        .htltf_en = true,          /* HT Long Training Field */
        .stbc_htltf2_en = true,    /* STBC HT-LTF2 */
        .ltf_merge_en = true,      /* Fusionar LTFs */
        .channel_filter_en = false,/* No filtrar por canal */
        .manu_scale = false,       /* Escala automática */
        .shift = false,            /* Sin desplazamiento */
    };

    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_config));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(wifi_csi_rx_callback, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    ESP_LOGI(TAG, "Recepción CSI configurada y habilitada");

    return ESP_OK;
}

/**
 * Tarea de cálculo periódico de motion_probability.
 *
 * Cada 2 segundos verifica si la ventana deslizante está llena y
 * calcula la probabilidad de movimiento. La lectura se almacena
 * internamente para que la tarea MQTT (tarea 10.4) la publique.
 */
static void csi_compute_task(void *pvParameters)
{
    const TickType_t compute_period = pdMS_TO_TICKS(2000); /* 2 segundos */
    motion_reading_t reading;

    ESP_LOGI(TAG, "Tarea de cálculo CSI iniciada (período: 2s)");

    while (1) {
        vTaskDelay(compute_period);

        if (!csi_engine_window_full()) {
            ESP_LOGD(TAG, "Ventana CSI aún no llena, esperando...");
            continue;
        }

        esp_err_t err = csi_engine_compute(&reading);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "motion_probability=%.3f zona='%s' nodo='%s'",
                     reading.motion_probability,
                     reading.zone_id,
                     reading.node_id);

            /* Actualizar LED basado en motion_probability (Req 9.3) */
            led_indicator_update(reading.motion_probability);

            /*
             * Publicar lectura via MQTT en cali/zone/{zone_id}/csi.
             * El csi_publisher delega al cliente MQTT CALI, que publica
             * directamente si conectado o almacena en buffer si no.
             *
             * Adicionalmente, si Wi-Fi está desconectado, almacenamos
             * en el buffer del wifi_manager (60 lecturas) para publicar
             * en bloque al reconectar (Req 10.1).
             */
            if (!wifi_manager_is_connected()) {
                wifi_manager_buffer_reading(&reading);
            }

            esp_err_t pub_err = csi_publisher_publish(&reading);
            if (pub_err != ESP_OK) {
                ESP_LOGW(TAG, "Error publicando lectura: %s",
                         esp_err_to_name(pub_err));
            }
        } else {
            ESP_LOGW(TAG, "Error calculando motion_probability: %s",
                     esp_err_to_name(err));
        }
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "=== CALI CSI Node - Iniciando ===");

    /* Paso 1: Inicializar NVS Flash */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /*
         * Si la partición NVS está truncada o tiene versión incompatible,
         * borrar y reinicializar. Esto no debería pasar en producción con
         * la tabla de particiones correcta, pero es manejo defensivo.
         */
        ESP_LOGW(TAG, "NVS requiere borrado: %s", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_LOGI(TAG, "NVS Flash inicializado correctamente");

    /* Paso 2: Leer configuración desde NVS */
    err = nvs_config_read(&s_node_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Fallo al leer configuración NVS: %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "Entrando en modo error (LED 4Hz)...");
        nvs_config_halt_with_blink();
        /* No retorna */
    }

    /* Paso 3: Validar configuración */
    if (!nvs_config_validate(&s_node_config)) {
        ESP_LOGE(TAG, "Configuración NVS inválida");
        ESP_LOGE(TAG, "Entrando en modo error (LED 4Hz)...");
        nvs_config_halt_with_blink();
        /* No retorna */
    }

    /* Configuración válida — continuar inicialización */
    ESP_LOGI(TAG, "Configuración cargada exitosamente:");
    ESP_LOGI(TAG, "  zone_id     : %s", s_node_config.zone_id);
    ESP_LOGI(TAG, "  mqtt_host   : %s", s_node_config.mqtt_broker_host);
    ESP_LOGI(TAG, "  mqtt_port   : %d", s_node_config.mqtt_broker_port);
    ESP_LOGI(TAG, "  node_id     : %s", s_node_config.node_id);
    ESP_LOGI(TAG, "  csi_tx_rate : %d fps", s_node_config.csi_tx_rate);
    ESP_LOGI(TAG, "  window_size : %d muestras", s_node_config.window_size);

    /* Paso 4: Inicializar Wi-Fi en modo STA con reconexión exponencial backoff */
    err = wifi_manager_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error inicializando gestor Wi-Fi: %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "Entrando en modo error (LED 4Hz)...");
        nvs_config_halt_with_blink();
        /* No retorna */
    }

    /* Paso 5: Inicializar motor CSI */
    csi_engine_config_t csi_config = {
        .tx_rate = s_node_config.csi_tx_rate,
        .window_size = s_node_config.window_size,
    };
    strncpy(csi_config.zone_id, s_node_config.zone_id, sizeof(csi_config.zone_id) - 1);
    csi_config.zone_id[sizeof(csi_config.zone_id) - 1] = '\0';
    strncpy(csi_config.node_id, s_node_config.node_id, sizeof(csi_config.node_id) - 1);
    csi_config.node_id[sizeof(csi_config.node_id) - 1] = '\0';

    err = csi_engine_init(&csi_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error inicializando motor CSI: %s", esp_err_to_name(err));
        ESP_LOGE(TAG, "Entrando en modo error (LED 4Hz)...");
        nvs_config_halt_with_blink();
        /* No retorna */
    }

    /* Paso 6: Configurar recepción CSI */
    err = csi_init_rx();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error configurando recepción CSI: %s", esp_err_to_name(err));
        nvs_config_halt_with_blink();
        /* No retorna */
    }

    /* Paso 7: Iniciar transmisor de tramas CSI ping */
    csi_transmitter_config_t tx_config = {
        .tx_rate_fps = s_node_config.csi_tx_rate,
    };
    err = csi_transmitter_start(&tx_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error iniciando transmisor CSI: %s", esp_err_to_name(err));
        /* No fatal — se puede operar en modo pasivo (solo recepción) */
        ESP_LOGW(TAG, "Continuando en modo recepción CSI pasiva");
    }

    /* Paso 8: Crear tarea de cálculo periódico de motion_probability */
    BaseType_t task_created = xTaskCreate(
        csi_compute_task,
        "csi_compute",
        4096,           /* Stack size */
        NULL,           /* Parámetros */
        5,              /* Prioridad */
        NULL            /* Handle */
    );

    if (task_created != pdPASS) {
        ESP_LOGE(TAG, "Error creando tarea de cálculo CSI");
        nvs_config_halt_with_blink();
        /* No retorna */
    }

    /* Paso 9: Inicializar cliente MQTT con PSK y buffering (Req 9.6, 6.5) */
    cali_mqtt_config_t mqtt_config = { 0 };
    strncpy(mqtt_config.broker_host, s_node_config.mqtt_broker_host,
            sizeof(mqtt_config.broker_host) - 1);
    mqtt_config.broker_port = s_node_config.mqtt_broker_port;
    strncpy(mqtt_config.token, s_node_config.mqtt_token,
            sizeof(mqtt_config.token) - 1);
    strncpy(mqtt_config.zone_id, s_node_config.zone_id,
            sizeof(mqtt_config.zone_id) - 1);
    strncpy(mqtt_config.node_id, s_node_config.node_id,
            sizeof(mqtt_config.node_id) - 1);

    err = cali_mqtt_init(&mqtt_config);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Error inicializando MQTT: %s (continuando sin broker)",
                 esp_err_to_name(err));
        /* No fatal — el nodo puede operar offline, almacenando en buffer */
    }

    /* Paso 10: Inicializar indicador LED (Req 9.3) */
    err = led_indicator_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Error inicializando indicador LED: %s", esp_err_to_name(err));
        /* No fatal — el nodo puede operar sin LED indicador */
    }

    /* Paso 11: Configurar gestión de energía (Req 9.4) */
    err = power_mgmt_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Power Management no disponible — consumo mayor");
        /* No fatal — operación normal sin ahorro de energía */
    }

    ESP_LOGI(TAG, "=== CALI CSI Node - Inicialización completa ===");
    ESP_LOGI(TAG, "Transmitiendo CSI a %d fps, ventana de %d muestras",
             s_node_config.csi_tx_rate, s_node_config.window_size);
}
