/**
 * @file csi_publisher.c
 * @brief Publicador de telemetría CSI — formatea y publica lecturas de movimiento.
 *
 * Genera payloads JSON conformes al esquema CsiTelemetryMessage del diseño:
 * {
 *   "zone_id": "string (1-64 chars)",
 *   "timestamp": "ISO 8601",
 *   "motion_probability": float [0.0, 1.0],
 *   "rssi": int (RSSI crudo del hardware ESP32, dBm, Req 19.1),
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
#include <math.h>
#include "esp_log.h"

static const char *TAG = "csi_pub";

/** Valor local de PI para el desenvolvimiento de fase (evita depender de M_PI del toolchain). */
#define PHASE_UNWRAP_PI 3.14159265358979323846f

/**
 * Indices de subportadora seleccionados para el spike de fase (Fase 0).
 * Distribuidos sobre la banda util del canal HT20, evitando los
 * extremos donde suelen estar las subportadoras de guarda/nulas.
 *
 * PENDIENTE (pregunta abierta del diseno): confirmar con una captura
 * real cual es el patron exacto de subportadoras guarda/nulas en
 * ESP32-C3 vs S3 vs C6. Estos indices son un punto de partida
 * razonable para la Fase 0, no una certeza de hardware.
 */
static const uint8_t PHASE_SPIKE_SUBCARRIER_INDICES[PHASE_SPIKE_SUBCARRIER_COUNT] = {
    6, 12, 18, 24, 32, 40, 48, 56
};

/** Contador de secuencia del spike de fase (incrementa por cada publicacion). */
static uint32_t s_phase_spike_seq = 0;

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
        "\"rssi\":%d,"
        "\"node_id\":\"%s\"}",
        reading->zone_id,
        timestamp_str,
        reading->motion_probability,
        (int)reading->rssi,
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

