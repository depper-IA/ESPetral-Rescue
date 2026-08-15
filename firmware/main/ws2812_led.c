/**
 * @file ws2812_led.c
 * @brief Driver WS2812 via esp_driver_rmt (canal TX + simple encoder).
 *
 * Implementa el protocolo WS2812 (800 kHz) sobre un canal RMT TX:
 *   Bit 0:   T0H = 0.3 us, T0L = 0.9 us (codificacion NRZ)
 *   Bit 1:   T1H = 0.9 us, T1L = 0.3 us
 *   Reset:   linea baja por >= 50 us
 *   Trama:   24 bits en orden GRB (G7..G0, R7..R0, B7..B0), MSB primero
 *
 * Hardware destino:
 *   ESP32-S3 Zero / Super Mini, onboard LED en GPIO 21
 *   (simbolo Kconfig CONFIG_CALI_LED_GPIO, ver
 *   firmware/sdkconfig.defaults.esp32s3).
 *
 * Diseno:
 *   - Canal RMT a 10 MHz (1 tick = 0.1 us). WS2812 exige precision
 *     de +/- 150 ns en T0H/T0L/T1H/T1L; con 100 ns por tick holgura
 *     suficiente para los 3 targets (S3, C6, C3).
 *   - 64 simbolos por bloque RMT (suficiente para 1 LED + reset: 24
 *     bits × 1 simbolo + 1 reset = 25 simbolos).
 *   - Encoder "simple" con callback que codifica byte-a-byte y al
 *     final emite el reset. Misma estrategia que el ejemplo oficial
 *     `examples/peripherals/rmt/led_strip_simple_encoder` de ESP-IDF
 *     v5.3.1.
 *   - Sin DMA: con un solo LED la cantidad de simbolos esta holgada.
 *     DMA solo aporta beneficio en tiras con muchos LEDs donde los
 *     bloques RMT不足以 cargar la trama.
 *   - Cache de ultimo color: si set_rgb() recibe el mismo color que
 *     el previo, no retransmite — ahorra tiempo de bus y no satura la
 *     cola de transacciones RMT cuando el codigo de aplicacion llama
 *     repetidamente con el mismo valor.
 *
 * Por que esp_driver_rmt directo (no componente led_strip):
 *   En ESP-IDF v5.3.1 el componente `led_strip` no esta dentro de
 *   `components/` — viene como managed component externo. La forma
 *   mas portable y reproducible es usar el patron ya probado en el
 *   ejemplo oficial: `rmt_new_tx_channel` + `rmt_new_simple_encoder`
 *   con un callback que codifica el protocolo a mano.
 */

#include "ws2812_led.h"

#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"
#include "esp_log.h"

static const char *TAG = "ws2812_led";

/* Resolucion del RMT: 10 MHz -> 1 tick = 0.1 us. */
#define WS2812_RMT_RESOLUTION_HZ   10000000

/* Memoria RMT (simbolos). Suficiente para 1 LED + reset (25 simbolos).
 * Debe ser par segun el driver. 64 = margen amplio sin desperdiciar
 * memoria del SoC (un solo bloque). */
#define WS2812_RMT_MEM_SYMBOLS     64

/* Bytes por LED en orden GRB (WS2812). */
#define WS2812_BYTES_PER_LED       3

/* Tiempo de reset segun datasheet WS2812.
 *
 * Usamos 280 us (el "power-on reset" minimo del datasheet) en lugar del
 * 50 us "latch reset" minimo porque algunas placas (notablemente las
 * S3 Zero / Super Mini con chip WS2812 que vienes driving desde el
 * firmware anterior con gpio_set_level) arrancan con el LED latched en
 * un color arbitrario (tipicamente rojo fijo). Un reset corto de 50 us
 * NO basta para sacarlo de ese estado; el integrado necesita ver la
 * linea baja por >= 280 us para entrar en estado conocido y aceptar
 * la primera trama.
 *
 * Costo: cada transmision dura ~230 us mas (vs 50 us). Para 5 Hz es
 * 1.15 ms/seg de tiempo de CPU. Despreciable.
 */
#define WS2812_RESET_US            280

/* Tiempos nominales del bit (en us). Tolerancia del integrado: +/- 150 ns.
 * Con 100 ns/tick y los valores elegidos, los simbolos quedan holgados. */
