/**
 * @file cali_mqtt.c
 * @brief Implementación del cliente MQTT con autenticación PSK y buffer circular.
 *
 * Conecta al broker MQTT usando el token PSK como password MQTT,
 * publica lecturas de movimiento en cali/zone/{zone_id}/csi con formato JSON,
 * y almacena lecturas en un buffer circular cuando el broker no está disponible.
 *
 * Last Will and Testament configurado en cali/zone/{zone_id}/status con
 * payload JSON indicando estado "offline".
 *
 * Propiedades satisfechas:
 *   13 — Buffer circular nunca excede 30 elementos, descarta el más antiguo.
 *   15 — Publicación en orden cronológico ascendente de timestamp.
 *
 * Requisitos implementados: 9.6, 6.5
 */

#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_timer.h"

/* Header del componente ESP-MQTT (tipos esp_mqtt_client_*) */
#include "mqtt_client.h"

/* Nuestro header público (tipos de buffer, config, API CALI) */
#include "cali_mqtt.h"

static const char *TAG = "cali_mqtt";

/* ─── Estado interno del módulo ─────────────────────────────────────── */

/** Handle del cliente ESP-MQTT. */
static esp_mqtt_client_handle_t s_mqtt_client = NULL;

/** Buffer circular de lecturas pendientes. */
static mqtt_reading_buffer_t s_buffer;

/** Mutex para acceso concurrente al buffer. */
static SemaphoreHandle_t s_buffer_mutex = NULL;

/** Flag de conexión al broker. */
static volatile bool s_connected = false;

/** Configuración almacenada para formateo de mensajes. */
static cali_mqtt_config_t s_config;

/** Timer de reintento para publicar buffer. */
static esp_timer_handle_t s_retry_timer = NULL;

/** Tópico de publicación CSI (formateado una vez en init). */
static char s_publish_topic[128];

/** Tópico de LWT (formateado una vez en init). */
static char s_lwt_topic[128];

/* ─── Buffer circular ───────────────────────────────────────────────── */

void mqtt_reading_buffer_init(mqtt_reading_buffer_t *buf)
{
    if (buf == NULL) {
        return;
    }
    memset(buf, 0, sizeof(mqtt_reading_buffer_t));
    buf->count = 0;
    buf->head = 0;
}

void mqtt_reading_buffer_push(mqtt_reading_buffer_t *buf, const motion_reading_t *reading)
{
    if (buf == NULL || reading == NULL) {
        return;
    }

    /*
     * Insertar en la posición head.
     * Si el buffer está lleno, esto sobreescribe la lectura más antigua.
     * El head siempre apunta a la próxima posición de escritura, que en un
     * buffer lleno es la posición de la lectura más antigua (la primera
     * insertada que aún no fue consumida).
     */
    memcpy(&buf->readings[buf->head], reading, sizeof(motion_reading_t));
    buf->head = (buf->head + 1) % MQTT_BUFFER_MAX_READINGS;

    if (buf->count < MQTT_BUFFER_MAX_READINGS) {
        buf->count++;
    }
    /* Si count == MQTT_BUFFER_MAX_READINGS, la más antigua fue sobreescrita */
}

bool mqtt_reading_buffer_pop(mqtt_reading_buffer_t *buf, motion_reading_t *reading)
{
    if (buf == NULL || reading == NULL || buf->count == 0) {
        return false;
    }

    /*
     * La lectura más antigua está en la posición tail:
     *   tail = (head - count + MQTT_BUFFER_MAX_READINGS) % MQTT_BUFFER_MAX_READINGS
     *
     * Esto garantiza extracción en orden FIFO — la más antigua primero,
     * lo que corresponde a orden cronológico ascendente (Propiedad 15).
     */
    uint16_t tail = (buf->head - buf->count + MQTT_BUFFER_MAX_READINGS)
                    % MQTT_BUFFER_MAX_READINGS;

    memcpy(reading, &buf->readings[tail], sizeof(motion_reading_t));
    buf->count--;

    return true;
}

/* ─── Formateo de mensajes JSON ─────────────────────────────────────── */

/**
 * Formatear timestamp en milisegundos a cadena ISO 8601.
 * Formato: "YYYY-MM-DDTHH:MM:SS.sssZ"
 */