esp_err_t csi_publisher_publish_raw_frame(const csi_frame_t *frame)
{
    if (frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Buffer local para JSON: cubre 64 floats con 4 decimales + campos.
     * %.4f de un float usa hasta ~9 chars (ej. "-123.4567"), + coma = 10 chars
     * por amplitud. 64 × 10 = 640 + header ~150 + footer ~8 ≈ 800. */
    char json_buf[CSI_PUBLISHER_RAW_JSON_MAX_LEN];
    char topic_buf[CSI_PUBLISHER_TOPIC_MAX_LEN];
    int written = 0;
    int n = 0;

    /* Formatear timestamp ISO 8601 */
    char timestamp_str[32];
    timestamp_to_iso8601(frame->timestamp_ms, timestamp_str, sizeof(timestamp_str));

    /*
     * Obtener zone_id y node_id desde el motor CSI. csi_frame_t no incluye
     * esos strings (solo amplitudes + timestamp); el publicador los toma
     * del estado global del motor.
     */
    const char *zone_id = csi_engine_get_zone_id();
    const char *node_id = csi_engine_get_node_id();
    if (zone_id == NULL) zone_id = "";
    if (node_id == NULL) node_id = "";

    /* Header fijo del payload */
    n = snprintf(json_buf, sizeof(json_buf),
                 "{\"zone_id\":\"%s\","
                 "\"node_id\":\"%s\","
                 "\"timestamp\":\"%s\","
                 "\"subcarrier_amplitudes\":[",
                 zone_id, node_id, timestamp_str);
    if (n < 0 || (size_t)n >= sizeof(json_buf)) {
        ESP_LOGE(TAG, "Buffer insuficiente para header JSON (escribio=%d)", n);
        return ESP_ERR_INVALID_SIZE;
    }
    written = n;

    /* Concatenar 64 amplitudes con coma separadora. Detectar truncamiento. */
    for (int i = 0; i < CSI_NUM_SUBCARRIERS; i++) {
        /* Separador entre elementos (excepto antes del primero) */
        if (i > 0) {
            if (written + 1 >= (int)sizeof(json_buf)) {
                ESP_LOGE(TAG, "Buffer insuficiente al concat coma [i=%d]", i);
                return ESP_ERR_INVALID_SIZE;
            }
            json_buf[written++] = ',';
        }

        n = snprintf(json_buf + written, sizeof(json_buf) - (size_t)written,
                     "%.4f", (double)frame->subcarrier_amplitudes[i]);
        if (n < 0 || (size_t)n >= sizeof(json_buf) - (size_t)written) {
            ESP_LOGE(TAG, "Buffer insuficiente al formatear amplitud [i=%d] "
                     "(escribio=%d, restante=%u)",
                     i, n, (unsigned)(sizeof(json_buf) - (size_t)written));
            return ESP_ERR_INVALID_SIZE;
        }
        written += n;
    }

    /* Cierre del array y objeto: "]}". 3 bytes (incluye \0). */
    static const char tail[] = "]}";
    if (written + (int)sizeof(tail) > (int)sizeof(json_buf)) {
        ESP_LOGE(TAG, "Buffer insuficiente para cierre JSON");
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(json_buf + written, tail, sizeof(tail));
    written += (int)sizeof(tail) - 1;  /* sin contar el \0 */

    /* Construir tópico: cali/zone/{zone_id}/csi_raw */
    n = snprintf(topic_buf, sizeof(topic_buf),
                 "cali/zone/%s/csi_raw", zone_id);
    if (n < 0 || (size_t)n >= sizeof(topic_buf)) {
        ESP_LOGE(TAG, "Buffer insuficiente para tópico (necesita=%d, tiene=%u)",
                 n, (unsigned)sizeof(topic_buf));
        return ESP_ERR_INVALID_SIZE;
    }

    /* Publicar via cali_mqtt (no se almacena en buffer si broker ausente) */
    esp_err_t err = cali_mqtt_publish_payload(topic_buf, json_buf, (size_t)written);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "Error publicando raw frame: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGD(TAG, "Raw frame publicado: topic=%s, len=%d, amplitudes[0]=%.4f",
             topic_buf, written, (double)frame->subcarrier_amplitudes[0]);
    return ESP_OK;
}

/**
 * Desenvolver (unwrap) una serie de fase a lo largo del indice de
 * subportadora k, y ajustar una recta phi_k ~= a*k + b por minimos
 * cuadrados (LSQ) sobre la serie ya desenvuelta.
 *
 * Decision de diseno D1: con una sola antena, el ESP32 no puede
 * cancelar el ruido de fase por conjugacion entre antenas (a diferencia
 * de TensorBeat/Widar). En su lugar se ajusta una recta sobre el indice
 * de subportadora: la pendiente 'a' absorbe el offset de tiempo/
 * frecuencia de muestreo (STO/SFO) y la ordenada 'b' absorbe el offset
 * de frecuencia de portadora (CFO). El residuo phi_k - (a*k+b) es la
 * señal que el spike de Fase 0 debe validar como "suficientemente
 * limpia" para la banda de respiracion (0.1-0.5 Hz).
 *
 * @param[in]  phase_raw     Fase cruda envuelta [-pi, pi] por subportadora.
 * @param[in]  count         Cantidad de subportadoras en phase_raw.
 * @param[out] out_unwrapped Fase desenvuelta (misma longitud que phase_raw).
 * @param[out] out_a         Pendiente del ajuste lineal.
 * @param[out] out_b         Ordenada al origen del ajuste lineal.
 */
static void sanitize_phase(const float *phase_raw, int count,
                            float *out_unwrapped, float *out_a, float *out_b)
{
    out_unwrapped[0] = phase_raw[0];
    for (int k = 1; k < count; k++) {
        float delta = phase_raw[k] - phase_raw[k - 1];
        while (delta > PHASE_UNWRAP_PI) {
            delta -= 2.0f * PHASE_UNWRAP_PI;
        }
        while (delta < -PHASE_UNWRAP_PI) {
            delta += 2.0f * PHASE_UNWRAP_PI;
        }
        out_unwrapped[k] = out_unwrapped[k - 1] + delta;
    }

    /* Ajuste lineal por minimos cuadrados: y = a*k + b.
     * Se usa double en los acumuladores para evitar perdida de precision
     * al sumar 64 terminos — la salida final se castea a float. */
    double sum_k = 0.0, sum_y = 0.0, sum_ky = 0.0, sum_kk = 0.0;
    for (int k = 0; k < count; k++) {
        double kd = (double)k;
        double yd = (double)out_unwrapped[k];
        sum_k += kd;
        sum_y += yd;
        sum_ky += kd * yd;
        sum_kk += kd * kd;
    }
    double n = (double)count;
    double denom = (n * sum_kk) - (sum_k * sum_k);
    double a = 0.0;
    double b = 0.0;
    if (fabs(denom) > 1e-9) {
        a = ((n * sum_ky) - (sum_k * sum_y)) / denom;
        b = (sum_y - (a * sum_k)) / n;
    }

    *out_a = (float)a;
    *out_b = (float)b;
}

/**
 * Anexar un arreglo de floats como JSON array (sin corchetes) al buffer
 * de salida, en la posicion `written`. Detecta desbordamiento.
 *
 * @return Nueva posicion de escritura, o -1 si el buffer no alcanza.
 */
static int append_float_array_json(char *buf, size_t buf_len, int written,
                                    const float *values, int count)
{
    for (int i = 0; i < count; i++) {
        if (i > 0) {
            if (written + 1 >= (int)buf_len) {
                return -1;
            }
            buf[written++] = ',';
        }

        int n = snprintf(buf + written, buf_len - (size_t)written,
                          "%.6f", (double)values[i]);
        if (n < 0 || (size_t)n >= buf_len - (size_t)written) {
            return -1;
        }
        written += n;
    }
    return written;
}

esp_err_t csi_publisher_publish_phase_spike(const csi_frame_t *frame)
{
    if (frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Sanear usando las 64 subportadoras completas (mas muestras => ajuste
     * LSQ mas estable), aunque solo se publican PHASE_SPIKE_SUBCARRIER_COUNT
     * residuos seleccionados. */
    float unwrapped[CSI_NUM_SUBCARRIERS];
    float fit_a = 0.0f;
    float fit_b = 0.0f;
    sanitize_phase(frame->subcarrier_phases, CSI_NUM_SUBCARRIERS, unwrapped, &fit_a, &fit_b);

    float phase_raw[PHASE_SPIKE_SUBCARRIER_COUNT];
    float phase_san[PHASE_SPIKE_SUBCARRIER_COUNT];
    for (int i = 0; i < PHASE_SPIKE_SUBCARRIER_COUNT; i++) {
        uint8_t idx = PHASE_SPIKE_SUBCARRIER_INDICES[i];
        phase_raw[i] = unwrapped[idx];
        phase_san[i] = unwrapped[idx] - (fit_a * (float)idx + fit_b);
    }

    char timestamp_str[32];
    timestamp_to_iso8601(frame->timestamp_ms, timestamp_str, sizeof(timestamp_str));

    const char *zone_id = csi_engine_get_zone_id();
    const char *node_id = csi_engine_get_node_id();
    if (zone_id == NULL) zone_id = "";
    if (node_id == NULL) node_id = "";

    char json_buf[CSI_PUBLISHER_PHASE_SPIKE_JSON_MAX_LEN];
    char topic_buf[CSI_PUBLISHER_TOPIC_MAX_LEN];

    int written = snprintf(json_buf, sizeof(json_buf),
        "{\"zone_id\":\"%s\","
        "\"node_id\":\"%s\","
        "\"timestamp\":\"%s\","
        "\"seq\":%u,"
        "\"phase_raw\":[",
        zone_id, node_id, timestamp_str, (unsigned)s_phase_spike_seq);
    if (written < 0 || (size_t)written >= sizeof(json_buf)) {
        ESP_LOGE(TAG, "Buffer insuficiente para header del spike de fase");
        return ESP_ERR_INVALID_SIZE;
    }

    written = append_float_array_json(json_buf, sizeof(json_buf), written,
                                       phase_raw, PHASE_SPIKE_SUBCARRIER_COUNT);
    if (written < 0) {
        ESP_LOGE(TAG, "Buffer insuficiente al escribir phase_raw");
        return ESP_ERR_INVALID_SIZE;
    }

    int n = snprintf(json_buf + written, sizeof(json_buf) - (size_t)written,
                      "],\"phase_san\":[");
    if (n < 0 || (size_t)n >= sizeof(json_buf) - (size_t)written) {
        ESP_LOGE(TAG, "Buffer insuficiente antes de phase_san");
        return ESP_ERR_INVALID_SIZE;
    }
    written += n;

    written = append_float_array_json(json_buf, sizeof(json_buf), written,
                                       phase_san, PHASE_SPIKE_SUBCARRIER_COUNT);
    if (written < 0) {
        ESP_LOGE(TAG, "Buffer insuficiente al escribir phase_san");
        return ESP_ERR_INVALID_SIZE;
    }

    n = snprintf(json_buf + written, sizeof(json_buf) - (size_t)written,
                 "],\"fit_a\":%.6f,\"fit_b\":%.6f}",
                 (double)fit_a, (double)fit_b);
    if (n < 0 || (size_t)n >= sizeof(json_buf) - (size_t)written) {
        ESP_LOGE(TAG, "Buffer insuficiente para cierre del spike de fase");
        return ESP_ERR_INVALID_SIZE;
    }
    written += n;

    n = snprintf(topic_buf, sizeof(topic_buf), "cali/zone/%s/csi_phase_spike", zone_id);
    if (n < 0 || (size_t)n >= sizeof(topic_buf)) {
        ESP_LOGE(TAG, "Buffer insuficiente para tópico del spike de fase");
        return ESP_ERR_INVALID_SIZE;
    }

    esp_err_t err = cali_mqtt_publish_payload(topic_buf, json_buf, (size_t)written);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "Error publicando spike de fase: %s", esp_err_to_name(err));
        return err;
    }

    s_phase_spike_seq++;

    ESP_LOGD(TAG, "Spike de fase publicado: topic=%s, len=%d, seq=%u, fit_a=%.4f, fit_b=%.4f",
             topic_buf, written, (unsigned)(s_phase_spike_seq - 1), (double)fit_a, (double)fit_b);
    return ESP_OK;
}
