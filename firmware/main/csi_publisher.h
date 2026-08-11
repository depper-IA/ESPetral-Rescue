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

#ifdef __cplusplus
}
#endif

#endif /* CSI_PUBLISHER_H */