static void format_timestamp_iso8601(int64_t timestamp_ms, char *buf, size_t buf_size)
{
    time_t seconds = (time_t)(timestamp_ms / 1000);
    int millis = (int)(timestamp_ms % 1000);
    struct tm timeinfo;

    gmtime_r(&seconds, &timeinfo);
    snprintf(buf, buf_size, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
             timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
             timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec, millis);
}

/**
 * Formatear una lectura de movimiento como JSON para publicación.
 *
 * Formato:
 * {"zone_id":"...","node_id":"...","motion_probability":0.XXX,"rssi":-NN,"timestamp":"ISO8601"}
 *
 * Nota: este es el formateador que se usa realmente al publicar por MQTT
 * (`cali_mqtt_publish_reading`). `csi_publisher_format_json()` produce el
 * mismo mensaje lógico pero NO interviene en la ruta de publicación —
 * cualquier campo nuevo del esquema CSI debe agregarse aquí también, o
 * nunca llega al broker (Req 19.1).
 */
static int format_reading_json(const motion_reading_t *reading, char *buf, size_t buf_size)
{
    char ts_buf[32];
    format_timestamp_iso8601(reading->timestamp_ms, ts_buf, sizeof(ts_buf));

    return snprintf(buf, buf_size,
                    "{\"zone_id\":\"%s\",\"node_id\":\"%s\","
                    "\"motion_probability\":%.3f,\"rssi\":%d,"
                    "\"timestamp\":\"%s\"}",
                    reading->zone_id, reading->node_id,
                    reading->motion_probability, (int)reading->rssi, ts_buf);
}

/**
 * Formatear el payload del Last Will and Testament.
 *
 * Formato:
 * {"node_id":"...","zone_id":"...","status":"offline","timestamp":"ISO8601"}
 */
static int format_lwt_payload(char *buf, size_t buf_size)
{
    char ts_buf[32];
    int64_t now_ms = esp_timer_get_time() / 1000;
    format_timestamp_iso8601(now_ms, ts_buf, sizeof(ts_buf));

    return snprintf(buf, buf_size,
                    "{\"node_id\":\"%s\",\"zone_id\":\"%s\","
                    "\"status\":\"offline\",\"timestamp\":\"%s\"}",
                    s_config.node_id, s_config.zone_id, ts_buf);
}

/* ─── Publicación de lecturas almacenadas en buffer ─────────────────── */

/**
 * Publicar todas las lecturas almacenadas en el buffer (orden cronológico).
 *
 * Se invoca cuando se restablece la conexión o desde el timer de reintento.
 * Publica en orden FIFO (ascendente por timestamp — Propiedad 15).
 */
static void publish_buffered_readings(void)
{
    motion_reading_t reading;
    char json_buf[256];

    if (s_buffer_mutex == NULL) {
        return;
    }

    if (xSemaphoreTake(s_buffer_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "No se pudo adquirir mutex del buffer para publicar");
        return;
    }

    uint16_t published = 0;

    while (s_connected && mqtt_reading_buffer_pop(&s_buffer, &reading)) {
        int len = format_reading_json(&reading, json_buf, sizeof(json_buf));
        if (len > 0 && len < (int)sizeof(json_buf)) {
            int msg_id = esp_mqtt_client_publish(
                s_mqtt_client, s_publish_topic, json_buf, len, 1, 0);

            if (msg_id < 0) {
                /*
                 * Fallo al publicar — reinsertar en el buffer y detener.
                 * La lectura se reintentará en el próximo ciclo.
                 */
                mqtt_reading_buffer_push(&s_buffer, &reading);
                ESP_LOGW(TAG, "Fallo publicando lectura almacenada, "
                         "reinsertada en buffer");
                break;
            }
            published++;
        }
    }

    xSemaphoreGive(s_buffer_mutex);

    if (published > 0) {
        ESP_LOGI(TAG, "Publicadas %u lecturas almacenadas en buffer", published);
    }
}

/**
 * Callback del timer de reintento (cada 10 segundos).
 * Intenta publicar lecturas almacenadas si el broker está conectado.
 */
static void retry_timer_callback(void *arg)
{
    (void)arg;

    if (!s_connected) {
        ESP_LOGD(TAG, "Timer de reintento: broker no conectado, esperando...");
        return;
    }

    if (s_buffer.count > 0) {
        ESP_LOGI(TAG, "Timer de reintento: publicando %u lecturas almacenadas",
                 s_buffer.count);
        publish_buffered_readings();
    }
}

/* ─── Handler de eventos MQTT ───────────────────────────────────────── */

