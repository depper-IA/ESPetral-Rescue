/**
 * @file csi_engine.c
 * @brief Motor de procesamiento CSI — ventana deslizante y cálculo de motion_probability.
 *
 * Recibe tramas CSI (amplitudes de 64 subportadoras), las almacena en un
 * buffer circular y cada vez que la ventana está llena calcula la varianza
 * promedio de las subportadoras, normalizándola al rango [0.0, 1.0].
 *
 * Algoritmo de normalización:
 *   Se aplica una función sigmoide suave: p = 1 - exp(-variance / threshold)
 *   donde threshold es un valor empírico que representa la varianza típica
 *   cuando hay movimiento moderado. Esto garantiza que el resultado siempre
 *   está en [0.0, 1.0] para cualquier varianza >= 0.
 *
 * Requisitos implementados: 9.1, 9.2
 * Propiedad de diseño 11: motion_probability ∈ [0.0, 1.0] para toda entrada.
 */

#include "csi_engine.h"

#include <string.h>
#include <math.h>
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "csi_engine";

/**
 * Umbral de varianza para normalización sigmoide.
 * Valor empírico: una varianza de ~5.0 en las amplitudes de subportadora
 * indica movimiento moderado. La función 1 - exp(-v/threshold) produce
 * ~0.63 con este umbral, ~0.86 para el doble, y se aproxima a 1.0
 * para varianzas altas.
 */
#define VARIANCE_THRESHOLD 5.0f

/**
 * Estado interno del motor CSI.
 */
typedef struct {
    /* Buffer circular: [window_size][CSI_NUM_SUBCARRIERS] */
    float (*window_buffer)[CSI_NUM_SUBCARRIERS];
    uint16_t window_size;       /* Tamaño de la ventana configurada */
    uint16_t sample_count;      /* Muestras totales ingresadas */
    uint16_t write_index;       /* Índice de escritura en el buffer circular */
    bool window_filled;         /* La ventana se llenó al menos una vez */

    /* Configuración */
    uint8_t tx_rate;
    char zone_id[65];
    char node_id[65];

    /* Última lectura calculada */
    motion_reading_t last_reading;
    bool has_reading;

    /* Estado de inicialización */
    bool initialized;
} csi_engine_state_t;

static csi_engine_state_t s_state = { 0 };

esp_err_t csi_engine_init(const csi_engine_config_t *config)
{
    if (config == NULL) {
        ESP_LOGE(TAG, "Configuración nula");
        return ESP_ERR_INVALID_ARG;
    }

    if (config->window_size < 2 || config->window_size > CSI_MAX_WINDOW_SIZE) {
        ESP_LOGE(TAG, "window_size=%d fuera de rango [2, %d]",
                 config->window_size, CSI_MAX_WINDOW_SIZE);
        return ESP_ERR_INVALID_ARG;
    }

    if (config->tx_rate == 0) {
        ESP_LOGE(TAG, "tx_rate no puede ser 0");
        return ESP_ERR_INVALID_ARG;
    }

    /* Liberar si ya estaba inicializado */
    if (s_state.initialized) {
        csi_engine_deinit();
    }

    /* Asignar buffer para la ventana deslizante */
    s_state.window_buffer = (float (*)[CSI_NUM_SUBCARRIERS])calloc(
        config->window_size, sizeof(float[CSI_NUM_SUBCARRIERS]));

    if (s_state.window_buffer == NULL) {
        ESP_LOGE(TAG, "Error asignando memoria para ventana (%d × %d floats)",
                 config->window_size, CSI_NUM_SUBCARRIERS);
        return ESP_ERR_NO_MEM;
    }

    s_state.window_size = config->window_size;
    s_state.tx_rate = config->tx_rate;
    s_state.sample_count = 0;
    s_state.write_index = 0;
    s_state.window_filled = false;
    s_state.has_reading = false;

    strncpy(s_state.zone_id, config->zone_id, sizeof(s_state.zone_id) - 1);
    s_state.zone_id[sizeof(s_state.zone_id) - 1] = '\0';
    strncpy(s_state.node_id, config->node_id, sizeof(s_state.node_id) - 1);
    s_state.node_id[sizeof(s_state.node_id) - 1] = '\0';

    s_state.initialized = true;

    ESP_LOGI(TAG, "Motor CSI inicializado: ventana=%d muestras, tasa=%d fps",
             config->window_size, config->tx_rate);
    ESP_LOGI(TAG, "  zona='%s', nodo='%s'", s_state.zone_id, s_state.node_id);

    return ESP_OK;
}

