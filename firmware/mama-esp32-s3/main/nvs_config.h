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
 * GPIO pin for onboard LED.
 *
 * Símbolo Kconfig real: CONFIG_CALI_LED_GPIO (definido en
 * `main/Kconfig.projbuild`, symbol CALI_LED_GPIO). El default por
 * chip se establece en `sdkconfig.defaults.<target>`:
 *
 *   - ESP32-C3 (DevKitM-1, Super Mini): GPIO 8
 *   - ESP32-C6 (Super Mini):            GPIO 8
 *   - ESP32-S3 (Zero/Super Mini):       GPIO 21
 *   - ESP32-S3 (DevKitC-1 RGB):         GPIO 48 (requiere driver WS2812)
 *
 * Override runtime via build flag:  idf.py -DCONFIG_CALI_LED_GPIO=21 build
 *
 * NO se define un fallback `#ifndef` aquí a propósito: si el símbolo
 * Kconfig no está presente, el build debe fallar en compilación en vez
 * de caer silenciosamente en un GPIO por defecto que puede no existir
 * en la placa real (regla 4.3 del proyecto — fallar explícito, nunca
 * default silencioso). El símbolo tiene su propio `default` en el
 * Kconfig, así que solo falta si alguien rompe esa definición.
 */

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
 *   - mqtt_broker_host: FALLBACK del broker MQTT (IP/hostname). Sigue siendo
 *     obligatorio (boot halts si está vacío), pero ya NO es la fuente
 *     primaria: main.c intenta resolver el backend por mDNS
 *     ("cali-backend.local") antes de usar este valor. Solo se usa si la
 *     resolución mDNS falla (timeout o servicio no encontrado) — cubre el
 *     caso de una red sin soporte mDNS. Ver Feature A en main.c.
 *   - mqtt_token: pre-shared authentication token
 *   - wifi_ssid: non-empty SSID of the Wi-Fi network the node must join.
 *     Sin esto el nodo nunca puede conectarse (ver wifi_manager.c).
 *
 * Optional fields (use defaults if missing):
 *   - mqtt_broker_port: defaults to 8883
 *   - csi_tx_rate: frames per second, defaults to 20
 *   - window_size: sliding window samples, defaults to 40
 *   - node_id: unique node identifier (generated from MAC if missing)
 *   - wifi_password: cadena vacía si ausente. Una red abierta (hotspot de
 *     campo sin password) es un escenario legítimo, así que la ausencia
 *     de este campo NO invalida la configuración.
 */
typedef struct {
    char zone_id[65];
    char mqtt_broker_host[128];
    uint16_t mqtt_broker_port;
    char mqtt_token[128];
    uint8_t csi_tx_rate;
    uint16_t window_size;
    char node_id[65];
    char wifi_ssid[33];     /* SSID 802.11: 32 chars max + NUL */
    char wifi_password[65]; /* WPA2-PSK: 63 chars max + NUL */
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
 * Devuelve la URL base de OTA leída de NVS. Vacía si ausente.
 * Cadena vacía significa "OTA deshabilitada" (no-op silencioso).
 */
const char *nvs_config_get_ota_url(void);

/**
 * Devuelve la versión de firmware actual. Vacía hasta primer OTA exitoso.
 */
const char *nvs_config_get_fw_version(void);

/**
 * Persiste la versión en NVS. Llamada por ota_update tras un flash exitoso.
 */
esp_err_t nvs_config_set_fw_version(const char *version);

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

/**
 * Persiste credenciales Wi-Fi (y opcionalmente el host MQTT de fallback)
 * en NVS. Usada por el portal de configuración (wifi_provisioning.c) al
 * recibir un POST válido del formulario de aprovisionamiento en campo.
 *
 * Sigue el mismo patrón de apertura/escritura/commit/cierre que
 * nvs_config_set_fw_version().
 *
 * @param[in] ssid       SSID nuevo (obligatorio, no puede ser NULL ni vacío).
 * @param[in] password   Password nuevo (cadena vacía es válida: red abierta).
 * @param[in] mqtt_host  Host MQTT de fallback nuevo (opcional). Si es NULL o
 *                        cadena vacía, no se sobreescribe el valor existente
 *                        en NVS — el operador puede dejarlo en blanco y
 *                        confiar en la resolución mDNS (Feature A).
 * @return ESP_OK en éxito, ESP_ERR_INVALID_ARG si ssid es NULL o vacío,
 *         u otro código de error de NVS si falla la escritura/commit.
 */
esp_err_t nvs_config_write_wifi_credentials(const char *ssid, const char *password,
                                             const char *mqtt_host);

#ifdef __cplusplus
}
#endif

#endif /* NVS_CONFIG_H */
