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
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"

static const char *TAG = "csi_tx";

/** Handle del timer periódico de transmisión. */
static esp_timer_handle_t s_tx_timer = NULL;

/** Estado activo del transmisor. */
static bool s_active = false;

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
     *   - ifx: WIFI_IF_STA (interfaz Station)
     *   - buffer: trama a transmitir
     *   - len: tamaño de la trama
     *   - en_sys_seq: true para que el driver asigne número de secuencia
     */
    esp_err_t err = esp_wifi_80211_tx(WIFI_IF_STA,
                                       s_null_data_frame,
                                       sizeof(s_null_data_frame),
                                       true);
    if (err != ESP_OK) {
        /* No saturar logs en caso de error transitorio */
        ESP_LOGD(TAG, "Error transmitiendo trama CSI: %s", esp_err_to_name(err));
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

    /* Calcular período en microsegundos: 1,000,000 / fps */
    uint64_t period_us = 1000000ULL / config->tx_rate_fps;

    ESP_LOGI(TAG, "Iniciando transmisor CSI: %d fps (período=%llu µs)",
             config->tx_rate_fps, (unsigned long long)period_us);

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
