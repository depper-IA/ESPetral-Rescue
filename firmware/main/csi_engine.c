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
 * Umbral de varianza relativa (coeficiente de variación al cuadrado CV²) para
 * la normalización sigmoide.
 *
 * Al usar varianza relativa (CV² = varianza / media²), la métrica es adimensional
 * e independiente de la ganancia AGC del receptor Wi-Fi (evita la saturación
 * diferencial entre nodos con AGC de 47 vs 54).
 *
 * Un CV² de ~0.025 (fluctuación relativa de ~15.8%) representa movimiento moderado.
 * f(cv2) = 1 - exp(-cv2 / 0.025f) produce ~0.632 para CV²=0.025 y se acerca
 * a 0.0 en reposo (CV² ~ 0.002 -> p ~ 0.076).
 */
#define CV2_THRESHOLD 0.025f

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

    /* Última trama CSI cruda recibida (para publicar a pipelines tipo RuView) */
    csi_frame_t last_frame;
    bool has_frame;

    /* Calibración de línea base de ruido ambiente */
    bool calibrating;              /* Indica si el motor está calibrando */
    uint16_t calib_samples_target; /* Número de muestras de cálculo para promediar la línea base */
    uint16_t calib_samples_count;  /* Muestras acumuladas hasta el momento */
    float calib_cv2_sum;           /* Suma de CV² acumulada en calibración */
    float baseline_cv2;            /* Piso de ruido ambiental calibrado */
    bool is_calibrated;            /* Indica si la línea base fue estabilizada */

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
    s_state.has_frame = false;

    /* Iniciar auto-calibración de línea base por defecto (10 muestras de cálculo = ~20s) */
    s_state.calibrating = true;
    s_state.calib_samples_target = 10;
    s_state.calib_samples_count = 0;
    s_state.calib_cv2_sum = 0.0f;
    s_state.baseline_cv2 = 0.0f;
    s_state.is_calibrated = false;

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

    /* Guardar copia de la trama cruda para get_last_frame().
     * Copia la estructura completa (264 bytes) — no atómico en arquitecturas
     * de 32 bits, pero el patrón producttor/único-consumidor asume que la
     * ventana entre llamadas es mucho mayor que la copia. */
    s_state.last_frame = *frame;
    s_state.has_frame = true;

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
 * Calcular la varianza relativa (coeficiente de variación al cuadrado CV²)
 * de una subportadora sobre la ventana deslizante.
 *
 * CV² = varianza / (media²)
 *
 * Normaliza por el nivel de señal medio de la subportadora para cancelar
 * la ganancia de amplificación (AGC) y evitar saturaciones en receptores
 * con alta sensibilidad.
 *
 * @param subcarrier_idx Índice de la subportadora (0..63)
 * @param[out] out_active Retorna true si la subportadora tiene señal activa (media >= 1.0)
 * @return Coeficiente de variación al cuadrado CV²
 */
static float compute_subcarrier_cv2(uint16_t subcarrier_idx, bool *out_active)
{
    float sum = 0.0f;
    for (uint16_t i = 0; i < s_state.window_size; i++) {
        sum += s_state.window_buffer[i][subcarrier_idx];
    }
    float mean = sum / (float)s_state.window_size;

    /* Descartar subportadoras nulas o de guarda (sin energía útil) */
    if (mean < 1.0f) {
        if (out_active) *out_active = false;
        return 0.0f;
    }

    if (out_active) *out_active = true;

    float variance_sum = 0.0f;
    for (uint16_t i = 0; i < s_state.window_size; i++) {
        float diff = s_state.window_buffer[i][subcarrier_idx] - mean;
        variance_sum += diff * diff;
    }
    float variance = variance_sum / (float)s_state.window_size;

    return variance / (mean * mean);
}

/**
 * Normalizar el CV² promedio a [0.0, 1.0] usando función exponencial.
 *
 * f(cv2) = 1 - exp(-cv2 / CV2_THRESHOLD)
 *
 * Propiedades:
 *   - f(0) = 0 (sin movimiento → probabilidad 0)
 *   - f(∞) → 1 (movimiento fuerte → probabilidad ~1)
 *   - Monótonamente creciente
 *   - Independiente del AGC y nivel absoluto de ganancia
 */
