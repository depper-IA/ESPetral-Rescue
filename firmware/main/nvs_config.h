#ifndef NVS_CONFIG_H
#define NVS_CONFIG_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * NVS namespace for CALI node configuration.
 */
#define NVS_NAMESPACE "cali_config"

/**
 * GPIO pin for onboard LED (ESP32-C6 Super Mini).
 * Override via menuconfig or compiler define if board differs.
 */
#ifndef CONFIG_LED_GPIO
#define CONFIG_LED_GPIO 8
#endif

/**
 * Default values for optional configuration parameters.
 */
#define DEFAULT_MQTT_PORT    8883
#define DEFAULT_CSI_TX_RATE  20
#define DEFAULT_WINDOW_SIZE  40

/**
 * Node configuration stored in NVS.
 *
 * Required fields (boot halts if missing/invalid):
 *   - zone_id: non-empty string identifying the rubble zone
 *   - mqtt_broker_host: non-empty string with broker IP/hostname
 *   - mqtt_token: pre-shared authentication token
 *
 * Optional fields (use defaults if missing):
 *   - mqtt_broker_port: defaults to 8883
 *   - csi_tx_rate: frames per second, defaults to 20
 *   - window_size: sliding window samples, defaults to 40
 *   - node_id: unique node identifier (generated from MAC if missing)
 */
typedef struct {
    char zone_id[65];
    char mqtt_broker_host[128];
    uint16_t mqtt_broker_port;
    char mqtt_token[128];
    uint8_t csi_tx_rate;
    uint16_t window_size;
    char node_id[65];
} node_config_t;

/**
 * Read node configuration from NVS.
 *
 * @param[out] config  Pointer to config struct to populate.
 * @return ESP_OK on success, ESP_ERR_NOT_FOUND if required keys are missing,
 *         ESP_ERR_INVALID_ARG if required values are empty strings.
 */
esp_err_t nvs_config_read(node_config_t *config);

/**
 * Validate that required configuration fields are present and non-empty.
 *
 * @param[in] config  Pointer to config struct to validate.
 * @return true if configuration is valid for operation.
 */
bool nvs_config_validate(const node_config_t *config);

/**
 * Enter boot error state: blink LED at 4Hz (125ms toggle) indefinitely.
 * This function never returns. Called when NVS config is missing or invalid.
 *
 * Implements Requirement 9.7:
 *   IF NVS configuration is missing or contains an invalid zone_id (empty string)
 *   or invalid MQTT broker address (empty string) at boot, THEN THE ESP32_Node
 *   SHALL blink its onboard LED in a rapid pattern (4 Hz) continuously and halt
 *   normal operation until valid configuration is provided.
 */
void nvs_config_halt_with_blink(void) __attribute__((noreturn));

#ifdef __cplusplus
}
#endif

#endif /* NVS_CONFIG_H */
