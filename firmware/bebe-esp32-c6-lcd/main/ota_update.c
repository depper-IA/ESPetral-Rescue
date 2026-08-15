/**
 * @file ota_update.c
 * @brief Verificación periódica y descarga OTA para CALI CSI Node.
 *
 * Flujo: GET manifest (30s) → comparar versión → descargar binario (120s)
 * → verificar SHA-256 → escribir partición OTA → reiniciar.
 *
 * Offline-first: si `ota_url` está vacío, las funciones son no-op silencioso.
 * Requiere `nvs_config_read()` previo para tener `ota_url` disponible.
 */

#include "ota_update.h"
#include "nvs_config.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_http_client.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "mbedtls/sha256.h"

#define OTA_VERSION_UNKNOWN "0.0.0"

typedef struct {
    char version[OTA_FIELD_MAX_LEN];
    char binary_url[OTA_FIELD_MAX_LEN + 64];
    uint32_t binary_size;
    char sha256[OTA_SHA256_HEX_LEN];
} ota_manifest_t;

static const char *TAG = OTA_TAG;
static esp_timer_handle_t s_ota_timer = NULL;
static volatile bool s_running = false;

/* Extrae "k":"v" de JSON plano. Retorna true si encuentra el campo. */
static bool json_str(const char *j, const char *k, char *out, size_t n)
{
    char p[64]; snprintf(p, sizeof(p), "\"%s\":\"", k);
    const char *s = strstr(j, p);
    if (!s) return false;
    s += strlen(p);
    const char *e = strchr(s, '"');
    if (!e) return false;
    size_t l = (size_t)(e - s);
    if (l >= n) l = n - 1;
    memcpy(out, s, l); out[l] = '\0'; return true;
}

static bool json_u32(const char *j, const char *k, uint32_t *out)
{
    char p[64]; snprintf(p, sizeof(p), "\"%s\":", k);
    const char *s = strstr(j, p);
    if (!s) return false;
    s += strlen(p);
    while (*s == ' ' || *s == '\t') s++;
    char *end = NULL;
    unsigned long v = strtoul(s, &end, 10);
    if (end == s) return false;
    *out = (uint32_t)v; return true;
}

/* Compara "X.Y.Z": -1 / 0 / 1. Fallback strcmp si no parsea. */
static int vercmp(const char *a, const char *b)
{
    if (!a || !b) return 0;
    int a1,a2,a3,b1,b2,b3;
    int pa = sscanf(a,"%d.%d.%d",&a1,&a2,&a3);
    int pb = sscanf(b,"%d.%d.%d",&b1,&b2,&b3);
    if (pa == 3 && pb == 3) {
        if (a1!=b1) return a1>b1?1:-1;
        if (a2!=b2) return a2>b2?1:-1;
        if (a3!=b3) return a3>b3?1:-1;
        return 0;
    }
    int c = strcmp(a,b); return c==0?0:(c>0?1:-1);
}

