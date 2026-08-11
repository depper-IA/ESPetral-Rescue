#ifndef CSI_TRANSMITTER_H
#define CSI_TRANSMITTER_H

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file csi_transmitter.h
 * @brief Transmisor de tramas CSI ping (null data frames) a tasa configurable.
 *
 * Transmite tramas Wi-Fi que permiten a los receptores CSI obtener
 * información de estado del canal (CSI). Usa esp_timer para mantener
 * la cadencia de transmisión configurada.
 *
 * Requisito implementado: 9.1 (transmisión a 20 fps)
 */

/**
 * Configuración del transmisor CSI.
 */
typedef struct {
    uint8_t tx_rate_fps;  /* Tramas por segundo (default: 20) */
} csi_transmitter_config_t;

/**
 * Inicializar y arrancar el transmisor CSI.
 *
 * Configura un timer periódico que transmite null data frames
 * a la tasa especificada. Wi-Fi debe estar inicializado y conectado
 * (o al menos en modo STA) antes de llamar esta función.
 *
 * @param[in] config  Configuración del transmisor.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si config es NULL,
 *         ESP_FAIL si no se pudo crear el timer.
 */
esp_err_t csi_transmitter_start(const csi_transmitter_config_t *config);

/**
 * Detener el transmisor CSI.
 *
 * Detiene y elimina el timer de transmisión periódica.
 */
void csi_transmitter_stop(void);

/**
 * Verificar si el transmisor está activo.
 *
 * @return true si el transmisor está transmitiendo tramas periódicamente.
 */
bool csi_transmitter_is_active(void);

#ifdef __cplusplus
}
#endif

#endif /* CSI_TRANSMITTER_H */
