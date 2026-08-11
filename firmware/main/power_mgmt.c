/**
 * @file power_mgmt.c
 * @brief Implementación de gestión de energía para nodo CALI CSI.
 *
 * Configura light-sleep automático del ESP32-C6 entre ciclos de medición
 * CSI. El objetivo es mantener un consumo promedio <80mA sobre una
 * ventana de 60 segundos.
 *
 * Estrategia:
 * - El ciclo de cálculo CSI ejecuta cada 2 segundos (~50ms activo).
 * - Entre ciclos, el CPU baja a frecuencia mínima y entra en light-sleep.
 * - Wi-Fi permanece conectado (light-sleep mantiene la asociación AP).
 * - Los timers y callbacks de CSI despiertan al procesador automáticamente.
 *
 * Requisito implementado: 9.4
 */

#include "power_mgmt.h"

#include <stdbool.h>
#include "esp_pm.h"
#include "esp_log.h"
#include "esp_wifi.h"

static const char *TAG = "power_mgmt";

/** Estado del módulo de gestión de energía. */
static bool s_pm_active = false;

esp_err_t power_mgmt_init(void)
{
    /*
     * Configurar Power Management del ESP32-C6.
     *
     * - max_freq_mhz = 160: frecuencia máxima durante trabajo activo (CSI compute).
     * - min_freq_mhz = 10: frecuencia mínima cuando idle (ahorro de energía).
     * - light_sleep_enable = true: permite al sistema entrar en light-sleep
     *   automáticamente cuando todas las tareas están en espera (vTaskDelay).
     *
     * En light-sleep el ESP32-C6 consume ~1-5mA vs ~80-120mA activo.
     * El duty cycle de 2s (activo ~100ms, sleep ~1900ms) resulta en un
     * promedio bien por debajo de los 80mA requeridos.
     */
    esp_pm_config_t pm_config = {
        .max_freq_mhz = 160,
        .min_freq_mhz = 10,
        .light_sleep_enable = true,
    };

    esp_err_t err = esp_pm_configure(&pm_config);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "No se pudo configurar Power Management: %s",
                 esp_err_to_name(err));
        ESP_LOGW(TAG, "El sistema operará sin light-sleep (consumo mayor)");
        /*
         * No es error fatal: el nodo puede operar sin PM, solo consumirá
         * más energía. Esto puede pasar si CONFIG_PM_ENABLE no está
         * habilitado en sdkconfig.
         */
        return err;
    }

    /*
     * Configurar Wi-Fi para modo de ahorro de energía (modem sleep).
     * En este modo, Wi-Fi apaga el módem entre beacons del AP,
     * reduciendo consumo sin perder la asociación.
     */
    err = esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "No se pudo activar Wi-Fi modem sleep: %s",
                 esp_err_to_name(err));
        /* No fatal — solo implica mayor consumo Wi-Fi */
    } else {
        ESP_LOGI(TAG, "Wi-Fi modem sleep activado (MIN_MODEM)");
    }

    s_pm_active = true;
    ESP_LOGI(TAG, "Power Management configurado: max=%dMHz, min=%dMHz, light_sleep=ON",
             pm_config.max_freq_mhz, pm_config.min_freq_mhz);
    ESP_LOGI(TAG, "Consumo estimado: <80mA promedio en ventana de 60s");

    return ESP_OK;
}

bool power_mgmt_is_active(void)
{
    return s_pm_active;
}
