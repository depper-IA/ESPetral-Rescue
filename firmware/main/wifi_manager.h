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
 * @return ESP_OK en éxito, ESP_FAIL en error.
 */
esp_err_t wifi_manager_init(void);

/**
 * Verificar si Wi-Fi está conectado.
 *
 * @return true si la conexión Wi-Fi está activa (IP obtenida).
 */
bool wifi_manager_is_connected(void);

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
