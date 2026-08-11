#ifndef LED_INDICATOR_H
#define LED_INDICATOR_H

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file led_indicator.h
 * @brief Indicador LED con histéresis para detección de movimiento.
 *
 * Implementa una máquina de estados con histéresis:
 * - Activa el LED cuando motion_probability > 0.6 durante 3 lecturas consecutivas.
 * - Desactiva el LED cuando motion_probability < 0.4 durante 3 lecturas consecutivas.
 * - No cambia de estado ante cualquier otro patrón de entrada.
 *
 * Requisito implementado: 9.3
 */

/** Umbral superior para activación del LED. */
#define LED_THRESHOLD_HIGH  0.6f

/** Umbral inferior para desactivación del LED. */
#define LED_THRESHOLD_LOW   0.4f

/** Lecturas consecutivas requeridas para cambio de estado. */
#define LED_HYSTERESIS_COUNT 3

/**
 * Inicializar el indicador LED.
 *
 * Configura el GPIO del LED como salida y lo deja apagado.
 * Usa CONFIG_LED_GPIO definido en nvs_config.h.
 *
 * @return ESP_OK en éxito, ESP_FAIL si la configuración GPIO falla.
 */
esp_err_t led_indicator_init(void);

/**
 * Actualizar el estado del LED según una nueva lectura de motion_probability.
 *
 * Aplica la lógica de histéresis:
 * - Si motion_probability > 0.6 durante 3 lecturas consecutivas: LED ON.
 * - Si motion_probability < 0.4 durante 3 lecturas consecutivas: LED OFF.
 * - Cualquier otro valor no cambia el estado del LED.
 *
 * @param[in] motion_probability  Valor de probabilidad de movimiento [0.0, 1.0].
 */
void led_indicator_update(float motion_probability);

/**
 * Obtener el estado actual del LED.
 *
 * @return true si el LED está encendido, false si está apagado.
 */
bool led_indicator_is_active(void);

/**
 * Apagar el LED y reiniciar contadores de histéresis.
 */
void led_indicator_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* LED_INDICATOR_H */
