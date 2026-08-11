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

#include "driver/gpio.h"
#include "esp_log.h"

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
    /* Configurar GPIO del LED como salida */
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << CONFIG_LED_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    esp_err_t err = gpio_config(&io_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error configurando GPIO %d para LED: %s",
                 CONFIG_LED_GPIO, esp_err_to_name(err));
        return ESP_FAIL;
    }

    /* LED apagado al inicio */
    gpio_set_level(CONFIG_LED_GPIO, 0);
    s_led_state.led_on = false;
    s_led_state.high_count = 0;
    s_led_state.low_count = 0;
    s_led_state.initialized = true;

    ESP_LOGI(TAG, "Indicador LED inicializado en GPIO %d", CONFIG_LED_GPIO);
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

    /* Activar LED si 3 lecturas consecutivas superan el umbral alto */
    if (s_led_state.high_count >= LED_HYSTERESIS_COUNT && !s_led_state.led_on) {
        gpio_set_level(CONFIG_LED_GPIO, 1);
        s_led_state.led_on = true;
        ESP_LOGI(TAG, "LED ACTIVADO (motion_probability > %.1f x%d consecutivas)",
                 LED_THRESHOLD_HIGH, LED_HYSTERESIS_COUNT);
    }

    /* Desactivar LED si 3 lecturas consecutivas están bajo el umbral bajo */
    if (s_led_state.low_count >= LED_HYSTERESIS_COUNT && s_led_state.led_on) {
        gpio_set_level(CONFIG_LED_GPIO, 0);
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

    gpio_set_level(CONFIG_LED_GPIO, 0);
    s_led_state.led_on = false;
    s_led_state.high_count = 0;
    s_led_state.low_count = 0;

    ESP_LOGI(TAG, "Indicador LED reiniciado");
}
