/**
 * @file csi_transmitter.c
 * @brief Transmisor periódico de tramas CSI ping (null data frames).
 *
 * Transmite tramas Wi-Fi null data a la tasa configurada para que los
 * nodos vecinos (o el propio nodo en modo self-CSI) puedan extraer
 * información de estado del canal y detectar movimiento.
 *
 * Usa esp_timer con callback de alta resolución para garantizar
 * la cadencia de 20 fps (50ms por trama).
 *
 * Requisito implementado: 9.1 (transmisión CSI a 20 fps)
 */

#include "csi_transmitter.h"

#include <string.h>
#include <inttypes.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"

static const char *TAG = "csi_tx";

/** Handle del timer periódico de transmisión. */
static esp_timer_handle_t s_tx_timer = NULL;

/** Estado activo del transmisor. */
static bool s_active = false;

/**
 * Interfaz Wi-Fi usada para transmitir las tramas ping.
 *
 * Se resuelve en csi_transmitter_start() según el modo Wi-Fi activo:
 * WIFI_IF_STA en modo Station, WIFI_IF_AP en modo SoftAP. Fijarla a
 * WIFI_IF_STA de forma incondicional hace que esp_wifi_80211_tx()
 * devuelva ESP_ERR_WIFI_IF en cada disparo del timer cuando el nodo
 * corre como SoftAP: no se transmite ninguna trama, la ventana CSI
 * nunca se llena y el nodo no publica ni una lectura.
 */
static wifi_interface_t s_tx_interface = WIFI_IF_STA;

/** Contador de fallos consecutivos de transmisión (para logging acotado). */
static uint32_t s_tx_error_count = 0;

/**
 * Cada cuántos fallos consecutivos se emite un WARN.
 *
 * A 20 fps un log por fallo saturaría la consola, pero silenciarlos
 * por completo (ESP_LOGD) oculta una falla total del transmisor. Un
 * aviso cada 100 fallos (~5 s a 20 fps) mantiene el diagnóstico
 * visible sin inundar el log.
 */
#define TX_ERROR_LOG_INTERVAL 100

/**
 * Trama null data para transmisión CSI.
 *
 * Una trama 802.11 null data mínima: indica presencia sin payload.
 * Los receptores CSI extraen información del canal de estas tramas.
 *
 * Estructura: Frame Control (2) + Duration (2) + Addr1 (6) + Addr2 (6) +
 *             Addr3 (6) + Seq Control (2) = 24 bytes header
 *
 * Se usa broadcast como destino para que todos los nodos en el canal
 * puedan recibir la trama y extraer CSI.
 */
static const uint8_t s_null_data_frame[] = {
    /* Frame Control: Type=Data, Subtype=Null Data (0x0048) */
    0x48, 0x00,
    /* Duration */
    0x00, 0x00,
    /* Addr1: Destination - broadcast */
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    /* Addr2: Source - se sobreescribe con MAC propia por el driver */
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    /* Addr3: BSSID - broadcast */
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    /* Sequence Control */
    0x00, 0x00,
};

/**
 * Callback del timer periódico: transmite una trama null data.
 */
static void tx_timer_callback(void *arg)
{
    /*
     * esp_wifi_80211_tx transmite una trama raw 802.11.
     * Parámetros:
     *   - ifx: interfaz resuelta según el modo Wi-Fi activo (STA o AP)
     *   - buffer: trama a transmitir
     *   - len: tamaño de la trama
     *   - en_sys_seq: true para que el driver asigne número de secuencia
     */
    esp_err_t err = esp_wifi_80211_tx(s_tx_interface,
                                       s_null_data_frame,
                                       sizeof(s_null_data_frame),
                                       true);
    if (err != ESP_OK) {
        /*
         * Loguear de forma acotada: un fallo permanente (p. ej. interfaz
         * incorrecta) debe ser visible en el log de campo, pero a 20 fps
         * no puede emitirse un mensaje por trama.
         */
        if ((s_tx_error_count % TX_ERROR_LOG_INTERVAL) == 0) {
            ESP_LOGW(TAG, "Error transmitiendo trama CSI (%" PRIu32 " fallos): %s",
                     s_tx_error_count + 1, esp_err_to_name(err));
        }
        s_tx_error_count++;
    } else if (s_tx_error_count > 0) {
        ESP_LOGI(TAG, "Transmisión CSI recuperada tras %" PRIu32 " fallos",
                 s_tx_error_count);
        s_tx_error_count = 0;
    }
}

esp_err_t csi_transmitter_start(const csi_transmitter_config_t *config)
{
    if (config == NULL) {
        ESP_LOGE(TAG, "Configuración nula");
        return ESP_ERR_INVALID_ARG;
    }

    if (config->tx_rate_fps == 0) {
        ESP_LOGE(TAG, "tx_rate_fps no puede ser 0");
        return ESP_ERR_INVALID_ARG;
    }

    /* Detener si ya estaba activo */
    if (s_active) {
        csi_transmitter_stop();
    }

    /*
     * Resolver la interfaz de transmisión según el modo Wi-Fi activo.
     * En modo SoftAP la interfaz Station no existe y esp_wifi_80211_tx()
     * rechaza WIFI_IF_STA con ESP_ERR_WIFI_IF. En modo APSTA se prefiere
     * STA, que es la que mantiene el enlace con el router.
     */
    wifi_mode_t mode = WIFI_MODE_NULL;
    esp_err_t mode_err = esp_wifi_get_mode(&mode);
    if (mode_err == ESP_OK && mode == WIFI_MODE_AP) {
        s_tx_interface = WIFI_IF_AP;
    } else {
        s_tx_interface = WIFI_IF_STA;
    }
    s_tx_error_count = 0;

    /* Calcular período en microsegundos: 1,000,000 / fps */
    uint64_t period_us = 1000000ULL / config->tx_rate_fps;

    ESP_LOGI(TAG, "Iniciando transmisor CSI: %d fps (período=%llu µs, interfaz=%s)",
             config->tx_rate_fps, (unsigned long long)period_us,
             (s_tx_interface == WIFI_IF_AP) ? "AP" : "STA");

    /* Crear timer periódico */
    esp_timer_create_args_t timer_args = {
        .callback = tx_timer_callback,
        .arg = NULL,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "csi_tx_timer",
    };

    esp_err_t err = esp_timer_create(&timer_args, &s_tx_timer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error creando timer CSI TX: %s", esp_err_to_name(err));
        return ESP_FAIL;
    }

    /* Iniciar timer periódico */
    err = esp_timer_start_periodic(s_tx_timer, period_us);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error iniciando timer CSI TX: %s", esp_err_to_name(err));
        esp_timer_delete(s_tx_timer);
        s_tx_timer = NULL;
        return ESP_FAIL;
    }

    s_active = true;
    ESP_LOGI(TAG, "Transmisor CSI activo");

    return ESP_OK;
}

void csi_transmitter_stop(void)
{
    if (s_tx_timer != NULL) {
        esp_timer_stop(s_tx_timer);
        esp_timer_delete(s_tx_timer);
        s_tx_timer = NULL;
    }
    s_active = false;
    ESP_LOGI(TAG, "Transmisor CSI detenido");
}

bool csi_transmitter_is_active(void)
{
    return s_active;
}
