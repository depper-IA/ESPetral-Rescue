#ifndef CSI_ENGINE_H
#define CSI_ENGINE_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file csi_engine.h
 * @brief Motor de procesamiento CSI para detección de movimiento.
 *
 * Implementa la ventana deslizante de amplitudes de subportadora,
 * cálculo de varianza y normalización a motion_probability [0.0, 1.0].
 *
 * Requisitos implementados: 9.1, 9.2
 */

/** Número de subportadoras CSI a procesar. */
#define CSI_NUM_SUBCARRIERS 64

/** Tamaño máximo de la ventana deslizante soportado. */
#define CSI_MAX_WINDOW_SIZE 128

/**
 * Trama CSI con amplitudes de subportadora y marca temporal.
 */
typedef struct {
    float subcarrier_amplitudes[CSI_NUM_SUBCARRIERS];
    int64_t timestamp_ms;
} csi_frame_t;

/**
 * Lectura de movimiento calculada a partir de la ventana deslizante.
 */
typedef struct {
    float motion_probability;  /* 0.0 - 1.0 */
    int64_t timestamp_ms;      /* marca temporal de captura */
    char zone_id[65];
    char node_id[65];
} motion_reading_t;

/**
 * Configuración del motor CSI.
 */
typedef struct {
    uint8_t tx_rate;           /* Tramas por segundo (típicamente 20) */
    uint16_t window_size;      /* Muestras en ventana deslizante (típicamente 40) */
    char zone_id[65];          /* ID de zona desde NVS */
    char node_id[65];          /* ID de nodo desde NVS */
} csi_engine_config_t;

/**
 * Inicializar el motor CSI con la configuración proporcionada.
 *
 * Asigna la memoria para el buffer circular de la ventana deslizante
 * y prepara las estructuras internas.
 *
 * @param[in] config  Configuración del motor CSI.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si config es NULL o inválida.
 */
esp_err_t csi_engine_init(const csi_engine_config_t *config);

/**
 * Alimentar una trama CSI al motor de procesamiento.
 *
 * Agrega las amplitudes de subportadora al buffer circular. Si la ventana
 * está llena, descarta la muestra más antigua.
 *
 * @param[in] frame  Puntero a la trama CSI recibida.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_STATE si el motor no fue inicializado.
 */
esp_err_t csi_engine_feed_frame(const csi_frame_t *frame);

/**
 * Calcular la probabilidad de movimiento actual.
 *
 * Calcula la varianza de cada subportadora sobre la ventana deslizante,
 * promedia las varianzas y normaliza el resultado a [0.0, 1.0].
 *
 * Solo produce un resultado válido cuando la ventana está llena
 * (se han acumulado window_size muestras).
 *
 * @param[out] reading  Puntero donde se almacena la lectura resultante.
 * @return ESP_OK si se calculó exitosamente,
 *         ESP_ERR_NOT_FINISHED si la ventana aún no está llena,
 *         ESP_ERR_INVALID_STATE si el motor no fue inicializado.
 */
esp_err_t csi_engine_compute(motion_reading_t *reading);

/**
 * Verificar si la ventana deslizante está llena.
 *
 * @return true si se han acumulado al menos window_size muestras.
 */
bool csi_engine_window_full(void);

/**
 * Obtener la última lectura de movimiento calculada.
 *
 * @param[out] reading  Puntero donde se copia la última lectura.
 * @return ESP_OK si hay una lectura válida disponible,
 *         ESP_ERR_NOT_FOUND si aún no se ha calculado ninguna.
 */
esp_err_t csi_engine_get_last_reading(motion_reading_t *reading);

/**
 * Liberar recursos del motor CSI.
 */
void csi_engine_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* CSI_ENGINE_H */
