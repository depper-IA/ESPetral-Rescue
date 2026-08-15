#ifndef CALI_MQTT_H
#define CALI_MQTT_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"
#include "csi_engine.h"
#include "nvs_config.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @file cali_mqtt.h
 * @brief Cliente MQTT con autenticación PSK y buffer circular de lecturas.
 *
 * Gestiona la conexión al broker MQTT usando el token PSK almacenado en NVS,
 * implementa un buffer circular de hasta 30 lecturas para cuando el broker
 * no está disponible, y configura Last Will and Testament para notificación
 * de desconexión.
 *
 * Nombre de archivo "cali_mqtt" para evitar conflicto con el header
 * "mqtt_client.h" del componente ESP-MQTT de ESP-IDF.
 *
 * Requisitos implementados: 9.6, 6.5
 */

/** Capacidad máxima del buffer circular de lecturas. */
#define MQTT_BUFFER_MAX_READINGS 30

/** Intervalo de reintento de publicación en milisegundos. */
#define MQTT_RETRY_INTERVAL_MS 10000

/**
 * Buffer circular de lecturas de movimiento.
 *
 * Implementa un buffer FIFO de capacidad fija. Cuando el buffer está lleno
 * y se inserta una nueva lectura, se descarta la más antigua (por timestamp
 * de captura).
 *
 * Propiedad 13: El buffer nunca excede MQTT_BUFFER_MAX_READINGS elementos;
 *              la lectura más antigua (por timestamp) se descarta primero.
 * Propiedad 15: La publicación emite lecturas en orden estrictamente
 *              ascendente de timestamp.
 */
typedef struct {
    motion_reading_t readings[MQTT_BUFFER_MAX_READINGS];
    uint16_t count;
    uint16_t head;  /* Índice de la próxima posición de escritura */
} mqtt_reading_buffer_t;

/**
 * Configuración del cliente MQTT CALI.
 */
typedef struct {
    char broker_host[128];    /* Host del broker MQTT */
    uint16_t broker_port;     /* Puerto del broker */
    char token[128];          /* Token PSK para autenticación (MQTT password) */
    char zone_id[65];         /* ID de zona para tópicos */
    char node_id[65];         /* ID del nodo */
} cali_mqtt_config_t;

/**
 * Inicializar el cliente MQTT CALI.
 *
 * Configura la conexión al broker con autenticación PSK (token como password),
 * prepara el Last Will and Testament en el tópico cali/zone/{zone_id}/status,
 * e inicia la conexión. También arranca el timer de reintento para publicar
 * lecturas almacenadas en buffer.
 *
 * @param[in] config  Configuración del cliente MQTT.
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si config es NULL.
 */
esp_err_t cali_mqtt_init(const cali_mqtt_config_t *config);

/**
 * Publicar una lectura de movimiento al broker MQTT.
 *
 * Si el broker está conectado, publica inmediatamente en
 * cali/zone/{zone_id}/csi con formato JSON. Si no está conectado,
 * almacena la lectura en el buffer circular interno.
 *
 * @param[in] reading  Lectura de movimiento a publicar.
 * @return ESP_OK si se publicó o almacenó exitosamente,
 *         ESP_ERR_INVALID_ARG si reading es NULL.
 */
esp_err_t cali_mqtt_publish_reading(const motion_reading_t *reading);

/**
 * Publica un payload MQTT pre-formateado en un tópico arbitrario.
 *
 * Usado por csi_publisher para enviar mensajes >256 bytes (payloads con
 * arrays de amplitudes) que no caben en el buffer interno de
 * cali_mqtt_publish_reading(). El caller es responsable de formatear el
 * payload y construir el tópico. Si el broker está desconectado, no se
 * almacena en buffer (raw frames se descartan si no hay broker; el buffer
 * sigue siendo para motion_reading_t únicamente).
 *
 * @param[in] topic       Tópico MQTT (no necesita ser propiedad).
 * @param[in] payload     Payload ya formateado (típicamente JSON).
 * @param[in] payload_len Longitud del payload en bytes (sin contar \0).
 * @return ESP_OK en éxito, ESP_ERR_INVALID_STATE si MQTT no está inicializado,
 *         u otro error del cliente MQTT.
 */
esp_err_t cali_mqtt_publish_payload(const char *topic, const char *payload, size_t payload_len);

/**
 * Verificar si el cliente MQTT está conectado al broker.
 *
 * @return true si la conexión MQTT está activa.
 */
bool cali_mqtt_is_connected(void);

/**
 * Obtener el número de lecturas actualmente en el buffer.
 *
 * @return Cantidad de lecturas almacenadas en el buffer circular.
 */
uint16_t cali_mqtt_get_buffer_count(void);

/**
 * Insertar una lectura en el buffer circular.
 *
 * Si el buffer está lleno, descarta la lectura más antigua (head).
 * Función expuesta para testing y uso directo.
 *
 * @param[in,out] buf      Puntero al buffer circular.
 * @param[in]     reading  Lectura a insertar.
 */
void mqtt_reading_buffer_push(mqtt_reading_buffer_t *buf, const motion_reading_t *reading);

/**
 * Extraer la lectura más antigua del buffer (FIFO — orden cronológico).
 *
 * Extrae en orden ascendente de inserción (que corresponde a orden
 * cronológico de timestamp dado que las lecturas se insertan en orden).
 *
 * @param[in,out] buf      Puntero al buffer circular.
 * @param[out]    reading  Puntero donde se copia la lectura extraída.
 * @return true si se extrajo una lectura, false si el buffer estaba vacío.
 */
bool mqtt_reading_buffer_pop(mqtt_reading_buffer_t *buf, motion_reading_t *reading);

/**
 * Inicializar un buffer circular a estado vacío.
 *
 * @param[out] buf  Puntero al buffer a inicializar.
 */
void mqtt_reading_buffer_init(mqtt_reading_buffer_t *buf);

/**
 * Detener y liberar recursos del cliente MQTT.
 */
void cali_mqtt_deinit(void);

#ifdef __cplusplus
}
#endif

#endif /* CALI_MQTT_H */