static float normalize_cv2(float avg_cv2)
{
    if (avg_cv2 <= 0.0f) {
        return 0.0f;
    }

    float probability = 1.0f - expf(-avg_cv2 / CV2_THRESHOLD);

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

    /* Calcular CV² promedio de las subportadoras activas */
    float total_cv2 = 0.0f;
    uint16_t active_sc_count = 0;

    for (uint16_t sc = 0; sc < CSI_NUM_SUBCARRIERS; sc++) {
        bool is_active = false;
        float cv2 = compute_subcarrier_cv2(sc, &is_active);
        if (is_active) {
            total_cv2 += cv2;
            active_sc_count++;
        }
    }

    float avg_cv2 = (active_sc_count > 0) ? (total_cv2 / (float)active_sc_count) : 0.0f;

    float motion_prob = 0.0f;

    /* Proceso de auto-calibración de línea base ambiente (habitacion vacía) */
    if (s_state.calibrating) {
        s_state.calib_cv2_sum += avg_cv2;
        s_state.calib_samples_count++;

        if (s_state.calib_samples_count < s_state.calib_samples_target) {
            ESP_LOGI(TAG, "Calibrando piso de ruido ambiente (%d/%d): CV2_sample=%.6f",
                     s_state.calib_samples_count, s_state.calib_samples_target, avg_cv2);
            motion_prob = 0.0f;
        } else {
            s_state.baseline_cv2 = s_state.calib_cv2_sum / (float)s_state.calib_samples_target;
            s_state.calibrating = false;
            s_state.is_calibrated = true;
            ESP_LOGI(TAG, "Línea base calibrada exitosamente: CV2_baseline=%.6f",
                     s_state.baseline_cv2);
            motion_prob = 0.0f;
        }
    } else {
        /* Restar piso de ruido calibrado para obtener fluctuación neta */
        float net_cv2 = avg_cv2 - s_state.baseline_cv2;
        if (net_cv2 < 0.0f) {
            net_cv2 = 0.0f;
        }
        /* Normalizar a [0.0, 1.0] */
        motion_prob = normalize_cv2(net_cv2);
    }

    /* Poblar la lectura resultante */
    reading->motion_probability = motion_prob;
    reading->timestamp_ms = esp_timer_get_time() / 1000; /* us → ms */
    strncpy(reading->zone_id, s_state.zone_id, sizeof(reading->zone_id) - 1);
    reading->zone_id[sizeof(reading->zone_id) - 1] = '\0';
    strncpy(reading->node_id, s_state.node_id, sizeof(reading->node_id) - 1);
    reading->node_id[sizeof(reading->node_id) - 1] = '\0';

    /* RSSI (Req 19.1): se toma de la ultima trama cruda recibida por
     * csi_engine_feed_frame() (s_state.last_frame), siguiendo el mismo
     * patron que zone_id/node_id (copia desde estado interno del motor,
     * no desde la ventana deslizante de amplitudes). has_frame siempre es
     * true en este punto porque feed_frame() lo marca en la misma llamada
     * que hace crecer sample_count hasta llenar la ventana; el chequeo
     * defensivo evita leer memoria no inicializada si esa invariante
     * cambiara en el futuro. */
    reading->rssi = s_state.has_frame ? s_state.last_frame.rssi : 0;

    /* Guardar copia interna */
    memcpy(&s_state.last_reading, reading, sizeof(motion_reading_t));
    s_state.has_reading = true;

    ESP_LOGD(TAG, "motion_probability=%.4f (avg_cv2=%.6f, activas=%d)",
             motion_prob, avg_cv2, active_sc_count);

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

esp_err_t csi_engine_get_last_frame(csi_frame_t *frame)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (frame == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_state.has_frame) {
        return ESP_ERR_NOT_FOUND;
    }

    memcpy(frame, &s_state.last_frame, sizeof(csi_frame_t));
    return ESP_OK;
}

const char *csi_engine_get_zone_id(void)
{
    if (!s_state.initialized) {
        return NULL;
    }
    return s_state.zone_id;
}

const char *csi_engine_get_node_id(void)
{
    if (!s_state.initialized) {
        return NULL;
    }
    return s_state.node_id;
}

esp_err_t csi_engine_start_calibration(uint16_t duration_sec)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Muestras necesarias a razón de 1 cálculo cada 2 segundos */
    uint16_t samples = (duration_sec > 0) ? (duration_sec / 2) : 10;
    if (samples == 0) samples = 1;

    s_state.calibrating = true;
    s_state.calib_samples_target = samples;
    s_state.calib_samples_count = 0;
    s_state.calib_cv2_sum = 0.0f;
    s_state.is_calibrated = false;

    ESP_LOGI(TAG, "Auto-calibración de línea base iniciada: %d segundos (%d muestras)",
             duration_sec, samples);

    return ESP_OK;
}

bool csi_engine_is_calibrating(void)
{
    return s_state.initialized && s_state.calibrating;
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
