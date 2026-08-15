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
#include <stdlib.h>  /* qsort: mediana de las muestras de ganancia */
#include <math.h>

#include "esp_log.h"
#include "esp_event.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "esp_netif.h"
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
#include "wifi_provisioning.h"
#include "ota_update.h"
#include "ws2812_led.h"

static const char *TAG = "cali_main";

/**
 * BSSID del AP usado para filtrar las tramas CSI, y su validez.
 *
 * Lo refresca periódicamente csi_compute_task() desde el gestor Wi-Fi. Mientras
 * no haya un BSSID válido (sin asociar, o en modo SoftAP) NO se filtra: se
 * prefiere capturar de más antes que quedarse sin datos.
 */
static uint8_t s_csi_filter_bssid[6];
static volatile bool s_csi_filter_valid = false;

/* ─── Bloqueo de ganancia AGC/FFT para estabilizar la amplitud CSI ───────
 *
 * El front-end de radio del ESP32 aplica control automatico de ganancia. Cada
 * vez que el AGC cambia de escalon, la amplitud CSI salta aunque el entorno
 * este completamente quieto: medido en campo, la desviacion tipica por
 * subportadora era ~20% de la media con la zona inmovil, suficiente para
 * enterrar la modulacion de una respiracion.
 *
 * Mitigacion (recomendada por Espressif en sus ejemplos de esp-csi): medir la
 * ganancia durante los primeros paquetes tras el arranque y FIJARLA, para que
 * la amplitud deje de depender del AGC.
 *
 * Se toma la MEDIANA y no la media: el AGC salta en escalones discretos y unos
 * pocos paquetes atipicos (por interferencia) desviarian la media hacia un
 * valor que el hardware nunca usa realmente.
 *
 * Precaucion: con senal muy fuerte (nodo pegado al router) el AGC queda muy
 * bajo, y forzarlo ahi puede congelar la recepcion CSI. Por debajo de
 * GAIN_MIN_SAFE_AGC no se bloquea y se deja el AGC automatico.
 *
 * Solo disponible en variantes que exponen estas funciones del blob PHY.
 */
#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32C5 || CONFIG_IDF_TARGET_ESP32C6
#define CALI_GAIN_LOCK_SUPPORTED 1
#else
#define CALI_GAIN_LOCK_SUPPORTED 0
#endif

#if CALI_GAIN_LOCK_SUPPORTED

/* Funciones del blob PHY de ESP-IDF: no estan en los headers publicos. */
extern void phy_fft_scale_force(bool force_en, int8_t force_value);
extern void phy_force_rx_gain(int force_en, int force_value);

/*
 * Vista de wifi_csi_info_t que expone los campos de ganancia del PHY, que no
 * forman parte de la API publica. El relleno replica el layout binario de
 * wifi_pkt_rx_ctrl_t hasta la posicion de fft_gain/agc_gain.
 */
typedef struct {
    unsigned : 32;
    unsigned : 32;
    unsigned : 32;
    unsigned : 32;
    unsigned : 32;
    unsigned : 16;
    signed   fft_gain : 8;
    unsigned agc_gain : 8;
} cali_rx_ctrl_phy_t;

/** Paquetes usados para estimar la ganancia antes de fijarla. */
#define GAIN_CALIBRATION_PACKETS 300

/** Por debajo de este AGC no se bloquea: forzarlo puede congelar el CSI. */
#define GAIN_MIN_SAFE_AGC 30

static uint8_t s_agc_samples[GAIN_CALIBRATION_PACKETS];
static int8_t s_fft_samples[GAIN_CALIBRATION_PACKETS];
static uint16_t s_gain_sample_count = 0;
static volatile bool s_gain_locked = false;

static int cmp_u8(const void *a, const void *b)
{
    return (int)(*(const uint8_t *)a) - (int)(*(const uint8_t *)b);
}

