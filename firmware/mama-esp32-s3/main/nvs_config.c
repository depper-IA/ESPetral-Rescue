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
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_mac.h"
#include "ws2812_led.h"

static const char *TAG = "nvs_config";

/**
 * Período de parpadeo para estado de error: 125ms ON / 125ms OFF = 4Hz.
 */
#define BLINK_PERIOD_MS 125

/* --- Caché interna para claves opcionales de OTA --- */
#define OTA_URL_MAX_LEN     129   /* 128 chars + null */
#define FW_VERSION_MAX_LEN  33    /* 32 chars + null */

static char s_ota_url[OTA_URL_MAX_LEN] = {0};
static char s_fw_version[FW_VERSION_MAX_LEN] = {0};

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

    /* wifi_ssid (requerido - sin esto el nodo nunca puede conectarse) */
    len = sizeof(config->wifi_ssid);
    err = nvs_get_str(handle, "wifi_ssid", config->wifi_ssid, &len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Clave 'wifi_ssid' no encontrada en NVS: %s",
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

    /* wifi_pass (opcional - red abierta sin password es un escenario válido) */
    len = sizeof(config->wifi_password);
    err = nvs_get_str(handle, "wifi_pass", config->wifi_password, &len);
    if (err != ESP_OK) {
        config->wifi_password[0] = '\0';
        ESP_LOGI(TAG, "Sin 'wifi_pass' en NVS: se asume red abierta");
    }

    /* node_id (opcional, se genera desde MAC si ausente) */
    len = sizeof(config->node_id);
    err = nvs_get_str(handle, "node_id", config->node_id, &len);
    if (err != ESP_OK || strlen(config->node_id) == 0) {
        generate_node_id_from_mac(config->node_id, sizeof(config->node_id));
        ESP_LOGI(TAG, "node_id generado desde MAC: %s", config->node_id);
    }

    /* ota_url (opcional, OTA deshabilitada si ausente) */
    len = sizeof(s_ota_url);
    if (nvs_get_str(handle, "ota_url", s_ota_url, &len) != ESP_OK) {
        s_ota_url[0] = '\0';
    }

    /* fw_version (opcional, vacío hasta primer OTA exitoso) */
    len = sizeof(s_fw_version);
    if (nvs_get_str(handle, "fw_version", s_fw_version, &len) != ESP_OK) {
        s_fw_version[0] = '\0';
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

    /* wifi_ssid no puede estar vacío */
    if (strlen(config->wifi_ssid) == 0) {
        ESP_LOGE(TAG, "Validación fallida: wifi_ssid está vacío");
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

const char *nvs_config_get_ota_url(void)
{
    return s_ota_url;
}

const char *nvs_config_get_fw_version(void)
{
    return s_fw_version;
}

esp_err_t nvs_config_set_fw_version(const char *version)
{
    if (version == NULL) return ESP_ERR_INVALID_ARG;
    /* Cache en memoria primero (sobrevive al reinicio si NVS falla). */
    strncpy(s_fw_version, version, sizeof(s_fw_version) - 1);
    s_fw_version[sizeof(s_fw_version) - 1] = '\0';

    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) { ESP_LOGE(TAG, "open NVS rw: %s", esp_err_to_name(err)); return err; }
    err = nvs_set_str(h, "fw_version", s_fw_version);
    if (err != ESP_OK) { ESP_LOGE(TAG, "set fw_version: %s", esp_err_to_name(err)); nvs_close(h); return err; }
    err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) { ESP_LOGE(TAG, "commit fw_version: %s", esp_err_to_name(err)); return err; }
    ESP_LOGI(TAG, "fw_version persistido: %s", s_fw_version);
    return ESP_OK;
}

esp_err_t nvs_config_write_wifi_credentials(const char *ssid, const char *password,
                                             const char *mqtt_host)
{
    if (ssid == NULL || ssid[0] == '\0') {
        ESP_LOGE(TAG, "No se pueden persistir credenciales: SSID vacío");
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error abriendo NVS namespace '%s' en escritura: %s",
                 NVS_NAMESPACE, esp_err_to_name(err));
        return err;
    }

    err = nvs_set_str(handle, "wifi_ssid", ssid);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error escribiendo 'wifi_ssid': %s", esp_err_to_name(err));
        nvs_close(handle);
        return err;
    }

    /* password vacío es válido (red abierta) — se escribe igual */
    err = nvs_set_str(handle, "wifi_pass", (password != NULL) ? password : "");
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error escribiendo 'wifi_pass': %s", esp_err_to_name(err));
        nvs_close(handle);
        return err;
    }

    /* mqtt_host es opcional en el formulario: solo se sobreescribe si vino
     * no vacío. El operador puede dejarlo en blanco y confiar en mDNS. */
    if (mqtt_host != NULL && mqtt_host[0] != '\0') {
        err = nvs_set_str(handle, "mqtt_host", mqtt_host);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Error escribiendo 'mqtt_host': %s", esp_err_to_name(err));
            nvs_close(handle);
            return err;
        }
    }

    err = nvs_commit(handle);
    nvs_close(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error en commit de credenciales Wi-Fi: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "Credenciales Wi-Fi persistidas en NVS (SSID: '%s')", ssid);
    return ESP_OK;
}

void nvs_config_halt_with_blink(void)
{
    ESP_LOGE(TAG, "*** MODO ERROR: Configuración NVS inválida o ausente ***");
    ESP_LOGE(TAG, "*** El nodo permanecerá en parpadeo LED 4Hz hasta provisionar ***");

    /*
     * El GPIO del LED onboard lo maneja ws2812_led (RMT). Esta funcion
     * asume que ws2812_led_init() ya fue llamado desde app_main
     * (justo despues de nvs_flash_init, antes de cualquier lectura NVS
     * — ver main.c), por lo que aqui solo emitimos colores.
     *
     * Si por algun motivo WS2812 no estuviera inicializado (driver
     * RMT fallo en init, etc.), los ws2812_led_* devuelven
     * ESP_ERR_INVALID_STATE; el halt loop sigue bloqueado de todos
     * modos porque la intencion es no continuar al sistema si la
     * NVS es invalida.
     */

    /* Parpadeo infinito a 4Hz (125ms rojo, 125ms apagado).
     * Rojo = senal canonica de "modo error, provisioname". */
    while (1) {
        ws2812_led_set_rgb(255, 0, 0);
        vTaskDelay(pdMS_TO_TICKS(BLINK_PERIOD_MS));
        ws2812_led_off();
        vTaskDelay(pdMS_TO_TICKS(BLINK_PERIOD_MS));
    }
}
