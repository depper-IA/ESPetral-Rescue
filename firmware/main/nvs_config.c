/**
 * @file nvs_config.c
 * @brief Lector de configuración NVS y validación de arranque para nodo CALI.
 *
 * Lee los parámetros de configuración almacenados en NVS (Non-Volatile Storage)
 * y valida que los campos obligatorios estén presentes. Si la configuración es
 * inválida o está ausente, el nodo entra en modo error con parpadeo LED a 4Hz.
 *
 * Requisitos implementados: 9.5, 9.7
 */

#include "nvs_config.h"

#include <string.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_mac.h"

static const char *TAG = "nvs_config";

/**
 * Período de parpadeo para estado de error: 125ms ON / 125ms OFF = 4Hz.
 */
#define BLINK_PERIOD_MS 125

/**
 * Genera un node_id a partir de la dirección MAC del dispositivo.
 * Formato: "node_XXXXXXXXXXXX" (12 caracteres hexadecimales).
 */
static void generate_node_id_from_mac(char *node_id, size_t max_len)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(node_id, max_len, "node_%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

esp_err_t nvs_config_read(node_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Inicializar estructura con valores por defecto */
    memset(config, 0, sizeof(node_config_t));
    config->mqtt_broker_port = DEFAULT_MQTT_PORT;
    config->csi_tx_rate = DEFAULT_CSI_TX_RATE;
    config->window_size = DEFAULT_WINDOW_SIZE;

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error abriendo NVS namespace '%s': %s",
                 NVS_NAMESPACE, esp_err_to_name(err));
        return ESP_ERR_NOT_FOUND;
    }

    size_t len;

    /* --- Campos obligatorios --- */

    /* zone_id (requerido) */
    len = sizeof(config->zone_id);
    err = nvs_get_str(handle, "zone_id", config->zone_id, &len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Clave 'zone_id' no encontrada en NVS: %s",
                 esp_err_to_name(err));
        nvs_close(handle);
        return ESP_ERR_NOT_FOUND;
    }

    /* mqtt_host (requerido) */
    len = sizeof(config->mqtt_broker_host);
    err = nvs_get_str(handle, "mqtt_host", config->mqtt_broker_host, &len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Clave 'mqtt_host' no encontrada en NVS: %s",
                 esp_err_to_name(err));
        nvs_close(handle);
        return ESP_ERR_NOT_FOUND;
    }

    /* mqtt_token (requerido - token de autenticación pre-compartido) */
    len = sizeof(config->mqtt_token);
    err = nvs_get_str(handle, "mqtt_token", config->mqtt_token, &len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Clave 'mqtt_token' no encontrada en NVS: %s",
                 esp_err_to_name(err));
        nvs_close(handle);
        return ESP_ERR_NOT_FOUND;
    }

    /* --- Campos opcionales (usan valores por defecto si ausentes) --- */

    /* mqtt_port (opcional, default 8883) */
    uint16_t port_val = 0;
    err = nvs_get_u16(handle, "mqtt_port", &port_val);
    if (err == ESP_OK) {
        config->mqtt_broker_port = port_val;
    } else {
        ESP_LOGI(TAG, "Usando puerto MQTT por defecto: %d", DEFAULT_MQTT_PORT);
    }

    /* tx_rate (opcional, default 20 fps) */
    uint8_t tx_rate_val = 0;
    err = nvs_get_u8(handle, "tx_rate", &tx_rate_val);
    if (err == ESP_OK) {
        config->csi_tx_rate = tx_rate_val;
    } else {
        ESP_LOGI(TAG, "Usando tasa CSI TX por defecto: %d fps", DEFAULT_CSI_TX_RATE);
    }

    /* window_sz (opcional, default 40 muestras) */
    uint16_t window_val = 0;
    err = nvs_get_u16(handle, "window_sz", &window_val);
    if (err == ESP_OK) {
        config->window_size = window_val;
    } else {
        ESP_LOGI(TAG, "Usando tamaño de ventana por defecto: %d muestras",
                 DEFAULT_WINDOW_SIZE);
    }

    /* node_id (opcional, se genera desde MAC si ausente) */
    len = sizeof(config->node_id);
    err = nvs_get_str(handle, "node_id", config->node_id, &len);
    if (err != ESP_OK || strlen(config->node_id) == 0) {
        generate_node_id_from_mac(config->node_id, sizeof(config->node_id));
        ESP_LOGI(TAG, "node_id generado desde MAC: %s", config->node_id);
    }

    nvs_close(handle);
    return ESP_OK;
}

bool nvs_config_validate(const node_config_t *config)
{
    if (config == NULL) {
        ESP_LOGE(TAG, "Puntero de configuración nulo");
        return false;
    }

    /* zone_id no puede estar vacío */
    if (strlen(config->zone_id) == 0) {
        ESP_LOGE(TAG, "Validación fallida: zone_id está vacío");
        return false;
    }

    /* mqtt_broker_host no puede estar vacío */
    if (strlen(config->mqtt_broker_host) == 0) {
        ESP_LOGE(TAG, "Validación fallida: mqtt_broker_host está vacío");
        return false;
    }

    /* mqtt_token no puede estar vacío */
    if (strlen(config->mqtt_token) == 0) {
        ESP_LOGE(TAG, "Validación fallida: mqtt_token está vacío");
        return false;
    }

    /* csi_tx_rate debe ser razonable (1-100 fps) */
    if (config->csi_tx_rate == 0 || config->csi_tx_rate > 100) {
        ESP_LOGE(TAG, "Validación fallida: csi_tx_rate=%d fuera de rango [1,100]",
                 config->csi_tx_rate);
        return false;
    }

    /* window_size debe ser al menos 2 muestras */
    if (config->window_size < 2) {
        ESP_LOGE(TAG, "Validación fallida: window_size=%d debe ser >= 2",
                 config->window_size);
        return false;
    }

    ESP_LOGI(TAG, "Configuración válida - zona: '%s', broker: '%s:%d'",
             config->zone_id, config->mqtt_broker_host, config->mqtt_broker_port);
    return true;
}

void nvs_config_halt_with_blink(void)
{
    ESP_LOGE(TAG, "*** MODO ERROR: Configuración NVS inválida o ausente ***");
    ESP_LOGE(TAG, "*** El nodo permanecerá en parpadeo LED 4Hz hasta provisionar ***");

    /* Configurar GPIO del LED como salida */
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << CONFIG_LED_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);

    /* Parpadeo infinito a 4Hz (125ms ON, 125ms OFF) */
    bool led_state = false;
    while (1) {
        led_state = !led_state;
        gpio_set_level(CONFIG_LED_GPIO, led_state ? 1 : 0);
        vTaskDelay(pdMS_TO_TICKS(BLINK_PERIOD_MS));
    }
}