static int cmp_i8(const void *a, const void *b)
{
    return (int)(*(const int8_t *)a) - (int)(*(const int8_t *)b);
}

/**
 * Acumular ganancias y, al completar la muestra, fijarlas.
 *
 * Se invoca desde el callback CSI. Una vez bloqueado no vuelve a hacer trabajo.
 */
static void gain_lock_process_packet(const wifi_csi_info_t *info)
{
    if (s_gain_locked || info == NULL) {
        return;
    }

    const cali_rx_ctrl_phy_t *phy = (const cali_rx_ctrl_phy_t *)info;
    s_agc_samples[s_gain_sample_count] = (uint8_t)phy->agc_gain;
    s_fft_samples[s_gain_sample_count] = (int8_t)phy->fft_gain;
    s_gain_sample_count++;

    if (s_gain_sample_count < GAIN_CALIBRATION_PACKETS) {
        return;
    }

    qsort(s_agc_samples, GAIN_CALIBRATION_PACKETS, sizeof(uint8_t), cmp_u8);
    qsort(s_fft_samples, GAIN_CALIBRATION_PACKETS, sizeof(int8_t), cmp_i8);
    uint8_t agc_median = s_agc_samples[GAIN_CALIBRATION_PACKETS / 2];
    int8_t fft_median = s_fft_samples[GAIN_CALIBRATION_PACKETS / 2];

    s_gain_locked = true;

    if (agc_median < GAIN_MIN_SAFE_AGC) {
        ESP_LOGW(TAG, "Ganancia NO bloqueada: AGC=%u < %d (senal demasiado fuerte). "
                 "Alejar el nodo del router mejoraria la estabilidad del CSI.",
                 (unsigned)agc_median, GAIN_MIN_SAFE_AGC);
        return;
    }

    phy_fft_scale_force(true, fft_median);
    phy_force_rx_gain(1, (int)agc_median);
    ESP_LOGI(TAG, "Ganancia bloqueada: AGC=%u, FFT=%d (mediana de %d paquetes)",
             (unsigned)agc_median, (int)fft_median, GAIN_CALIBRATION_PACKETS);
}

#else /* !CALI_GAIN_LOCK_SUPPORTED */

static void gain_lock_process_packet(const wifi_csi_info_t *info)
{
    (void)info; /* Variante sin acceso a las funciones de ganancia del PHY. */
}

#endif

/**
 * Fase 0 (csi-vitals-per-node, gate de validacion): activa/desactiva el
 * calculo de fase por subportadora (atan2f x64) en el callback CSI y la
 * tarea de publicacion del spike (10 Hz).
 *
 * Default 0 (desactivado): el callback CSI solo calcula amplitud, igual
 * que antes de este cambio — restaura la estabilidad de conexion Wi-Fi
 * observada en produccion. atan2f x64 por cada trama recibida (todas las
 * tramas, no solo las del nodo — channel_filter_en=false en csi_init_rx)
 * compite por CPU con la tarea interna de Wi-Fi y se confirmo en campo
 * que degrada/rompe la conexion en senal marginal (RSSI ~-75).
 *
 * Flipear a 1 y reflashear SOLO durante una sesion de captura del spike
 * (tareas 0.8-0.10 de sdd/csi-vitals-per-node/tasks). Volver a 0 despues.
 */
#define ENABLE_PHASE_SPIKE_CAPTURE 0

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
 *
 * Fase 0 (csi-vitals-per-node, gate de validacion): ademas de la
 * amplitud, se calcula la fase cruda por subportadora como
 * atan2f(Q, I). Es fase CRUDA (envuelta en [-pi, pi], sin desenvolver
 * ni sanear) — el desenvolvimiento (unwrap) y el ajuste lineal (D1)
 * se hacen en el publicador del spike, no aqui, para no alargar el
 * tiempo de ejecucion dentro del callback de interrupcion CSI.
 */
