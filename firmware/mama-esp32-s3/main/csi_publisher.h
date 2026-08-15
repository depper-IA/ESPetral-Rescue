#ifndef CSI_PUBLISHER_H
#define CSI_PUBLISHER_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "csi_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file csi_publisher.h
 * @brief Publicador de telemetría CSI — formatea motion_reading_t como JSON
 *        para publicación MQTT en el tópico cali/zone/{zone_id}/csi.
 *
 * Genera mensajes JSON conformes al esquema CsiTelemetryMessage definido
 * en el diseño del sistema. La integración MQTT real se implementa en
 * la tarea 10.4; por ahora las lecturas se registran en log.
 *
 * Esquema JSON de salida:
 * {
 *   "zone_id": "string",
 *   "timestamp": "ISO 8601",
 *   "motion_probability": float [0.0, 1.0],
 *   "rssi": int (RSSI crudo del hardware ESP32, dBm, Req 19.1),
 *   "node_id": "string"
 * }
 *
 * Requisitos implementados: 9.2
 */

/** Tamaño máximo del payload JSON generado. */
#define CSI_PUBLISHER_JSON_MAX_LEN 256

/** Tamaño máximo del tópico MQTT generado. */
#define CSI_PUBLISHER_TOPIC_MAX_LEN 128

/**
 * Formatear una lectura de movimiento como payload JSON.
 *
 * Genera un string JSON conforme al esquema CsiTelemetryMessage.
 * El timestamp se formatea como ISO 8601 derivado del campo timestamp_ms.
 *
 * @param[in]  reading  Lectura de movimiento a formatear.
 * @param[out] json_buf Buffer donde se escribe el JSON resultante.
 * @param[in]  buf_len  Tamaño del buffer de salida.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si algún puntero es NULL,
 *         ESP_ERR_INVALID_SIZE si el buffer es insuficiente.
 */
esp_err_t csi_publisher_format_json(const motion_reading_t *reading,
                                    char *json_buf, size_t buf_len);

/**
 * Generar el tópico MQTT para una lectura de movimiento.
 *
 * Produce: "cali/zone/{zone_id}/csi"
 *
 * @param[in]  reading    Lectura de movimiento (usa zone_id).
 * @param[out] topic_buf  Buffer donde se escribe el tópico.
 * @param[in]  buf_len    Tamaño del buffer de salida.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si algún puntero es NULL,
 *         ESP_ERR_INVALID_SIZE si el buffer es insuficiente.
 */
esp_err_t csi_publisher_format_topic(const motion_reading_t *reading,
                                     char *topic_buf, size_t buf_len);

/**
 * Publicar una lectura de movimiento.
 *
 * Formatea la lectura como JSON y la envía al tópico MQTT correspondiente.
 * En esta fase (pre-tarea 10.4) la publicación se realiza como log.
 * Cuando el cliente MQTT esté disponible, esta función se extenderá
 * para enviar el mensaje al broker.
 *
 * @param[in] reading  Lectura de movimiento a publicar.
 * @return ESP_OK en éxito, error si el formateo falla.
 */
esp_err_t csi_publisher_publish(const motion_reading_t *reading);

/** Tamaño máximo del payload JSON de csi_raw (64 amplitudes + headers). */
#define CSI_PUBLISHER_RAW_JSON_MAX_LEN 1024

/**
 * Formatear y publicar una trama CSI cruda (64 amplitudes por subportadora).
 *
 * Topic: cali/zone/{zone_id}/csi_raw
 * Payload JSON:
 * {
 *   "zone_id": "string",
 *   "node_id": "string",
 *   "timestamp": "ISO 8601",
 *   "subcarrier_amplitudes": [64 floats]
 * }
 *
 * Pensado para alimentar pipelines de RuView (bandpass filters,
 * ML inference) en el backend. NO se almacena en buffer MQTT si el
 * broker está desconectado (ver cali_mqtt_publish_payload).
 *
 * @param[in] frame  Trama CSI cruda con amplitudes de 64 subportadoras.
 * @return ESP_OK en éxito, error si falla formato o publicación.
 */
esp_err_t csi_publisher_publish_raw_frame(const csi_frame_t *frame);

/**
 * Numero de subportadoras muestreadas en el payload del spike de fase
 * (Fase 0 — gate de validacion csi-vitals-per-node).
 */
#define PHASE_SPIKE_SUBCARRIER_COUNT 8

/** Tamaño máximo del payload JSON del spike de fase. */
#define CSI_PUBLISHER_PHASE_SPIKE_JSON_MAX_LEN 512

/**
 * Formatear y publicar el spike de fase de subportadora (Fase 0 —
 * gate de validacion csi-vitals-per-node).
 *
 * Diff temporal: existe solo para validar, con una captura de hardware
 * real, que la fase CSI puede sanearse (unwrap + ajuste lineal, D1) a
 * un jitter residual por debajo de la banda de respiracion (0.1-0.5 Hz).
 * Si el veredicto es NO-GO, este codigo se revierte junto con el resto
 * del cambio.
 *
 * Aplica el saneador D1 sobre las 64 fases crudas de la trama (unwrap
 * a lo largo del indice de subportadora k + ajuste LSQ phi_k ~= a*k+b),
 * y publica tanto la fase desenvuelta cruda como el residuo saneado
 * para PHASE_SPIKE_SUBCARRIER_COUNT subportadoras seleccionadas.
 *
 * Topic: cali/zone/{zone_id}/csi_phase_spike
 * Payload JSON (~350 B):
 * {
 *   "zone_id": "string",
 *   "node_id": "string",
 *   "timestamp": "ISO 8601",
 *   "seq": uint32,
 *   "phase_raw": [8 floats],
 *   "phase_san": [8 floats],
 *   "fit_a": float,
 *   "fit_b": float
 * }
 *
 * @param[in] frame  Trama CSI cruda con fases de 64 subportadoras.
 * @return ESP_OK en éxito, error si falla el formato o la publicación.
 */
esp_err_t csi_publisher_publish_phase_spike(const csi_frame_t *frame);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PUBLISHER_H */