esp_err_t csi_engine_feed_frame(const csi_frame_t *frame)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Copiar amplitudes al buffer circular en la posición actual */
    memcpy(s_state.window_buffer[s_state.write_index],
           frame->subcarrier_amplitudes,
           sizeof(float) * CSI_NUM_SUBCARRIERS);

    /* Avanzar índice de escritura (circular) */
    s_state.write_index = (s_state.write_index + 1) % s_state.window_size;
    s_state.sample_count++;

    /* Marcar ventana como llena cuando se acumulan suficientes muestras */
    if (!s_state.window_filled && s_state.sample_count >= s_state.window_size) {
        s_state.window_filled = true;
        ESP_LOGI(TAG, "Ventana deslizante llena (%d muestras)", s_state.window_size);
    }

    return ESP_OK;
}

/**
 * Calcular la varianza de una subportadora sobre la ventana deslizante.
 *
 * Usa el algoritmo de dos pasadas: primero calcula la media, luego
 * la suma de desviaciones al cuadrado dividida por N.
 */
static float compute_subcarrier_variance(uint16_t subcarrier_idx)
{
    float sum = 0.0f;
    for (uint16_t i = 0; i < s_state.window_size; i++) {
        sum += s_state.window_buffer[i][subcarrier_idx];
    }
    float mean = sum / (float)s_state.window_size;

    float variance_sum = 0.0f;
    for (uint16_t i = 0; i < s_state.window_size; i++) {
        float diff = s_state.window_buffer[i][subcarrier_idx] - mean;
        variance_sum += diff * diff;
    }

    return variance_sum / (float)s_state.window_size;
}

/**
 * Normalizar varianza promedio a [0.0, 1.0] usando función exponencial.
 *
 * f(v) = 1 - exp(-v / threshold)
 *
 * Propiedades:
 *   - f(0) = 0 (sin movimiento → probabilidad 0)
 *   - f(∞) → 1 (movimiento fuerte → probabilidad ~1)
 *   - Monótonamente creciente
 *   - Siempre en [0.0, 1.0] para v >= 0
 */
static float normalize_variance(float avg_variance)
{
    if (avg_variance <= 0.0f) {
        return 0.0f;
    }

    float probability = 1.0f - expf(-avg_variance / VARIANCE_THRESHOLD);

    /* Clamp defensivo para garantizar propiedad de diseño 11 */
    if (probability < 0.0f) {
        probability = 0.0f;
    }
    if (probability > 1.0f) {
        probability = 1.0f;
    }

    return probability;
}

esp_err_t csi_engine_compute(motion_reading_t *reading)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (reading == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_state.window_filled) {
        return ESP_ERR_NOT_FINISHED;
    }

    /* Calcular varianza promedio de todas las subportadoras */
    float total_variance = 0.0f;
    for (uint16_t sc = 0; sc < CSI_NUM_SUBCARRIERS; sc++) {
        total_variance += compute_subcarrier_variance(sc);
    }
    float avg_variance = total_variance / (float)CSI_NUM_SUBCARRIERS;

    /* Normalizar a [0.0, 1.0] */
    float motion_prob = normalize_variance(avg_variance);

    /* Poblar la lectura resultante */
    reading->motion_probability = motion_prob;
    reading->timestamp_ms = esp_timer_get_time() / 1000; /* us → ms */
    strncpy(reading->zone_id, s_state.zone_id, sizeof(reading->zone_id) - 1);
    reading->zone_id[sizeof(reading->zone_id) - 1] = '\0';
    strncpy(reading->node_id, s_state.node_id, sizeof(reading->node_id) - 1);
    reading->node_id[sizeof(reading->node_id) - 1] = '\0';

    /* Guardar copia interna */
    memcpy(&s_state.last_reading, reading, sizeof(motion_reading_t));
    s_state.has_reading = true;

    ESP_LOGD(TAG, "motion_probability=%.4f (varianza_prom=%.4f)",
             motion_prob, avg_variance);

    return ESP_OK;
}

bool csi_engine_window_full(void)
{
    return s_state.initialized && s_state.window_filled;
}

esp_err_t csi_engine_get_last_reading(motion_reading_t *reading)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (reading == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_state.has_reading) {
        return ESP_ERR_NOT_FOUND;
    }

    memcpy(reading, &s_state.last_reading, sizeof(motion_reading_t));
    return ESP_OK;
}

void csi_engine_deinit(void)
{
    if (s_state.window_buffer != NULL) {
        free(s_state.window_buffer);
        s_state.window_buffer = NULL;
    }

    memset(&s_state, 0, sizeof(csi_engine_state_t));
    ESP_LOGI(TAG, "Motor CSI liberado");
}