static void wifi_csi_rx_callback(void *ctx, wifi_csi_info_t *info)
{
    if (info == NULL || info->buf == NULL || info->len == 0) {
        return;
    }

    /*
     * Filtrar por emisor: solo se procesan las tramas del AP asociado.
     *
     * El driver entrega CSI de CUALQUIER trama Wi-Fi recibida (router, laptop,
     * otros nodos, dispositivos vecinos). Cada emisor tiene su propio camino de
     * propagación, así que mezclarlos en una misma serie temporal hace que la
     * varianza mida el cambio de emisor y no el movimiento físico. Medido en
     * campo: sin este filtro la desviación típica por subportadora era ~20% de
     * la media con la zona quieta, suficiente para enterrar por completo la
     * modulación de una respiración.
     *
     * `s_csi_filter_bssid` lo refresca la tarea de cálculo (no se consulta al
     * gestor Wi-Fi aquí: este callback corre por cada trama recibida y debe
     * mantenerse corto).
     */
    if (s_csi_filter_valid && memcmp(info->mac, s_csi_filter_bssid, 6) != 0) {
        return;
    }

    /* Estabilizar la ganancia del receptor (ver gain_lock_process_packet).
     * Se hace tras el filtro por emisor para medir la ganancia del enlace real
     * con el AP, no la de tramas de otros dispositivos. */
    gain_lock_process_packet(info);

    csi_frame_t frame;
    frame.timestamp_ms = esp_timer_get_time() / 1000; /* us → ms */
    frame.rssi = info->rx_ctrl.rssi; /* RSSI crudo del hardware (Req 19.1) */

    /*
     * Extraer amplitudes y fase de subportadora de los datos I/Q crudos.
     * Los datos CSI son pares (I, Q) como int8_t, 2 bytes por subportadora.
     * Procesamos hasta 64 subportadoras o lo que esté disponible.
     */
    int8_t *raw_data = (int8_t *)info->buf;
    int num_available = info->len / 2; /* Pares I/Q disponibles */
    int num_subcarriers = (num_available < CSI_NUM_SUBCARRIERS)
                          ? num_available
                          : CSI_NUM_SUBCARRIERS;

    /* Calcular amplitud (siempre) y fase (solo si ENABLE_PHASE_SPIKE_CAPTURE,
     * ver comentario en la definicion del flag): |H| = sqrt(I² + Q²),
     * fase = atan2(Q, I). atan2f es notablemente mas caro que sqrtf y
     * se ejecuta por cada trama Wi-Fi recibida (no solo las del nodo) —
     * omitirlo por defecto restaura el costo original del callback. */
    for (int i = 0; i < num_subcarriers; i++) {
        float i_val = (float)raw_data[i * 2];
        float q_val = (float)raw_data[i * 2 + 1];
        frame.subcarrier_amplitudes[i] = sqrtf(i_val * i_val + q_val * q_val);
#if ENABLE_PHASE_SPIKE_CAPTURE
        frame.subcarrier_phases[i] = atan2f(q_val, i_val);
#else
        frame.subcarrier_phases[i] = 0.0f;
#endif
    }

    /* Rellenar con ceros si hay menos subportadoras disponibles */
    for (int i = num_subcarriers; i < CSI_NUM_SUBCARRIERS; i++) {
        frame.subcarrier_amplitudes[i] = 0.0f;
        frame.subcarrier_phases[i] = 0.0f;
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
#if CONFIG_SOC_WIFI_HE_SUPPORT
    wifi_csi_config_t csi_config = {
        .enable = true,
        .acquire_csi_legacy = true,
        .acquire_csi_ht20 = true,
        .acquire_csi_ht40 = true,
        .acquire_csi_su = true,
        .acquire_csi_mu = true,
        .acquire_csi_dcm = true,
        .acquire_csi_beamformed = true,
    };
#else
    wifi_csi_config_t csi_config = {
        .lltf_en = true,           /* Long Training Field */
        .htltf_en = true,          /* HT Long Training Field */
        .stbc_htltf2_en = true,    /* STBC HT-LTF2 */
        .ltf_merge_en = true,      /* Fusionar LTFs */
        .channel_filter_en = false,/* No filtrar por canal */
        .manu_scale = false,       /* Escala automática */
        .shift = 0,                /* Sin desplazamiento */
    };
#endif

    esp_err_t err = esp_wifi_set_csi_config(&csi_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_config fallo: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_wifi_set_csi_rx_cb(wifi_csi_rx_callback, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_rx_cb fallo: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_wifi_set_csi(true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi(true) fallo: %s", esp_err_to_name(err));
        return err;
    }

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

        /*
         * Refrescar el BSSID usado para filtrar CSI. Se hace acá y no en el
         * callback de recepción porque ese corre por cada trama Wi-Fi y debe
         * mantenerse corto.
         */
        {
            uint8_t bssid[6];
            if (wifi_manager_get_ap_bssid(bssid)) {
                if (!s_csi_filter_valid || memcmp(bssid, s_csi_filter_bssid, 6) != 0) {
                    memcpy(s_csi_filter_bssid, bssid, sizeof(s_csi_filter_bssid));
                    s_csi_filter_valid = true;
                    ESP_LOGI(TAG, "Filtro CSI fijado al AP %02X:%02X:%02X:%02X:%02X:%02X",
                             bssid[0], bssid[1], bssid[2], bssid[3], bssid[4], bssid[5]);
                }
            } else if (s_csi_filter_valid) {
                s_csi_filter_valid = false;
                ESP_LOGW(TAG, "BSSID no disponible: CSI vuelve a capturarse sin filtrar");
            }
        }

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

/**
 * Tarea de publicación de tramas CSI crudas para pipelines tipo RuView.
 *
 * Publica la última trama CSI recibida por el motor a topic
 * cali/zone/{zone_id}/csi_raw con payload JSON que contiene las 64
 * amplitudes de subportadora. Pensado para alimentar módulos de
 * detección de respiración/ritmo cardíaco, presence y pose en el backend.
 *
 * Frecuencia: 5 Hz (200 ms).
 *
 * Justificación técnica de 5 Hz vs 1 Hz por defecto:
 *   - Respiración humana: 0.1-0.5 Hz (Nyquist 1 Hz → 1 Hz alcanza).
 *   - Ritmo cardíaco:    0.8-2.5 Hz (Nyquist 5 Hz → 5 Hz cubre).
 *   - 1 Hz aliasingearía completamente la señal cardíaca, haciéndola
 *     indistinguible del ruido. 5 Hz está justo en Nyquist para latido
 *     — útil para demodulación con bandpass + envelope, no perfecto.
 *   - Costo de bandwidth: 5 Hz × ~600-800 B = 3-4 KB/s por nodo.
 *     Trivial para el broker local Aedes.
 *   - Aumentable a 10 Hz en fase posterior si se prioriza calidad de
 *     detección cardíaca sobre ahorro de Wi-Fi.
 *
 * Si el broker no está conectado, el publicador descarta la trama
 * (cali_mqtt_publish_payload no almacena en buffer — los raw frames
 * son high-bandwidth y saturarían el buffer circular de 30 readings).
 *
 * Si no hay trama todavía (motor recién arrancado), la tarea continúa
 * sin publicar (csi_engine_get_last_frame devuelve ESP_ERR_NOT_FOUND).
 */
/**
 * Tarea de publicación del spike de fase (Fase 0 — gate de validación
 * csi-vitals-per-node).
 *
 * Diff temporal: SOLO existe para las 3 capturas de hardware (sala
 * vacía, metrónomo 12 BPM, metrónomo 20 BPM) que validan si la fase CSI
 * puede sanearse a un jitter residual aceptable en la banda de
 * respiración. Se revierte junto con el resto del cambio si el
 * veredicto es NO-GO (ver design.md, Fase 0 — Spike).
 *
 * Frecuencia: 10 Hz (100 ms), fija por el diseño del spike — no
 * configurable, no relacionada con csi_tx_rate.
 */
#if ENABLE_PHASE_SPIKE_CAPTURE
static void csi_phase_spike_publish_task(void *pvParameters)
{
    const TickType_t period = pdMS_TO_TICKS(100);  /* 10 Hz */
    ESP_LOGI(TAG, "Tarea de publicacion de spike de fase iniciada (10 Hz, Fase 0)");
    while (1) {
        vTaskDelay(period);
        csi_frame_t frame;
        if (csi_engine_get_last_frame(&frame) == ESP_OK) {
            esp_err_t err = csi_publisher_publish_phase_spike(&frame);
            if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
                ESP_LOGD(TAG, "csi_phase_spike publish: %s", esp_err_to_name(err));
            }
        }
    }
}
#endif /* ENABLE_PHASE_SPIKE_CAPTURE */

static void csi_raw_publish_task(void *pvParameters)
{
    const TickType_t period = pdMS_TO_TICKS(200);  /* 5 Hz */
    ESP_LOGI(TAG, "Tarea de publicacion CSI raw iniciada (5 Hz)");
    while (1) {
        vTaskDelay(period);
        csi_frame_t frame;
        if (csi_engine_get_last_frame(&frame) == ESP_OK) {
            esp_err_t err = csi_publisher_publish_raw_frame(&frame);
            if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
                ESP_LOGD(TAG, "csi_raw publish: %s", esp_err_to_name(err));
            }
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

    /* Paso 1b: Inicializar driver del LED WS2812 (RMT). Se hace
     * inmediatamente despues de NVS Flash y ANTES de cualquier lectura
     * de NVS para que, si la configuracion es invalida,
     * nvs_config_halt_with_blink() pueda usar el LED como senal de error.
     * Es idempotente si el sistema ya tiene otro codigo que lo inicialice. */
    err = ws2812_led_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "WS2812 no disponible (RMT fallo: %s). "
                 "El nodo operara sin indicador LED.",
                 esp_err_to_name(err));
        /* No fatal: el CSI y MQTT siguen funcionando; solo se pierde
         * la senalizacion visual. */
    }

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
    ESP_LOGI(TAG, "  wifi_ssid   : %s", s_node_config.wifi_ssid);
    ESP_LOGI(TAG, "  csi_tx_rate : %d fps", s_node_config.csi_tx_rate);
    ESP_LOGI(TAG, "  window_size : %d muestras", s_node_config.window_size);
    /* NUNCA loguear s_node_config.wifi_password ni mqtt_token (regla 4.3) */

    /* Paso 4: Inicializar Wi-Fi. Detecta modo SoftAP para diagnostico
     * si el SSID es "AP-TEST" (magic value en NVS). Esto permite probar
     * end-to-end sin depender de una red Wi-Fi externa: el ESP32 levanta
     * un AP "cali-node-XXXX", la laptop se conecta al AP, y el CSI se
     * publica al backend en 192.168.4.2 (laptop en el AP). */
    if (strcmp(s_node_config.wifi_ssid, "AP-TEST") == 0) {
        ESP_LOGW(TAG, "=== MODO DIAGNOSTICO SOFTAP ===");
        err = wifi_manager_init_softap();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Error iniciando SoftAP: %s", esp_err_to_name(err));
ESP_LOGE(TAG, "Entrando en modo error (LED 4Hz)...");
        nvs_config_halt_with_blink();
        /* No retorna */
    }
    } else {
        err = wifi_manager_init(s_node_config.wifi_ssid, s_node_config.wifi_password);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Error inicializando gestor Wi-Fi: %s", esp_err_to_name(err));
            ESP_LOGE(TAG, "Entrando en modo error (LED 4Hz)...");
            nvs_config_halt_with_blink();
            /* No retorna */
        }
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
        /* CSI solo funciona en modo STA. En modo SoftAP (diagnostico)
         * no hay recepcion CSI, pero el resto del sistema sigue
         * operativo (AP, MQTT publish si llega a haber IP). No es fatal. */
        ESP_LOGW(TAG, "CSI no disponible en modo actual: %s (continuando sin CSI)",
                 esp_err_to_name(err));
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

    /* Paso 8b: Crear tarea de publicación de tramas CSI crudas (5 Hz)
     * para pipelines estilo RuView. Separada de csi_compute_task porque
     * el período y la ruta de datos son distintos. No es fatal si falla
     * — motion_probability sigue funcionando. */
    BaseType_t raw_task_created = xTaskCreate(
        csi_raw_publish_task,
        "csi_raw_pub",
        4096,           /* Stack size */
        NULL,           /* Parámetros */
        5,              /* Prioridad */
        NULL            /* Handle */
    );
    if (raw_task_created != pdPASS) {
        ESP_LOGW(TAG, "No se pudo crear tarea csi_raw_publish");
        /* No fatal: motion_probability sigue funcionando */
    }

    /* Paso 8c: Crear tarea de publicación del spike de fase (10 Hz),
     * Fase 0 del gate de validación csi-vitals-per-node. Diff temporal:
     * se revierte junto con el resto del cambio si el veredicto de las
     * capturas de hardware es NO-GO. No es fatal si falla — el resto
     * del pipeline (motion_probability, csi_raw) sigue funcionando.
     *
     * Gateada por ENABLE_PHASE_SPIKE_CAPTURE (default 0): fuera de una
     * sesión de captura activa, ni siquiera se crea la tarea — cero
     * costo de CPU/stack cuando no se está validando el spike. */
#if ENABLE_PHASE_SPIKE_CAPTURE
    BaseType_t phase_spike_task_created = xTaskCreate(
        csi_phase_spike_publish_task,
        "csi_phase_spike",
        4096,           /* Stack size */
        NULL,           /* Parámetros */
        5,              /* Prioridad */
        NULL            /* Handle */
    );
    if (phase_spike_task_created != pdPASS) {
        ESP_LOGW(TAG, "No se pudo crear tarea csi_phase_spike_publish");
        /* No fatal: motion_probability y csi_raw siguen funcionando */
    }
#else
    ESP_LOGI(TAG, "csi_phase_spike_publish_task desactivada (ENABLE_PHASE_SPIKE_CAPTURE=0)");
#endif

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

    /* Paso 12: Inicializar módulo OTA (Task 17). Si `ota_url` está vacía en
     * NVS, el módulo opera en modo local-only (no-op silencioso). No es fatal. */
    err = ota_update_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "OTA no disponible: %s (continuando sin actualizaciones remotas)",
                 esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "Módulo OTA inicializado; chequeo periódico cada 60 minutos");
    }

    /* Paso 13: Portal HTTP de aprovisionamiento Wi-Fi. Permite reconfigurar
     * el SSID/password del nodo en campo (sin reflashear por USB) abriendo
     * http://cali-node-XXXX.local/ desde una laptop en la misma red. No es
     * fatal: si falla (puerto 80 ocupado, etc.) el nodo sigue operando. */
    err = wifi_provisioning_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Portal de aprovisionamiento no disponible: %s "
                 "(continuando, no se puede reconfigurar Wi-Fi sin reflash)",
                 esp_err_to_name(err));
    } else {
        ESP_LOGI(TAG, "Portal de aprovisionamiento activo (ver hostname en logs)");
    }

    ESP_LOGI(TAG, "=== CALI CSI Node - Inicialización completa ===");
    ESP_LOGI(TAG, "Transmitiendo CSI a %d fps, ventana de %d muestras",
             s_node_config.csi_tx_rate, s_node_config.window_size);
}
