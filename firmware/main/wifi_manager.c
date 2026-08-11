/**
 * @file wifi_manager.c
 * @brief Implementación del gestor Wi-Fi con reconexión exponencial backoff.
 *
 * Gestiona la conexión Wi-Fi STA con reconexión automática usando backoff
 * exponencial. Mantiene un buffer circular de 60 lecturas CSI durante
 * desconexión, separado del buffer MQTT de 30 lecturas.
 *
 * Comportamiento de reconexión (Propiedad 14):
 *   - Intento 1: espera 10s
 *   - Intento 2: espera 20s
 *   - Intento 3: espera 40s
 *   - Intento 4+: espera 60s (máximo)
 *   - Intentos indefinidos hasta reconexión exitosa
 *
 * Comportamiento del buffer (Propiedad 13):
 *   - Capacidad: 60 lecturas
 *   - Overflow: descarta la lectura más antigua
 *   - Flush: al reconectar, publica todas las lecturas en orden cronológico
 *
 * Requisitos implementados: 10.1, 10.2
 */

#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"

#include "esp_log.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_netif.h"

#include "wifi_manager.h"
#include "cali_mqtt.h"

static const char *TAG = "wifi_mgr";

/* ─── Bits de evento para sincronización Wi-Fi ──────────────────────── */

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

/* ─── Estado interno del módulo ─────────────────────────────────────── */

/** Grupo de eventos Wi-Fi. */
static EventGroupHandle_t s_wifi_event_group = NULL;

/** Flag de conexión Wi-Fi. */
static volatile bool s_wifi_connected = false;

/** Buffer circular de lecturas durante desconexión. */
static wifi_reading_buffer_t s_wifi_buffer;

/** Mutex para acceso concurrente al buffer. */
static SemaphoreHandle_t s_buffer_mutex = NULL;

/** Número de intento de reconexión actual (0 = conectado). */
static volatile uint32_t s_reconnect_attempt = 0;

/** Timer para reconexión con backoff. */
static esp_timer_handle_t s_reconnect_timer = NULL;

/** Flag para evitar reconexiones múltiples simultáneas. */
static volatile bool s_reconnect_pending = false;

/* ─── Buffer circular (implementación) ──────────────────────────────── */

void wifi_reading_buffer_init(wifi_reading_buffer_t *buf)
{
    if (buf == NULL) {
        return;
    }
    memset(buf, 0, sizeof(wifi_reading_buffer_t));
    buf->count = 0;
    buf->head = 0;
}

void wifi_reading_buffer_push(wifi_reading_buffer_t *buf, const motion_reading_t *reading)
{
    if (buf == NULL || reading == NULL) {
        return;
    }

    /*
     * Insertar en la posición head.
     * Si el buffer está lleno, esto sobreescribe la lectura más antigua.
     */
    memcpy(&buf->readings[buf->head], reading, sizeof(motion_reading_t));
    buf->head = (buf->head + 1) % WIFI_BUFFER_MAX_READINGS;

    if (buf->count < WIFI_BUFFER_MAX_READINGS) {
        buf->count++;
    }
    /* Si count == WIFI_BUFFER_MAX_READINGS, la más antigua fue sobreescrita */
}

bool wifi_reading_buffer_pop(wifi_reading_buffer_t *buf, motion_reading_t *reading)
{
    if (buf == NULL || reading == NULL || buf->count == 0) {
        return false;
    }

    /*
     * La lectura más antigua está en la posición tail:
     *   tail = (head - count + WIFI_BUFFER_MAX_READINGS) % WIFI_BUFFER_MAX_READINGS
     */
    uint16_t tail = (buf->head - buf->count + WIFI_BUFFER_MAX_READINGS)
                    % WIFI_BUFFER_MAX_READINGS;

    memcpy(reading, &buf->readings[tail], sizeof(motion_reading_t));
    buf->count--;

    return true;
}

/* ─── Backoff exponencial ───────────────────────────────────────────── */

uint32_t wifi_manager_calc_backoff_interval(uint32_t attempt)
{
    if (attempt == 0) {
        return WIFI_RECONNECT_INITIAL_INTERVAL_S;
    }

    /*
     * Fórmula: min(10 × 2^(attempt-1), 60)
     *
     * Para evitar overflow con exponentes grandes, limitamos el shift.
     * 10 × 2^(k-1) supera 60 cuando k >= 4, así que basta verificar.
     */
    uint32_t shift = attempt - 1;

    /* Prevenir overflow: si shift >= 3, ya estamos en máximo */
    if (shift >= 3) {
        return WIFI_RECONNECT_MAX_INTERVAL_S;
    }

    uint32_t interval = WIFI_RECONNECT_INITIAL_INTERVAL_S * (1u << shift);

    if (interval > WIFI_RECONNECT_MAX_INTERVAL_S) {
        return WIFI_RECONNECT_MAX_INTERVAL_S;
    }

    return interval;
}