/**
 * Handler de eventos del cliente ESP-MQTT.
 */
static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
    (void)handler_args;
    (void)base;

    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            ESP_LOGI(TAG, "Conectado al broker MQTT");
            s_connected = true;

            /* Publicar lecturas almacenadas en buffer al reconectar */
            if (s_buffer.count > 0) {
                ESP_LOGI(TAG, "Reconexión: publicando %u lecturas almacenadas",
                         s_buffer.count);
                publish_buffered_readings();
            }
            break;

        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "Desconectado del broker MQTT");
            s_connected = false;
            break;

        case MQTT_EVENT_PUBLISHED:
            ESP_LOGD(TAG, "Mensaje publicado, msg_id=%d", event->msg_id);
            break;

        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "Error MQTT: tipo=%d", event->error_handle->error_type);
            if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
                ESP_LOGE(TAG, "  Error transporte: 0x%x",
                         event->error_handle->esp_transport_sock_errno);
            }
            break;

        default:
            ESP_LOGD(TAG, "Evento MQTT no manejado: %" PRId32, event_id);
            break;
    }
}

/* ─── API pública ───────────────────────────────────────────────────── */

esp_err_t cali_mqtt_init(const cali_mqtt_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Guardar configuración */
    memcpy(&s_config, config, sizeof(cali_mqtt_config_t));

    /* Formatear tópicos */
    snprintf(s_publish_topic, sizeof(s_publish_topic),
             "cali/zone/%s/csi", config->zone_id);
    snprintf(s_lwt_topic, sizeof(s_lwt_topic),
             "cali/zone/%s/status", config->zone_id);

    /* Inicializar buffer circular */
    mqtt_reading_buffer_init(&s_buffer);

    /* Crear mutex para el buffer */
    s_buffer_mutex = xSemaphoreCreateMutex();
    if (s_buffer_mutex == NULL) {
        ESP_LOGE(TAG, "Error creando mutex del buffer");
        return ESP_FAIL;
    }

    /* Preparar payload del Last Will and Testament */
    char lwt_payload[256];
    format_lwt_payload(lwt_payload, sizeof(lwt_payload));

    /* Formatear URI del broker */
    char broker_uri[256];
    snprintf(broker_uri, sizeof(broker_uri),
             "mqtt://%s:%u", config->broker_host, config->broker_port);

    /* Configurar cliente ESP-MQTT */
    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address = {
                .uri = broker_uri,
            },
        },
        .credentials = {
            .username = config->node_id,
            .authentication = {
                .password = config->token,
            },
        },
        .session = {
            .last_will = {
                .topic = s_lwt_topic,
                .msg = lwt_payload,
                .msg_len = (int)strlen(lwt_payload),
                .qos = 1,
                .retain = 1,
            },
            .keepalive = 60,
        },
        .network = {
            .reconnect_timeout_ms = MQTT_RETRY_INTERVAL_MS,
        },
    };

    /* Crear cliente MQTT */
    s_mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (s_mqtt_client == NULL) {
        ESP_LOGE(TAG, "Error inicializando cliente MQTT");
        vSemaphoreDelete(s_buffer_mutex);
        s_buffer_mutex = NULL;
        return ESP_FAIL;
    }

    /* Registrar handler de eventos */
    esp_err_t err = esp_mqtt_client_register_event(
        s_mqtt_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error registrando handler de eventos: %s",
                 esp_err_to_name(err));
        esp_mqtt_client_destroy(s_mqtt_client);
        s_mqtt_client = NULL;
        vSemaphoreDelete(s_buffer_mutex);
        s_buffer_mutex = NULL;
        return err;
    }

    /* Iniciar conexión */
    err = esp_mqtt_client_start(s_mqtt_client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error iniciando cliente MQTT: %s", esp_err_to_name(err));
        esp_mqtt_client_destroy(s_mqtt_client);
        s_mqtt_client = NULL;
        vSemaphoreDelete(s_buffer_mutex);
        s_buffer_mutex = NULL;
        return err;
    }

    /* Crear timer de reintento para publicar lecturas almacenadas */
    const esp_timer_create_args_t timer_args = {
        .callback = retry_timer_callback,
        .arg = NULL,
        .name = "mqtt_retry",
    };

    err = esp_timer_create(&timer_args, &s_retry_timer);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Error creando timer de reintento: %s (no fatal)",
                 esp_err_to_name(err));
        /* No fatal — el retry por reconexión sigue funcionando */
    } else {
        /* Timer periódico cada 10 segundos */
        esp_timer_start_periodic(s_retry_timer, MQTT_RETRY_INTERVAL_MS * 1000);
        ESP_LOGI(TAG, "Timer de reintento iniciado (cada %d ms)",
                 MQTT_RETRY_INTERVAL_MS);
    }

    ESP_LOGI(TAG, "Cliente MQTT inicializado:");
    ESP_LOGI(TAG, "  Broker: %s", broker_uri);
    ESP_LOGI(TAG, "  Tópico publicación: %s", s_publish_topic);
    ESP_LOGI(TAG, "  Tópico LWT: %s", s_lwt_topic);
    ESP_LOGI(TAG, "  Buffer máximo: %d lecturas", MQTT_BUFFER_MAX_READINGS);

    return ESP_OK;
}

