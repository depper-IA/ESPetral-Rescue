#ifndef POWER_MGMT_H
#define POWER_MGMT_H

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file power_mgmt.h
 * @brief Gestión de energía para el nodo CALI CSI.
 *
 * Configura el ESP32-C6 para entrar en light-sleep entre ciclos de
 * medición CSI, manteniendo un consumo promedio <80mA sobre una
 * ventana de 60 segundos.
 *
 * Requisito implementado: 9.4
 */

/**
 * Inicializar la gestión de energía.
 *
 * Configura esp_pm (Power Management) para permitir light-sleep automático
 * cuando no hay tareas activas. El procesador entra en light-sleep entre
 * ciclos de cálculo CSI (cada 2 segundos).
 *
 * Frecuencias configuradas:
 * - max_freq_mhz: 160 (activo durante cálculo CSI)
 * - min_freq_mhz: 10  (idle, antes de light-sleep)
 * - light_sleep_enable: true
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
