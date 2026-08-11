/**
 * @file csi_publisher.c
 * @brief Publicador de telemetría CSI — formatea y publica lecturas de movimiento.
 *
 * Genera payloads JSON conformes al esquema CsiTelemetryMessage del diseño:
 * {
 *   "zone_id": "string (1-64 chars)",
 *   "timestamp": "ISO 8601",
 *   "motion_probability": float [0.0, 1.0],
 *   "node_id": "string (1-64 chars)"
 * }
 *
 * El tópico MQTT de publicación es: cali/zone/{zone_id}/csi
 *
 * Delega la publicación real al módulo cali_mqtt (mqtt_client.c), que gestiona
 * la conexión al broker, autenticación PSK, buffering y reintentos.
 *
 * Requisito implementado: 9.2
 */

#include "csi_publisher.h"
#include "cali_mqtt.h"

#include <stdio.h>
#include <string.h>
#include <time.h>
#include "esp_log.h"

static const char *TAG = "csi_pub";

/**
 * Convertir timestamp en milisegundos a cadena ISO 8601 simplificada.
 *
 * Genera formato: "YYYY-MM-DDTHH:MM:SS.sssZ"
 * Si time() no está disponible (sin NTP), usa el timestamp_ms relativo
 * al arranque como epoch offset y genera un formato razonable.
 *
 * En campo, el RTC puede no tener hora exacta. El timestamp sirve
 * como identificador de secuencia ordenable. El backend puede
 * recalibrar usando received_at cuando sea necesario.
 */
static void timestamp_to_iso8601(int64_t timestamp_ms, char *buf, size_t buf_len)
{
    /*
     * Intentar usar el reloj del sistema. Si no hay NTP configurado,
     * time() devuelve cercano a 0 (epoch 1970). En ese caso usamos
     * el timestamp_ms como offset desde epoch.
     */
    time_t seconds = (time_t)(timestamp_ms / 1000);
    int millis = (int)(timestamp_ms % 1000);

    struct tm timeinfo;
    gmtime_r(&seconds, &timeinfo);

    snprintf(buf, buf_len, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
             timeinfo.tm_year + 1900,
             timeinfo.tm_mon + 1,
             timeinfo.tm_mday,
             timeinfo.tm_hour,
             timeinfo.tm_min,
             timeinfo.tm_sec,
             millis);
}

esp_err_t csi_publisher_format_json(const motion_reading_t *reading,
                                    char *json_buf, size_t buf_len)
{
    if (reading == NULL || json_buf == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (buf_len < CSI_PUBLISHER_JSON_MAX_LEN) {
        return ESP_ERR_INVALID_SIZE;
    }

    /* Formatear timestamp ISO 8601 */
    char timestamp_str[32];
    timestamp_to_iso8601(reading->timestamp_ms, timestamp_str, sizeof(timestamp_str));

    /* Generar payload JSON */
    int written = snprintf(json_buf, buf_len,
        "{\"zone_id\":\"%s\","
        "\"timestamp\":\"%s\","
        "\"motion_probability\":%.4f,"
        "\"node_id\":\"%s\"}",
        reading->zone_id,
        timestamp_str,
        reading->motion_probability,
        reading->node_id);

    if (written < 0 || (size_t)written >= buf_len) {
        ESP_LOGE(TAG, "Buffer insuficiente para JSON (necesita %d, tiene %zu)",
                 written, buf_len);
        return ESP_ERR_INVALID_SIZE;
    }

    return ESP_OK;
}

esp_err_t csi_publisher_format_topic(const motion_reading_t *reading,
                                     char *topic_buf, size_t buf_len)
{
    if (reading == NULL || topic_buf == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Formato: cali/zone/{zone_id}/csi */
    int written = snprintf(topic_buf, buf_len, "cali/zone/%s/csi", reading->zone_id);

    if (written < 0 || (size_t)written >= buf_len) {
        ESP_LOGE(TAG, "Buffer insuficiente para tópico (necesita %d, tiene %zu)",
                 written, buf_len);
        return ESP_ERR_INVALID_SIZE;
    }

    return ESP_OK;
}

esp_err_t csi_publisher_publish(const motion_reading_t *reading)
{
    if (reading == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /*
     * Delegar publicación al cliente MQTT CALI.
     * Si el broker está conectado, publica directamente.
     * Si no, almacena en el buffer circular interno.
     */
    esp_err_t err = cali_mqtt_publish_reading(reading);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Error publicando lectura via MQTT: %s",
                 esp_err_to_name(err));
    } else {
        ESP_LOGD(TAG, "Lectura enviada a MQTT (prob=%.3f, zona=%s)",
                 reading->motion_probability, reading->zone_id);
    }

    return err;
}
