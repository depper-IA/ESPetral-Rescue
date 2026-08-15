#ifndef POWER_MGMT_H
#define POWER_MGMT_H

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file power_mgmt.h
 * @brief Gestión de energía para el nodo CALI CSI (S3 / C6 / C3).
 *
 * DECISIÓN DE INGENIERÍA: este módulo prioriza deliberadamente la
 * fiabilidad de captura CSI sobre el ahorro de batería. El radio Wi-Fi
 * permanece siempre activo (WIFI_PS_NONE) y el light-sleep del SoC está
 * deshabilitado, porque ambos mecanismos de ahorro de energía introducen
 * huecos en la recepción continua de tramas que CSI necesita para
 * llenar su ventana deslizante de detección de movimiento.
 *
 * Esto INVALIDA a propósito el objetivo original de <80mA promedio del
 * Req 9.4. Ver el docstring completo en power_mgmt.c para la
 * justificación técnica y el rango de consumo estimado (no medido en
 * hardware real). La planificación de baterías de campo debe
 * recalcularse en consecuencia.
 *
 * Requisito implementado: 9.4 (objetivo de consumo invalidado a propósito)
 */

/**
 * Inicializar la gestión de energía.
 *
 * Configura esp_pm (Power Management) SIN light-sleep, y el radio Wi-Fi
 * en WIFI_PS_NONE (siempre activo). Solo se conserva el escalado
 * dinámico de frecuencia de CPU (DFS) como mecanismo de ahorro, ya que
 * no afecta la recepción continua de tramas CSI.
 *
 * Frecuencias configuradas:
 * - max_freq_mhz: 160 (activo durante cálculo CSI)
 * - min_freq_mhz: 80  (idle; no baja más porque no hay light-sleep que
 *   lo justifique, y frecuencias muy bajas degradan la latencia de
 *   atención de interrupciones del driver Wi-Fi)
 * - light_sleep_enable: false
 *
 * @return ESP_OK en éxito, código de error si la configuración falla.
 */
esp_err_t power_mgmt_init(void);

/**
 * Obtener si la gestión de energía está activa.
 *
 * @return true si power management fue inicializado correctamente.
 */
bool power_mgmt_is_active(void);

#ifdef __cplusplus
}
#endif

#endif /* POWER_MGMT_H */
