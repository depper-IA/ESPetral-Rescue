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
 *
 * `subcarrier_phases` (Fase 0 — csi-vitals-per-node) contiene la fase
 * cruda en radianes por subportadora, calculada como atan2f(Q, I) en el
 * callback de recepcion CSI. NO esta desenvuelta (unwrapped) ni
 * saneada: eso lo hace el publicador del spike de fase bajo demanda,
 * para no cargar el callback de interrupcion con trabajo extra.
 *
 * Advertencia de RAM: agregar este arreglo crece csi_frame_t de 264 a
 * 520 bytes. La copia completa en csi_engine_feed_frame() ocurre dentro
 * del callback CSI — ver pregunta abierta en el diseno sobre medir el
 * impacto en duracion del callback antes de la Fase 1.
 */
typedef struct {
    float subcarrier_amplitudes[CSI_NUM_SUBCARRIERS];
    float subcarrier_phases[CSI_NUM_SUBCARRIERS];
    int64_t timestamp_ms;
    int8_t rssi;  /* RSSI crudo del hardware (info->rx_ctrl.rssi), dBm */
} csi_frame_t;

/**
 * Lectura de movimiento calculada a partir de la ventana deslizante.
 */
typedef struct {
    float motion_probability;  /* 0.0 - 1.0 */
    int64_t timestamp_ms;      /* marca temporal de captura */
    char zone_id[65];
    char node_id[65];
    int8_t rssi;                /* RSSI crudo de la ultima trama, dBm (Req 19.1) */
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
 * Obtener el zone_id configurado en el motor CSI.
 *
 * Útil para publicadores que operan sobre csi_frame_t (que no incluye
 * zone_id/node_id) y necesitan construir el tópico MQTT.
 *
 * @return Puntero al buffer interno zone_id (no liberar, no modificar).
 *         Devuelve NULL si el motor no está inicializado.
 */
const char *csi_engine_get_zone_id(void);

/**
 * Obtener el node_id configurado en el motor CSI.
 *
 * @return Puntero al buffer interno node_id (no liberar, no modificar).
 *         Devuelve NULL si el motor no está inicializado.
 */
const char *csi_engine_get_node_id(void);

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
 * Obtener la última trama CSI cruda recibida (64 amplitudes + timestamp).
 *
 * Devuelve una COPIA de la última trama que se pasó a
 * csi_engine_feed_frame(). Pensada para alimentar pipelines de análisis
 * que necesitan las amplitudes brutas (no la varianza agregada) — por
 * ejemplo, detección de respiración/ritmo cardíaco, presence y pose
 * estimation estilo RuView.
 *
 * Seguridad de hilos: el caller debe asumir que la trama interna puede
 * ser sobreescrita por el callback CSI en cualquier momento. El patrón
 * recomendado es copiar la estructura a una variable local de inmediato
 * y no conservar el puntero entre llamadas al motor.
 *
 * @param[out] frame  Puntero donde se copia la trama cruda.
 * @return ESP_OK si hay una trama válida,
 *         ESP_ERR_NOT_FOUND si aún no se recibió ninguna trama,
 *         ESP_ERR_INVALID_STATE si el motor no fue inicializado,
 *         ESP_ERR_INVALID_ARG si frame es NULL.
 */
esp_err_t csi_engine_get_last_frame(csi_frame_t *frame);

/**
 * Iniciar o reiniciar la auto-calibración de línea base de ruido ambiente.
 *
 * Durante los próximos `duration_sec` segundos, el motor promediará el piso
 * de ruido de la zona vacía y lo restará de las lecturas futuras.
 *
 * @param duration_sec Duración de la calibración en segundos (típicamente 20)
 * @return ESP_OK en éxito, ESP_ERR_INVALID_STATE si el motor no está inicializado.
 */
esp_err_t csi_engine_start_calibration(uint16_t duration_sec);

/**
 * Consultar si el motor está en proceso de calibración de línea base.
 */
bool csi_engine_is_calibrating(void);

/**
 * Liberar recursos del motor CSI.
 */
void csi_engine_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* CSI_ENGINE_H */