#define WS2812_T0H_US              0.3f
#define WS2812_T0L_US              0.9f
#define WS2812_T1H_US              0.9f
#define WS2812_T1L_US              0.3f

/* Estado del modulo. */
static struct {
    bool initialized;
    rmt_channel_handle_t tx_chan;
    rmt_encoder_handle_t encoder;
    uint8_t last_r;
    uint8_t last_g;
    uint8_t last_b;
} s_state = {
    .initialized = false,
    .tx_chan = NULL,
    .encoder = NULL,
    .last_r = 0xFF,   /* sentinel: garantiza que la 1ra transmision ocurra */
    .last_g = 0xFF,
    .last_b = 0xFF,
};

/* Simbolos precomputados para bit-0, bit-1, y reset. */
static rmt_symbol_word_t s_ws2812_zero;
static rmt_symbol_word_t s_ws2812_one;
static rmt_symbol_word_t s_ws2812_reset;

/* Buffer de envio: GRB (3 bytes para 1 LED). */
static uint8_t s_tx_buffer[WS2812_BYTES_PER_LED];

/**
 * Codifica bytes del payload en simbolos RMT segun el protocolo WS2812.
 *
 * El driver RMT llama a este callback repetidamente mientras tenga
 * espacio libre en el buffer de simbolos. La posicion en el payload
 * se deduce de `symbols_written / 8` (cada byte = 8 simbolos). Cuando
 * se termina el payload emite el reset y marca *done=true.
 */
static size_t ws2812_encode_cb(const void *data, size_t data_size,
                                size_t symbols_written, size_t symbols_free,
                                rmt_symbol_word_t *symbols, bool *done, void *arg)
{
    (void)arg;

    /* Necesitamos 8 espacios para codificar un byte, o 1 si ya
     * terminamos y vamos por el reset. */
    if (symbols_free < 8) {
        return 0;
    }

    const uint8_t *bytes = (const uint8_t *)data;
    size_t byte_pos = symbols_written / 8;

    if (byte_pos < data_size) {
        /* Codifica un byte (MSB primero, como exige WS2812). */
        size_t i = 0;
        for (int mask = 0x80; mask != 0; mask >>= 1) {
            if (bytes[byte_pos] & mask) {
                symbols[i++] = s_ws2812_one;
            } else {
                symbols[i++] = s_ws2812_zero;
            }
        }
        return i;
    }

    /* Payload completo: emite reset y marca fin de transaccion. */
    symbols[0] = s_ws2812_reset;
    *done = true;
    return 1;
}

/**
 * Convierte duracion en microsegundos a ticks RMT a 10 MHz.
 * Multiplica por 10 (resolution_hz / 1MHz) y redondea al entero mas
 * cercano para minimizar error acumulado.
 */
static inline uint32_t us_to_ticks(float us)
{
    /* resolucion = 10 MHz => 1 us = 10 ticks */
    return (uint32_t)(us * 10.0f + 0.5f);
}