/* ─── Flush del buffer al reconectar ────────────────────────────────── */

/**
 * Publicar todas las lecturas almacenadas en el buffer Wi-Fi.
 *
 * Se invoca al reconectar. Las lecturas se envían al path de publicación
 * MQTT (cali_mqtt_publish_reading) en orden cronológico ascendente.
 * Si MQTT no está conectado aún, las lecturas irán a su propio buffer interno.
 */
static void flush_wifi_buffer(void)
{
    if (s_buffer_mutex == NULL) {
        return;
    }

    if (xSemaphoreTake(s_buffer_mutex, pdMS_TO_TICKS(200)) != pdTRUE) {
        ESP_LOGW(TAG, "No se pudo adquirir mutex para flush del buffer");
        return;
    }

    motion_reading_t reading;
    uint16_t flushed = 0;

    while (wifi_reading_buffer_pop(&s_wifi_buffer, &reading)) {
        /*
         * Enviar al path de publicación MQTT. Si MQTT aún no reconectó,
         * cali_mqtt_publish_reading almacenará en su propio buffer de 30.
         */
        cali_mqtt_publish_reading(&reading);
        flushed++;
    }

    xSemaphoreGive(s_buffer_mutex);

    if (flushed > 0) {
        ESP_LOGI(TAG, "Flush Wi-Fi buffer: %u lecturas enviadas al path MQTT",
                 flushed);
    }
}

/* ─── Timer de reconexión ───────────────────────────────────────────── */

/**
 * Callback del timer de reconexión.
 *
 * Ejecuta un intento de reconexión Wi-Fi y programa el siguiente
 * intento con intervalo duplicado (hasta 60s máximo).
 */
static void reconnect_timer_callback(void *arg)
{
    (void)arg;

    if (s_wifi_connected) {
        /* Ya reconectamos — limpiar estado */
        s_reconnect_pending = false;
        return;
    }

    s_reconnect_attempt++;
    ESP_LOGI(TAG, "Intento de reconexión #%" PRIu32 " (intervalo actual: %" PRIu32 "s)",
             s_reconnect_attempt,
             wifi_manager_calc_backoff_interval(s_reconnect_attempt));

    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_connect() falló: %s", esp_err_to_name(err));
    }

    /*
     * Programar próximo intento con backoff incrementado.
     * El timer se detendrá cuando recibamos IP_EVENT_STA_GOT_IP.
     */
    uint32_t next_interval = wifi_manager_calc_backoff_interval(s_reconnect_attempt + 1);
    uint64_t next_interval_us = (uint64_t)next_interval * 1000000ULL;

    esp_timer_stop(s_reconnect_timer);
    err = esp_timer_start_once(s_reconnect_timer, next_interval_us);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error programando próximo intento: %s", esp_err_to_name(err));
    }
}

/**
 * Iniciar la secuencia de reconexión con backoff exponencial.
 *
 * Se llama cuando se detecta desconexión Wi-Fi. Si ya hay una reconexión
 * en progreso, no hace nada.
 */
static void start_reconnect_sequence(void)
{
    if (s_reconnect_pending || s_reconnect_timer == NULL) {
        return;
    }

    s_reconnect_pending = true;
    s_reconnect_attempt = 0;

    /*
     * Primer intento: esperar intervalo inicial (10s) antes de intentar.
     * Esto da tiempo a que la red se estabilice.
     */
    uint32_t first_interval = wifi_manager_calc_backoff_interval(1);
    uint64_t first_interval_us = (uint64_t)first_interval * 1000000ULL;

    ESP_LOGI(TAG, "Iniciando secuencia de reconexión (primer intento en %" PRIu32 "s)",
             first_interval);

    esp_timer_stop(s_reconnect_timer);
    esp_err_t err = esp_timer_start_once(s_reconnect_timer, first_interval_us);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error iniciando timer de reconexión: %s", esp_err_to_name(err));
        s_reconnect_pending = false;
    }
}

/* ─── Handler de eventos Wi-Fi ──────────────────────────────────────── */

/**
 * Handler de eventos Wi-Fi y IP.
 *
 * Gestiona transiciones de conexión/desconexión con backoff exponencial.
 * En desconexión: inicia timer de reconexión.
 * En reconexión (IP obtenida): detiene timer, reset backoff, flush buffer.
 */