/* GET HTTP simple. Retorna bytes leídos o -1. */
static int http_get(const char *url, char *buf, size_t buflen, int timeout_ms)
{
    esp_http_client_config_t cfg = {
        .url = url, .timeout_ms = timeout_ms,
        .buffer_size = 1024, .skip_cert_common_name_check = true,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return -1;
    if (esp_http_client_open(c, 0) != ESP_OK) { esp_http_client_cleanup(c); return -1; }
    if (esp_http_client_get_status_code(c) != 200) {
        ESP_LOGE(TAG, "[OTA] HTTP no-200: %s", url);
        esp_http_client_close(c); esp_http_client_cleanup(c); return -1;
    }
    int total = 0, n;
    while (total < (int)(buflen-1) &&
           (n = esp_http_client_read(c, buf+total, buflen-1-total)) > 0)
        total += n;
    buf[total] = '\0';
    esp_http_client_close(c); esp_http_client_cleanup(c);
    return total;
}

static esp_err_t fetch_manifest(const char *ota_url, ota_manifest_t *m)
{
    char url[OTA_FIELD_MAX_LEN + 64];
    snprintf(url, sizeof(url), "%s/firmware/manifest.json", ota_url);
    char buf[OTA_MANIFEST_BUF_SIZE];
    if (http_get(url, buf, sizeof(buf), OTA_MANIFEST_TIMEOUT_MS) <= 0) return ESP_FAIL;
    memset(m, 0, sizeof(*m));
    if (!json_str(buf,"version",m->version,sizeof(m->version)) ||
        !json_str(buf,"binary_url",m->binary_url,sizeof(m->binary_url)) ||
        !json_u32(buf,"binary_size",&m->binary_size) ||
        !json_str(buf,"sha256",m->sha256,sizeof(m->sha256))) {
        ESP_LOGE(TAG, "[OTA] manifest incompleto"); return ESP_FAIL;
    }
    ESP_LOGI(TAG, "[OTA] manifest v=%s size=%u", m->version, (unsigned)m->binary_size);
    return ESP_OK;
}

static void hex32(const uint8_t in[32], char out[OTA_SHA256_HEX_LEN])
{
    static const char h[] = "0123456789abcdef";
    for (int i=0;i<32;i++) { out[i*2]=h[(in[i]>>4)&0xF]; out[i*2+1]=h[in[i]&0xF]; }
    out[64] = '\0';
}

static esp_err_t download_flash(const ota_manifest_t *m)
{
    esp_http_client_config_t cfg = {
        .url = m->binary_url, .timeout_ms = OTA_BINARY_TIMEOUT_MS,
        .buffer_size = 4096, .skip_cert_common_name_check = true,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return ESP_FAIL;
    if (esp_http_client_open(c, 0) != ESP_OK) { esp_http_client_cleanup(c); return ESP_FAIL; }
    if (esp_http_client_get_status_code(c) != 200) {
        ESP_LOGE(TAG, "[OTA] binario HTTP no-200");
        esp_http_client_close(c); esp_http_client_cleanup(c); return ESP_FAIL;
    }
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (!part) {
        ESP_LOGE(TAG, "[OTA] sin partición OTA");
        esp_http_client_close(c); esp_http_client_cleanup(c); return ESP_FAIL;
    }
    esp_ota_handle_t h;
    if (esp_ota_begin(part, m->binary_size, &h) != ESP_OK) {
        esp_http_client_close(c); esp_http_client_cleanup(c); return ESP_FAIL;
    }
    mbedtls_sha256_context sha; mbedtls_sha256_init(&sha); mbedtls_sha256_starts(&sha, 0);
    uint8_t chunk[4096]; int n; bool ok = false;
    while ((n = esp_http_client_read(c, (char *)chunk, sizeof(chunk))) > 0) {
        mbedtls_sha256_update(&sha, chunk, (size_t)n);
        if (esp_ota_write(h, chunk, (size_t)n) != ESP_OK) goto cleanup;
    }
    ok = true;
cleanup:
    esp_http_client_close(c); esp_http_client_cleanup(c);
    if (!ok) { mbedtls_sha256_free(&sha); esp_ota_abort(h); return ESP_FAIL; }

    uint8_t digest[32]; mbedtls_sha256_finish(&sha, digest); mbedtls_sha256_free(&sha);
    char hex[OTA_SHA256_HEX_LEN]; hex32(digest, hex);
    if (strcasecmp(hex, m->sha256) != 0) {
        ESP_LOGE(TAG, "[OTA] SHA mismatch esp=%s calc=%s", m->sha256, hex);
        esp_ota_abort(h); return ESP_FAIL;
    }
    if (esp_ota_end(h) != ESP_OK) { ESP_LOGE(TAG,"[OTA] end"); return ESP_FAIL; }
    if (esp_ota_set_boot_partition(part) != ESP_OK) { ESP_LOGE(TAG,"[OTA] set_boot"); return ESP_FAIL; }
    ESP_LOGI(TAG, "[OTA] actualizado a %s, reiniciando", m->version);
    nvs_config_set_fw_version(m->version);
    esp_restart(); return ESP_OK;
}

static esp_err_t check_and_update(void)
{
    const char *url = nvs_config_get_ota_url();
    if (!url || !*url) return ESP_OK;   /* OTA deshabilitada: no-op silencioso */
    if (s_running) return ESP_OK;
    s_running = true;
    ota_manifest_t m;
    esp_err_t err = fetch_manifest(url, &m);
    if (err != ESP_OK) { s_running = false; return ESP_FAIL; }
    const char *cur = nvs_config_get_fw_version();
    if (!cur || !*cur) cur = OTA_VERSION_UNKNOWN;
    if (vercmp(m.version, cur) <= 0) {
        ESP_LOGI(TAG, "[OTA] actual %s >= %s", cur, m.version);
        s_running = false; return ESP_OK;
    }
    ESP_LOGI(TAG, "[OTA] nueva version %s (actual %s)", m.version, cur);
    err = download_flash(&m);
    s_running = false;
    return err;
}

esp_err_t ota_update_check_now(void) { return check_and_update(); }
static void ota_timer_cb(void *arg) { (void)arg; check_and_update(); }

esp_err_t ota_update_init(void)
{
    esp_timer_create_args_t a = {
        .callback = ota_timer_cb, .arg = NULL,
        .name = "ota_check", .dispatch_method = ESP_TIMER_TASK,
    };
    if (esp_timer_create(&a, &s_ota_timer) != ESP_OK) return ESP_FAIL;
    if (esp_timer_start_periodic(s_ota_timer, OTA_CHECK_PERIOD_US) != ESP_OK) return ESP_FAIL;
    ESP_LOGI(TAG, "[OTA] inicializado, check cada 60 min");
    return ESP_OK;
}
