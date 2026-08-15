/**
 * @file led_indicator.c
 * @brief Implementación del indicador LED con histéresis.
 *
 * Máquina de estados que activa/desactiva el LED onboard basándose en
 * lecturas consecutivas de motion_probability con umbrales de histéresis.
 *
 * Requisito implementado: 9.3
 */

#include "led_indicator.h"
#include "nvs_config.h"

#include "esp_log.h"
#include "ws2812_led.h"

static const char *TAG = "led_indicator";

/** Estado interno del indicador LED. */
static struct {
    bool led_on;              /* Estado actual del LED */
    uint8_t high_count;       /* Lecturas consecutivas > umbral alto */
    uint8_t low_count;        /* Lecturas consecutivas < umbral bajo */
    bool initialized;         /* Módulo inicializado correctamente */
} s_led_state = {
    .led_on = false,
    .high_count = 0,
    .low_count = 0,
    .initialized = false,
};

esp_err_t led_indicator_init(void)
{
    /*
     * El GPIO del LED onboard lo maneja el driver WS2812 (ver
     * ws2812_led_init() llamado desde app_main antes que este init).
     * Este modulo solo gestiona la maquina de estados de histeresis
     * y emite colores; no toca registros GPIO directamente.
     */

    /* LED apagado al inicio (negro = sin movimiento significativo). */
    esp_err_t err = ws2812_led_off();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "ws2812_led_off() fallo: %s", esp_err_to_name(err));
        return ESP_FAIL;
    }

    s_led_state.led_on = false;
    s_led_state.high_count = 0;
    s_led_state.low_count = 0;
    s_led_state.initialized = true;

    ESP_LOGI(TAG, "Indicador LED inicializado (WS2812 en GPIO %d)",
             CONFIG_CALI_LED_GPIO);
    return ESP_OK;
}

void led_indicator_update(float motion_probability)
{
    if (!s_led_state.initialized) {
        return;
    }

    /*
     * Lógica de histéresis:
     *
     * - Si la lectura excede el umbral alto (>0.6), incrementar contador alto
     *   y reiniciar contador bajo.
     * - Si la lectura está por debajo del umbral bajo (<0.4), incrementar
     *   contador bajo y reiniciar contador alto.
     * - Si la lectura está en la zona muerta [0.4, 0.6], reiniciar ambos
     *   contadores (no se produce cambio de estado).
     */
    if (motion_probability > LED_THRESHOLD_HIGH) {
        s_led_state.high_count++;
        s_led_state.low_count = 0;
    } else if (motion_probability < LED_THRESHOLD_LOW) {
        s_led_state.low_count++;
        s_led_state.high_count = 0;
    } else {
        /* Zona muerta: reiniciar ambos contadores */
        s_led_state.high_count = 0;
        s_led_state.low_count = 0;
    }

    /* Activar LED si 3 lecturas consecutivas superan el umbral alto.
     * Color = verde puro (0, 255, 0): señal de "movimiento detectado,
     * nodo vivo y detectando". */
    if (s_led_state.high_count >= LED_HYSTERESIS_COUNT && !s_led_state.led_on) {
        esp_err_t err = ws2812_led_set_rgb(0, 255, 0);
        if (err == ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "WS2812 no inicializado; no se enciende el LED");
        } else if (err != ESP_OK) {
            ESP_LOGW(TAG, "ws2812_led_set_rgb fallo: %s", esp_err_to_name(err));
        }
        s_led_state.led_on = true;
        ESP_LOGI(TAG, "LED ACTIVADO (motion_probability > %.1f x%d consecutivas)",
                 LED_THRESHOLD_HIGH, LED_HYSTERESIS_COUNT);
    }

    /* Desactivar LED si 3 lecturas consecutivas están bajo el umbral bajo.
     * Color = negro (0, 0, 0): estado neutro / sin movimiento significativo. */
    if (s_led_state.low_count >= LED_HYSTERESIS_COUNT && s_led_state.led_on) {
        esp_err_t err = ws2812_led_off();
        if (err == ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "WS2812 no inicializado; no se apaga el LED");
        } else if (err != ESP_OK) {
            ESP_LOGW(TAG, "ws2812_led_off fallo: %s", esp_err_to_name(err));
        }
        s_led_state.led_on = false;
        ESP_LOGI(TAG, "LED DESACTIVADO (motion_probability < %.1f x%d consecutivas)",
                 LED_THRESHOLD_LOW, LED_HYSTERESIS_COUNT);
    }

    /* Saturar contadores para evitar overflow en ejecuciones largas */
    if (s_led_state.high_count > LED_HYSTERESIS_COUNT) {
        s_led_state.high_count = LED_HYSTERESIS_COUNT;
    }
    if (s_led_state.low_count > LED_HYSTERESIS_COUNT) {
        s_led_state.low_count = LED_HYSTERESIS_COUNT;
    }
}

bool led_indicator_is_active(void)
{
    return s_led_state.led_on;
}

void led_indicator_reset(void)
{
    if (!s_led_state.initialized) {
        return;
    }

    esp_err_t err = ws2812_led_off();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "ws2812_led_off fallo: %s", esp_err_to_name(err));
    }
    s_led_state.led_on = false;
    s_led_state.high_count = 0;
    s_led_state.low_count = 0;

    ESP_LOGI(TAG, "Indicador LED reiniciado");
}
