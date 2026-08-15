#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "csi_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file wifi_manager.h
 * @brief Gestor de conexión Wi-Fi con reconexión exponencial backoff.
 *
 * Maneja la conexión Wi-Fi STA con reconexión automática usando backoff
 * exponencial (inicio 10s, duplicando hasta máximo 60s, intentos indefinidos).
 * Mantiene un buffer circular de 60 lecturas CSI durante desconexión Wi-Fi,
 * separado del buffer MQTT de 30 lecturas.
 *
 * Propiedad 13: El buffer nunca excede WIFI_BUFFER_MAX_READINGS (60) elementos;
 *              la lectura más antigua se descarta primero en overflow.
 * Propiedad 14: Para intento k (k≥1), intervalo = min(10 × 2^(k-1), 60) segundos.
 *
 * Requisitos implementados: 10.1, 10.2
 */

/** Capacidad máxima del buffer circular Wi-Fi (lecturas durante desconexión). */
#define WIFI_BUFFER_MAX_READINGS 60

/** Intervalo inicial de reconexión en segundos. */
#define WIFI_RECONNECT_INITIAL_INTERVAL_S 10

/** Intervalo máximo de reconexión en segundos. */
#define WIFI_RECONNECT_MAX_INTERVAL_S 60

/**
 * Buffer circular de lecturas durante desconexión Wi-Fi.
 *
 * Implementa un buffer FIFO de capacidad fija (60 lecturas). Cuando el buffer
 * está lleno y se inserta una nueva lectura, se descarta la más antigua.
 *
 * Este buffer es independiente del buffer MQTT (30 lecturas en cali_mqtt.c).
 * Se usa para retener lecturas CSI mientras no hay conectividad Wi-Fi,
 * y se vacía (flush) hacia el path de publicación MQTT al reconectar.
 */
typedef struct {
    motion_reading_t readings[WIFI_BUFFER_MAX_READINGS];
    uint16_t count;
    uint16_t head;  /* Índice de la próxima posición de escritura */
} wifi_reading_buffer_t;

/**
 * Insertar una lectura en el buffer circular Wi-Fi.
 *
 * Si el buffer está lleno, descarta la lectura más antigua (head).
 *
 * @param[in,out] buf      Puntero al buffer circular.
 * @param[in]     reading  Lectura a insertar.
 */
void wifi_reading_buffer_push(wifi_reading_buffer_t *buf, const motion_reading_t *reading);

/**
 * Extraer la lectura más antigua del buffer (FIFO — orden cronológico).
 *
 * @param[in,out] buf      Puntero al buffer circular.
 * @param[out]    reading  Puntero donde se copia la lectura extraída.
 * @return true si se extrajo una lectura, false si el buffer estaba vacío.
 */
bool wifi_reading_buffer_pop(wifi_reading_buffer_t *buf, motion_reading_t *reading);

/**
 * Inicializar un buffer circular Wi-Fi a estado vacío.
 *
 * @param[out] buf  Puntero al buffer a inicializar.
 */
void wifi_reading_buffer_init(wifi_reading_buffer_t *buf);

/**
 * Calcular el intervalo de backoff exponencial para un intento dado.
 *
 * Fórmula: min(10 × 2^(attempt-1), 60) segundos.
 * Para attempt=1 → 10s, attempt=2 → 20s, attempt=3 → 40s, attempt≥4 → 60s.
 *
 * @param[in] attempt  Número de intento (1-based, k≥1).
 * @return Intervalo en segundos.
 */
uint32_t wifi_manager_calc_backoff_interval(uint32_t attempt);

/**
 * Inicializar el gestor Wi-Fi.
 *
 * Configura Wi-Fi en modo STA, registra handlers de evento, inicia la
 * conexión, y prepara el timer de reconexión con backoff exponencial.
 *
 * Reemplaza la inicialización Wi-Fi directa en main.c.
 *
 * @param[in] ssid      SSID de la red a la que conectarse (obligatorio,
 *                       no puede ser NULL ni cadena vacía).
 * @param[in] password  Password WPA2-PSK de la red. Cadena vacía es válida
 *                       y representa una red abierta (hotspot de campo sin
 *                       password), no un error.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si ssid es NULL o vacío,
 *         ESP_FAIL en otro error de inicialización.
 */
esp_err_t wifi_manager_init(const char *ssid, const char *password);

