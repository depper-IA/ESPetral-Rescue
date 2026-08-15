/**
 * @file power_mgmt.c
 * @brief Implementación de gestión de energía para nodo CALI CSI.
 *
 * DECISIÓN DE INGENIERÍA (deliberada, no un descuido): este módulo
 * PRIORIZA la fiabilidad de detección CSI sobre el ahorro de batería.
 * Un nodo de búsqueda y rescate que pierde detecciones de movimiento
 * para ahorrar energía es un dispositivo fallido — el costo de un falso
 * negativo (no detectar a una persona con vida bajo escombros) es
 * incomparablemente mayor que el costo de cambiar baterías con más
 * frecuencia.
 *
 * (a) Por qué CSI continuo es incompatible con modem sleep / light sleep:
 *     La detección de movimiento por Channel State Information depende de
 *     recibir CADA trama Wi-Fi entrante para extraer sus subportadoras y
 *     alimentar la ventana deslizante de 40 muestras (ver csi_engine.c).
 *     El modem sleep (WIFI_PS_MIN_MODEM) apaga el radio entre beacons del
 *     AP para ahorrar energía — mantiene la ASOCIACIÓN al AP, pero NO
 *     garantiza la recepción de todas las tramas intermedias. El light
 *     sleep del SoC va más lejos: suspende el procesador completo entre
 *     ciclos, dejando huecos temporales en la captura. Ambos mecanismos
 *     asumen una carga de trabajo tolerante a pérdida de paquetes (ej.
 *     telemetría periódica); CSI para detección de vida NO lo es — cada
 *     hueco en la ventana deslizante es una oportunidad perdida de
 *     detectar movimiento real.
 *
 * (b) Prioridad explícita: fiabilidad de detección > consumo de energía.
 *     Por eso este módulo configura WIFI_PS_NONE (radio siempre activo,
 *     escuchando todas las tramas) y deshabilita light-sleep. Se conserva
 *     únicamente el escalado dinámico de frecuencia de CPU (DFS), que
 *     ahorra energía en el dominio de cómputo sin apagar el radio Wi-Fi.
 *
 * (c) Impacto en consumo — el Req 9.4 (<80mA promedio) queda INVALIDADO
 *     a propósito por esta decisión. Estimación TEÓRICA (sin medición en
 *     hardware real — debe validarse con un medidor de corriente en los
 *     3 targets antes de dimensionar baterías de campo):
 *       - Radio Wi-Fi en RX continuo (WIFI_PS_NONE) suele consumir del
 *         orden de 80-120mA de forma sostenida en los 3 chips (vs. picos
 *         de ~120-180mA en TX y <5mA en modem sleep profundo).
 *       - Sumado al cómputo CSI y periféricos, el consumo promedio
 *         esperado sube a un rango aproximado de 90-150mA, es decir,
 *         puede superar el objetivo original de <80mA en 15-90%.
 *       - Esta cifra NO fue medida en hardware — es una estimación de
 *         ingeniería basada en datasheets típicos de radios Wi-Fi 802.11
 *         en modo RX activo. Debe reemplazarse por medición real antes
 *         de comprometerse con cualquier cifra de autonomía en campo.
 *
 * (d) Consecuencia operativa: la planificación de baterías del sistema
 *     DEBE recalcularse asumiendo el rango estimado en (c), no el
 *     objetivo original de <80mA. Quien dimensione baterías para
 *     despliegue de campo debe medir consumo real en hardware antes de
 *     comprometerse con una autonomía específica.
 *
 * Requisito implementado: 9.4 (objetivo de <80mA INVALIDADO a propósito
 * — ver justificación arriba. La fiabilidad de detección gana.)
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
     * Configurar Power Management (target-agnostic: ESP32-S3 / ESP32-C6 / ESP32-C3).
     *
     * - max_freq_mhz = 160: frecuencia máxima durante trabajo activo (CSI compute).
     * - min_freq_mhz = 80: frecuencia mínima cuando idle. Se sube de 10 a 80
     *   porque light_sleep_enable ahora es false — sin light-sleep, correr
     *   a 10MHz solo perjudica la latencia de atención de interrupciones
     *   del driver Wi-Fi (crítico para no perder tramas CSI) sin ahorrar
     *   energía relevante, ya que el radio en WIFI_PS_NONE domina el
     *   consumo total del sistema de todas formas.
     * - light_sleep_enable = false: DESHABILITADO a propósito. El light
     *   sleep suspende el procesador entre ciclos, lo cual introduce
     *   huecos en la captura CSI continua. Ver docstring del archivo
     *   para la justificación completa de esta decisión de ingeniería.
     *
     * Lo que SÍ se conserva del ahorro de energía original: el escalado
     * dinámico de frecuencia (DFS) entre 80 y 160MHz. Esto reduce consumo
     * de cómputo sin tocar el radio Wi-Fi ni introducir huecos de recepción.
     */
    esp_pm_config_t pm_config = {
        .max_freq_mhz = 160,
        .min_freq_mhz = 80,
        .light_sleep_enable = false,
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
     * Configurar Wi-Fi con el radio SIEMPRE activo (sin power save).
     *
     * WIFI_PS_NONE mantiene el radio escuchando todas las tramas
     * entrantes, sin apagarse entre beacons. Esto es un requisito
     * funcional para CSI continuo, no una opción de tuning: con
     * WIFI_PS_MIN_MODEM el radio se apaga entre beacons del AP y se
     * pierden tramas dentro de la ventana deslizante de detección.
     */
    err = esp_wifi_set_ps(WIFI_PS_NONE);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "No se pudo desactivar Wi-Fi power save: %s",
                 esp_err_to_name(err));
        ESP_LOGW(TAG, "Riesgo: el radio puede entrar en power save por default, "
                 "introduciendo huecos en la captura CSI");
    } else {
        ESP_LOGI(TAG, "Wi-Fi power save DESACTIVADO (WIFI_PS_NONE) — radio siempre activo");
    }

    s_pm_active = true;
    ESP_LOGI(TAG, "Power Management configurado: max=%dMHz, min=%dMHz, light_sleep=OFF",
             pm_config.max_freq_mhz, pm_config.min_freq_mhz);
    ESP_LOGW(TAG, "Consumo estimado 90-150mA promedio (INVALIDA el objetivo <80mA "
             "del Req 9.4 a propósito) — fiabilidad de detección CSI prioriza sobre "
             "ahorro de batería. Estimación teórica sin medir en hardware; "
             "recalcular planificación de baterías con medición real.");

    return ESP_OK;
}

bool power_mgmt_is_active(void)
{
    return s_pm_active;
}