esp_err_t ws2812_led_init(void)
{
    if (s_state.initialized) {
        return ESP_OK; /* idempotente */
    }

    /* Precomputa los simbolos de bit-0, bit-1 y reset.
     * El reset es 50 us simetricos (mitad high + mitad low) — coincide
     * con el ejemplo oficial y basta para que el integrado latchee. */
    s_ws2812_zero.level0 = 1;
    s_ws2812_zero.duration0 = us_to_ticks(WS2812_T0H_US);
    s_ws2812_zero.level1 = 0;
    s_ws2812_zero.duration1 = us_to_ticks(WS2812_T0L_US);

    s_ws2812_one.level0 = 1;
    s_ws2812_one.duration0 = us_to_ticks(WS2812_T1H_US);
    s_ws2812_one.level1 = 0;
    s_ws2812_one.duration1 = us_to_ticks(WS2812_T1L_US);

    s_ws2812_reset.level0 = 1;
    s_ws2812_reset.duration0 = us_to_ticks(WS2812_RESET_US / 2.0f);
    s_ws2812_reset.level1 = 0;
    s_ws2812_reset.duration1 = us_to_ticks(WS2812_RESET_US / 2.0f);

    /* Canal RMT TX en el GPIO del LED. */
    rmt_tx_channel_config_t tx_cfg = {
        .gpio_num = (gpio_num_t)CONFIG_CALI_LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = WS2812_RMT_RESOLUTION_HZ,
        .mem_block_symbols = WS2812_RMT_MEM_SYMBOLS,
        .trans_queue_depth = 4,
        .flags = {
            .invert_out = 0,
            .with_dma = 0,
            .io_loop_back = 0,
            .io_od_mode = 0,
        },
    };
    esp_err_t err = rmt_new_tx_channel(&tx_cfg, &s_state.tx_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_tx_channel(GPIO=%d) fallo: %s",
                 CONFIG_CALI_LED_GPIO, esp_err_to_name(err));
        return ESP_FAIL;
    }

    /* Encoder con callback que codifica GRB + reset. */
    rmt_simple_encoder_config_t enc_cfg = {
        .callback = ws2812_encode_cb,
        .arg = NULL,
        .min_chunk_size = 0, /* default 64 (suficiente para nuestros 3 bytes) */
    };
    err = rmt_new_simple_encoder(&enc_cfg, &s_state.encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_simple_encoder fallo: %s", esp_err_to_name(err));
        rmt_del_channel(s_state.tx_chan);
        s_state.tx_chan = NULL;
        return ESP_FAIL;
    }

    err = rmt_enable(s_state.tx_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_enable fallo: %s", esp_err_to_name(err));
        rmt_del_encoder(s_state.encoder);
        rmt_del_channel(s_state.tx_chan);
        s_state.encoder = NULL;
        s_state.tx_chan = NULL;
        return ESP_FAIL;
    }

    s_state.initialized = true;

    /* Apagado inicial robusto: emite 5 tramas de negro consecutivas con
     * reset 280us entre cada una. Esto fuerza al integrado a salir de
     * cualquier estado latched por senales previas no-protocolo (ej: el
     * firmware anterior usaba gpio_set_level sobre este GPIO, lo que
     * deja el WS2812 con un color arbitrario que un solo frame no
     * siempre logra sobrescribir). Cada ws2812_led_off() ya incluye el
     * reset 280us al final, asi que con 5 envios garantizamos al menos
     * 1.4 ms de linea baja acumulada y 5 frames validos. */
    for (int i = 0; i < 5; i++) {
        esp_err_t off_err = ws2812_led_off();
        if (off_err != ESP_OK) {
            ESP_LOGW(TAG, "Apagado inicial #%d fallo (no fatal): %s",
                     i + 1, esp_err_to_name(off_err));
        }
    }

    ESP_LOGI(TAG, "WS2812 listo en GPIO %d (RMT TX @%.1f MHz, %d sim/buf, GRB)",
             CONFIG_CALI_LED_GPIO,
             (float)WS2812_RMT_RESOLUTION_HZ / 1000000.0f,
             WS2812_RMT_MEM_SYMBOLS);
    return ESP_OK;
}

esp_err_t ws2812_led_set_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    if (!s_state.initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Cache: si el color no cambio, no retransmitir. */
    if (r == s_state.last_r && g == s_state.last_g && b == s_state.last_b) {
        return ESP_OK;
    }

    /* WS2812 espera los bytes en orden G, R, B (no RGB).
     * Es un detalle sutil pero critico: si se envia en orden RGB
     * se intercambian los canales G y R, lo que lleva a colores
     * completamente distintos. */
    s_tx_buffer[0] = g;
    s_tx_buffer[1] = r;
    s_tx_buffer[2] = b;

    rmt_transmit_config_t tx_cfg = {
        .loop_count = 0,
        .flags = {0},
    };
    esp_err_t err = rmt_transmit(s_state.tx_chan, s_state.encoder,
                                  s_tx_buffer, sizeof(s_tx_buffer),
                                  &tx_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_transmit fallo: %s", esp_err_to_name(err));
        return err;
    }

    /* Espera fin de transmision: el reset (50 us) debe completarse
     * para que el WS2812 latchee el color. Timeout 100 ms es muy
     * generoso (caso real ~ 60-80 us para 3 bytes + reset). */
    err = rmt_tx_wait_all_done(s_state.tx_chan, 100);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_tx_wait_all_done fallo: %s", esp_err_to_name(err));
        return err;
    }

    s_state.last_r = r;
    s_state.last_g = g;
    s_state.last_b = b;
    return ESP_OK;
}

esp_err_t ws2812_led_off(void)
{
    return ws2812_led_set_rgb(0, 0, 0);
}
