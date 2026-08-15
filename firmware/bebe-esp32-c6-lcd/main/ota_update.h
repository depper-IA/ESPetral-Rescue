#ifndef OTA_UPDATE_H
#define OTA_UPDATE_H

/** Módulo OTA: si `ota_url` está vacío, funciones son no-op silencioso. */

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define OTA_TAG               "OTA"
#define OTA_CHECK_PERIOD_US   (60ULL * 60ULL * 1000ULL * 1000ULL)
#define OTA_MANIFEST_TIMEOUT_MS  30000
#define OTA_BINARY_TIMEOUT_MS    120000
#define OTA_MANIFEST_BUF_SIZE    4096
#define OTA_FIELD_MAX_LEN        128
#define OTA_SHA256_HEX_LEN       65

esp_err_t ota_update_init(void);
esp_err_t ota_update_check_now(void);

#ifdef __cplusplus
}
#endif

#endif /* OTA_UPDATE_H */