/**
 * Inicializa el modo SoftAP del ESP32 para diagnostico en campo.
 *
 * Crea una red Wi-Fi abierta (o WPA2) con SSID derivado de la MAC STA
 * (cali-node-XXXX) y la IP del gateway en 192.168.4.1. El DHCP del AP
 * asigna automaticamente 192.168.4.2 al primer cliente que conecte.
 *
 * Caso de uso: cuando el operador quiere configurar el nodo en una
 * laptop/celular pero no hay red Wi-Fi compartida disponible. La
 * laptop se conecta al AP del nodo, abre http://192.168.4.1/ en el
 * navegador, y configura credenciales Wi-Fi via el portal (que escucha
 * en 0.0.0.0:80 y es accesible desde el AP).
 *
 * En este modo:
 *  - STA esta deshabilitado (no intenta reconectar a redes externas)
 *  - wifi_manager_is_connected() retorna siempre true (el AP esta activo
 *    una vez que se inicia)
 *  - wifi_manager_wait_for_connection() retorna true inmediatamente
 *  - El cliente MQTT intenta publicar a mqtt_host de NVS, que en este
 *    modo debe ser la IP del cliente que se conecta al AP (tipicamente
 *    192.168.4.2)
 *
 * @return ESP_OK si el AP arranco correctamente, codigo de error de
 *         esp_wifi/esp_netif en caso contrario.
 */
esp_err_t wifi_manager_init_softap(void);

/**
 * Verificar si Wi-Fi está conectado.
 *
 * @return true si la conexión Wi-Fi está activa (IP obtenida).
 */
bool wifi_manager_is_connected(void);

/**
 * Obtener el BSSID (MAC) del punto de acceso al que está asociado el nodo.
 *
 * Se usa para filtrar las tramas CSI y quedarse solo con las del AP. Sin ese
 * filtro, el CSI se captura de CUALQUIER emisor Wi-Fi cercano (router, laptop,
 * otros nodos), y cada emisor tiene un camino de propagación distinto: la
 * serie temporal mezcla canales sin relación entre sí y su varianza refleja el
 * cambio de emisor, no el movimiento físico que se quiere detectar.
 *
 * @param[out] out_bssid  Buffer de 6 bytes donde se copia el BSSID.
 * @return true si hay un BSSID válido (modo STA asociado), false en caso
 *         contrario (sin asociar, o en modo SoftAP donde no aplica).
 */
bool wifi_manager_get_ap_bssid(uint8_t out_bssid[6]);

/**
 * Esperar (bloqueante, con timeout) hasta que Wi-Fi obtenga IP.
 *
 * Usado por main.c antes de intentar la resolución mDNS del backend
 * (Feature A): mDNS necesita el netif de estación con IP asignada para
 * poder enviar consultas multicast. No bloquea indefinidamente — si la
 * conexión no se establece dentro del timeout, retorna false y el
 * llamante debe usar directamente el fallback (mqtt_broker_host de NVS)
 * sin intentar mDNS.
 *
 * @param[in] timeout_ms  Tiempo máximo de espera en milisegundos.
 * @return true si Wi-Fi ya está (o quedó) conectado dentro del timeout,
 *         false si expiró el tiempo de espera sin conexión.
 */
bool wifi_manager_wait_for_connection(uint32_t timeout_ms);

/**
 * Almacenar una lectura en el buffer Wi-Fi.
 *
 * Llamar cuando Wi-Fi está desconectado y se tiene una lectura CSI
 * que no puede ser publicada. Las lecturas se retienen hasta reconexión.
 *
 * @param[in] reading  Lectura a almacenar.
 * @return ESP_OK si se almacenó, ESP_ERR_INVALID_ARG si reading es NULL.
 */
esp_err_t wifi_manager_buffer_reading(const motion_reading_t *reading);

/**
 * Obtener el número de lecturas actualmente en el buffer Wi-Fi.
 *
 * @return Cantidad de lecturas almacenadas.
 */
uint16_t wifi_manager_get_buffer_count(void);

/**
 * Obtener el número de intento de reconexión actual.
 *
 * @return Número de intento (0 si conectado).
 */
uint32_t wifi_manager_get_reconnect_attempt(void);

/**
 * Detener el gestor Wi-Fi y liberar recursos.
 */
void wifi_manager_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* WIFI_MANAGER_H */