static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                ESP_LOGI(TAG, "Wi-Fi STA iniciado, intentando conexión...");
                esp_wifi_connect();
                break;

            case WIFI_EVENT_STA_DISCONNECTED:
                ESP_LOGW(TAG, "Wi-Fi desconectado");
                s_wifi_connected = false;
                xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);

                /*
                 * No llamar esp_wifi_connect() inmediatamente.
                 * Iniciar secuencia de backoff exponencial (Req 10.2).
                 * La recolección CSI continúa independientemente (Req 10.1).
                 */
                start_reconnect_sequence();
                break;

            default:
                break;
        }
    } else if (event_base == IP_EVENT) {
        if (event_id == IP_EVENT_STA_GOT_IP) {
            ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
            ESP_LOGI(TAG, "Wi-Fi conectado, IP: " IPSTR, IP2STR(&event->ip_info.ip));

            s_wifi_connected = true;
            xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);

            /* Detener timer de reconexión y resetear backoff */
            if (s_reconnect_timer != NULL) {
                esp_timer_stop(s_reconnect_timer);
            }
            s_reconnect_pending = false;

            if (s_reconnect_attempt > 0) {
                ESP_LOGI(TAG, "Reconexión exitosa tras %" PRIu32 " intentos",
                         s_reconnect_attempt);
            }
            s_reconnect_attempt = 0;

            /* Flush del buffer de lecturas retenidas durante desconexión */
            flush_wifi_buffer();
        }
    }
}

/* ─── API pública ───────────────────────────────────────────────────── */

esp_err_t wifi_manager_init(void)
{
    /* Crear grupo de eventos */
    s_wifi_event_group = xEventGroupCreate();
    if (s_wifi_event_group == NULL) {
        ESP_LOGE(TAG, "Error creando grupo de eventos Wi-Fi");
        return ESP_FAIL;
    }

    /* Inicializar buffer circular */
    wifi_reading_buffer_init(&s_wifi_buffer);

    /* Crear mutex para el buffer */
    s_buffer_mutex = xSemaphoreCreateMutex();
    if (s_buffer_mutex == NULL) {
        ESP_LOGE(TAG, "Error creando mutex del buffer Wi-Fi");
        vEventGroupDelete(s_wifi_event_group);
        s_wifi_event_group = NULL;
        return ESP_FAIL;
    }

    /* Crear timer de reconexión (one-shot, reprogramado en cada intento) */
    const esp_timer_create_args_t timer_args = {
        .callback = reconnect_timer_callback,
        .arg = NULL,
        .name = "wifi_reconnect",
    };

    esp_err_t err = esp_timer_create(&timer_args, &s_reconnect_timer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error creando timer de reconexión: %s", esp_err_to_name(err));
        vSemaphoreDelete(s_buffer_mutex);
        s_buffer_mutex = NULL;
        vEventGroupDelete(s_wifi_event_group);
        s_wifi_event_group = NULL;
        return ESP_FAIL;
    }

    /* Inicializar stack TCP/IP y event loop */
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    /* Configuración Wi-Fi por defecto */
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    /* Registrar handlers de eventos */
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    /* Configurar modo STA */
    wifi_config_t wifi_config = { 0 };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    s_wifi_connected = false;
    s_reconnect_attempt = 0;
    s_reconnect_pending = false;

    ESP_LOGI(TAG, "Gestor Wi-Fi inicializado:");
    ESP_LOGI(TAG, "  Backoff inicial: %ds", WIFI_RECONNECT_INITIAL_INTERVAL_S);
    ESP_LOGI(TAG, "  Backoff máximo: %ds", WIFI_RECONNECT_MAX_INTERVAL_S);
    ESP_LOGI(TAG, "  Buffer offline: %d lecturas", WIFI_BUFFER_MAX_READINGS);

    return ESP_OK;
}

bool wifi_manager_is_connected(void)
{
    return s_wifi_connected;
}

esp_err_t wifi_manager_buffer_reading(const motion_reading_t *reading)
{
    if (reading == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_buffer_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_buffer_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        wifi_reading_buffer_push(&s_wifi_buffer, reading);
        xSemaphoreGive(s_buffer_mutex);

        ESP_LOGD(TAG, "Lectura almacenada en buffer Wi-Fi (%u/%u)",
                 s_wifi_buffer.count, WIFI_BUFFER_MAX_READINGS);
        return ESP_OK;
    }

    ESP_LOGW(TAG, "No se pudo adquirir mutex para almacenar lectura");
    return ESP_FAIL;
}

uint16_t wifi_manager_get_buffer_count(void)
{
    return s_wifi_buffer.count;
}

uint32_t wifi_manager_get_reconnect_attempt(void)
{
    return s_reconnect_attempt;
}

void wifi_manager_deinit(void)
{
    /* Detener timer de reconexión */
    if (s_reconnect_timer != NULL) {
        esp_timer_stop(s_reconnect_timer);
        esp_timer_delete(s_reconnect_timer);
        s_reconnect_timer = NULL;
    }

    /* Liberar mutex */
    if (s_buffer_mutex != NULL) {
        vSemaphoreDelete(s_buffer_mutex);
        s_buffer_mutex = NULL;
    }

    /* Liberar grupo de eventos */
    if (s_wifi_event_group != NULL) {
        vEventGroupDelete(s_wifi_event_group);
        s_wifi_event_group = NULL;
    }

    s_wifi_connected = false;
    s_reconnect_attempt = 0;
    s_reconnect_pending = false;

    ESP_LOGI(TAG, "Gestor Wi-Fi detenido y recursos liberados");
}
