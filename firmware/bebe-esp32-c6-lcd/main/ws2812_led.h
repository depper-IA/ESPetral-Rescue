/**
 * @file ws2812_led.h
 * @brief Driver para el LED onboard WS2812 (RGB direccionable) del nodo CALI.
 *
 * Contexto:
 *   El LED onboard de la placa ESP32-S3 Zero / Super Mini (GPIO 21,
 *   definido en sdkconfig.defaults.esp32s3 como CONFIG_CALI_LED_GPIO)
 *   NO es un LED digital simple: es un WS2812 que requiere protocolo
 *   serie a 800 kHz con tramas de 24 bits en orden GRB (no RGB).
 *   Tratarlo con gpio_set_level() deja el LED en un color arbitrario
 *   (típicamente rojo fijo) que no representa estado real del firmware.
 *
 *   Esta abstraccion envia tramas WS2812 via el periferico RMT del
 *   ESP32 (driver esp_driver_rmt). Tres operaciones publicas:
 *     - ws2812_led_init()    : toma el control de CONFIG_CALI_LED_GPIO.
 *     - ws2812_led_set_rgb() : fija color (persiste hasta el proximo cambio).
 *     - ws2812_led_off()     : equivalente a set_rgb(0,0,0).
 *
 *   El WS2812 es sample-and-hold: la trama se envia solo cuando el color
 *   cambia; entre cambios el LED mantiene el ultimo color recibido.
 *
 * Requisitos relacionados:
 *   9.3 (indicador de movimiento con histeresis, via led_indicator.c)
 *   9.7 (parpadeo 4 Hz en modo error NVS, via nvs_config.c)
 */

#ifndef WS2812_LED_H
#define WS2812_LED_H

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Inicializa el driver RMT y toma control del GPIO del LED WS2812
 * (simbolo Kconfig CONFIG_CALI_LED_GPIO, default 21 en ESP32-S3 Zero/Super Mini,
 * default 8 en C3/C6 Super Mini).
 *
 * Tras esta llamada las funciones ws2812_led_set_rgb() y ws2812_led_off()
 * son usables. El LED arranca apagado (negro, RGB 0,0,0).
 *
 * Es idempotente: llamarla dos veces es seguro y devuelve ESP_OK.
 *
 * @return ESP_OK en exito, ESP_FAIL si falla la asignacion del canal RMT
 *         o del encoder, u otro codigo del driver RMT/encoder.
 */
esp_err_t ws2812_led_init(void);

/**
 * Fija el color del LED WS2812. Persiste hasta el proximo cambio
 * (no es PWM continuo; la trama solo se transmite si el color difiere
 * del actual — cache interna).
 *
 * @param r  Componente rojo   [0, 255].
 * @param g  Componente verde  [0, 255].
 * @param b  Componente azul   [0, 255].
 * @return ESP_OK en exito, ESP_ERR_INVALID_STATE si el modulo no fue
 *         inicializado, u otro codigo del driver RMT.
 */
esp_err_t ws2812_led_set_rgb(uint8_t r, uint8_t g, uint8_t b);

/**
 * Apaga el LED (negro). Equivalente a ws2812_led_set_rgb(0, 0, 0).
 *
 * @return ver ws2812_led_set_rgb().
 */
esp_err_t ws2812_led_off(void);

#ifdef __cplusplus
}
#endif

#endif /* WS2812_LED_H */