esp_err_t cali_mqtt_publish_reading(const motion_reading_t *reading)
{
    if (reading == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    char json_buf[256];
    int len = format_reading_json(reading, json_buf, sizeof(json_buf));
    if (len <= 0 || len >= (int)sizeof(json_buf)) {
        ESP_LOGE(TAG, "Error formateando lectura a JSON");
        return ESP_FAIL;
    }

    if (s_connected && s_mqtt_client != NULL) {
        /* Broker conectado — publicar directamente */
        int msg_id = esp_mqtt_client_publish(
            s_mqtt_client, s_publish_topic, json_buf, len, 1, 0);

        if (msg_id >= 0) {
            ESP_LOGD(TAG, "Lectura publicada, msg_id=%d, prob=%.3f",
                     msg_id, reading->motion_probability);
            return ESP_OK;
        }

        /* Fallo al publicar — almacenar en buffer */
        ESP_LOGW(TAG, "Fallo publicación directa, almacenando en buffer");
    }

    /* Broker no conectado o fallo de publicación — almacenar en buffer */
    if (s_buffer_mutex == NULL) {
        ESP_LOGE(TAG, "Cliente MQTT no inicializado");
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_buffer_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        mqtt_reading_buffer_push(&s_buffer, reading);
        xSemaphoreGive(s_buffer_mutex);

        ESP_LOGD(TAG, "Lectura almacenada en buffer (%u/%u)",
                 s_buffer.count, MQTT_BUFFER_MAX_READINGS);
        return ESP_OK;
    }

    ESP_LOGW(TAG, "No se pudo adquirir mutex para almacenar lectura");
    return ESP_FAIL;
}

esp_err_t cali_mqtt_publish_payload(const char *topic, const char *payload, size_t payload_len)
{
    if (topic == NULL || payload == NULL || payload_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_connected || s_mqtt_client == NULL) {
        ESP_LOGD(TAG, "publish_payload: broker no conectado, descartando");
        return ESP_ERR_INVALID_STATE;
    }

    int msg_id = esp_mqtt_client_publish(s_mqtt_client,
                                          topic,
                                          payload,
                                          (int)payload_len,
                                          1,  /* QoS 1: al menos una vez */
                                          0); /* retain=false */
    if (msg_id < 0) {
        ESP_LOGW(TAG, "publish_payload fallo (msg_id=%d)", msg_id);
        return ESP_FAIL;
    }

    ESP_LOGD(TAG, "publish_payload OK msg_id=%d len=%u",
             msg_id, (unsigned)payload_len);
    return ESP_OK;
}

bool cali_mqtt_is_connected(void)
{
    return s_connected;
}

uint16_t cali_mqtt_get_buffer_count(void)
{
    return s_buffer.count;
}

void cali_mqtt_deinit(void)
{
    /* Detener timer de reintento */
    if (s_retry_timer != NULL) {
        esp_timer_stop(s_retry_timer);
        esp_timer_delete(s_retry_timer);
        s_retry_timer = NULL;
    }

    /* Detener y destruir cliente MQTT */
    if (s_mqtt_client != NULL) {
        esp_mqtt_client_stop(s_mqtt_client);
        esp_mqtt_client_destroy(s_mqtt_client);
        s_mqtt_client = NULL;
    }

    /* Liberar mutex */
    if (s_buffer_mutex != NULL) {
        vSemaphoreDelete(s_buffer_mutex);
        s_buffer_mutex = NULL;
    }

    s_connected = false;
    ESP_LOGI(TAG, "Cliente MQTT detenido y recursos liberados");
}
