#ifndef WIFI_PROVISIONING_H
#define WIFI_PROVISIONING_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file wifi_provisioning.h
 * @brief Portal HTTP de aprovisionamiento Wi-Fi para reconfigurar el nodo
 *        en campo sin reflashear por USB.
 *
 * Caso de uso: la laptop del backend (o el punto de acceso del sitio de
 * rescate) cambia de SSID o de IP. Los nodos ESP32 quedan desconectados
 * porque tienen SSID/password fijos en NVS. En vez de ir placa por placa
 * con un cable USB, el operador abre la pagina de aprovisionamiento del
 * nodo desde su laptop/celular, carga el SSID nuevo y el nodo se reinicia
 * y se une solo a la red nueva.
 *
 * El portal corre como servidor HTTP en puerto 80 sobre la STA existente
 * (no levanta SoftAP propio) y se anuncia por mDNS como
 * `cali-node-XXXX.local` (XXXX = ultimos 4 hex de la MAC STA) para que
 * el operador no tenga que conocer la IP del nodo.
 */

/**
 * Inicializa el portal HTTP de aprovisionamiento.
 *
 * Levanta mDNS, el servidor HTTP en puerto 80 y registra los handlers
 * `GET /`, `POST /provision` y `GET /api/status`. La funcion retorna
 * inmediatamente: el servidor queda corriendo en una tarea interna de
 * FreeRTOS y el resto del firmware continua su flujo normal.
 *
 * Precondicion: debe llamarse DESPUES de `wifi_manager_init()` y de que
 * el netif STA tenga IP asignada (sino `/api/status` reporta `0.0.0.0` y
 * mDNS puede no responder, aunque el servidor HTTP sigue accesible por
 * IP). Si mDNS falla al iniciar, se loguea warning y se retorna `ESP_OK`
 * igual: el portal sigue siendo accesible via IP directa. Si el servidor
 * HTTP falla al iniciar, se loguea error y se retorna `ESP_FAIL`.
 *
 * Idempotencia: llamar dos veces es seguro pero la segunda llamada
 * re-anuncia mDNS y reinicia el servidor HTTP, lo cual es ruido logico
 * innecesario. El caller deberia invocarlo una sola vez al arranque.
 *
 * @return ESP_OK si el servidor HTTP quedo operativo (mDNS puede haber
 *         fallado sin afectar el retorno). ESP_FAIL si el servidor HTTP
 *         no pudo arrancar.
 */
esp_err_t wifi_provisioning_init(void);

#ifdef __cplusplus
}
#endif

#endif /* WIFI_PROVISIONING_H */
