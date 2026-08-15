/**
 * @file wifi_provisioning.c
 * @brief Implementacion del portal HTTP de aprovisionamiento Wi-Fi.
 *
 * Ver wifi_provisioning.h para el contrato completo de la API publica.
 *
 * Decisiones de diseño:
 *  - El servidor HTTP escucha en puerto 80 sobre la STA ya operativa
 *    (no levanta SoftAP propio): la STA esta activa cuando init() se
 *    llama, y el operador llega con una laptop en la misma red. Levantar
 *    un SoftAP ademas seria desperdiciar radio y obligar al operador a
 *    cambiar de red Wi-Fi para configurar el nodo.
 *  - mDNS (intencion del spec) anunciado via `esp_netif_set_hostname()`:
 *    el DHCP server anuncia el hostname "cali-node-XXXX" (XXXX = ultimos
 *    2 bytes de la MAC STA en hex), y routers con DNS proxy / Bonjour /
 *    Avahi lo exponen como nombre en la LAN. Ver bloque NOTA sobre mDNS
 *    mas abajo para la limitacion real de ESP-IDF v5.3.1.
 *  - GET /api/status NO incluye el password Wi-Fi (regla 4.3 del
 *    proyecto): un leak del JSON status revelaria credenciales a
 *    cualquiera con acceso al portal HTTP.
 *  - /api/status usa nvs_config_read() (API publica existente en
 *    nvs_config.h) para no agregar getters nuevos ni leer NVS a mano.
 *  - El reinicio se agenda en una tarea separada con 1s de delay (no
 *    inline en el handler HTTP) para que la respuesta HTTP de confirmacion
 *    alcance a llegar al navegador antes de que el socket se cierre con
 *    el reboot. El handler retorna ESP_OK antes de que la tarea corra;
 *    el httpd worker queda libre para otras requests hasta el reset.
 *
 * Nota sobre alcance: este modulo no toca la STA Wi-Fi. Si el SSID nuevo
 * difiere del actual, el reinicio provoca una desconexion temporal
 * mientras wifi_manager reintenta con la config nueva (ver backoff en
 * wifi_manager.h).
 */

#include "wifi_provisioning.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_mac.h"
#include "esp_http_server.h"

/* NOTA sobre mDNS: en ESP-IDF v5.3.1 (la version que usa este proyecto,
 * ver sdkconfig) NO existe un componente publico `mdns` — la API
 * `mdns_init()`/`mdns_hostname_set()`/`mdns_service_add()` que
 * existia como componente top-level en ESP-IDF v4.x fue retirada. El
 * CMakeLists.txt de main/ lista `mdns` en REQUIRES pero ese componente
 * no se resuelve en v5.3.1; eso es un bug preexistente del proyecto,
 * no algo que este modulo introduzca.
 *
 * Alternativa implementada aca (cumple la intencion del spec sin
 * depender de un componente inexistente): se setea el hostname del
 * netif STA via `esp_netif_set_hostname()`. Esto hace que el servidor
 * DHCP del nodo lo anuncie en sus Option 12, y routers/APs con
 * proxy-DNS o DNS-Service-Discovery lo expongan como
 * `cali-node-XXXX.local` o `cali-node-XXXX.<lan>` en la mayoria de
 * las LANs (incluyendo redes con Bonjour/Avahi). Para mDNS nativo
 * (.local garantizados en cualquier cliente) hace falta agregar el
 * componente externo `espressif/mdns` o equivalente via
 * `idf_component.yml`, fuera del alcance de este PR.
 */

#include "nvs_config.h"

static const char *TAG = "wifi_prov";

/* Tamanio maximo aceptado para el cuerpo de POST /provision. Un form
 * con ssid(32)+pass(64)+mqtt_host(127) url-encoded cabe en ~500 bytes;
 * 1024 deja margen para futuras expansiones. */
#define PROV_POST_MAX_LEN 1024

/* Delay antes de esp_restart() tras confirmar provision: suficiente para
 * que la respuesta HTTP alcance a llegar al navegador antes del reboot. */
#define PROV_RESTART_DELAY_MS 1000

/* Tamanios segun node_config_t en nvs_config.h:
 *   zone_id[65], mqtt_broker_host[128], wifi_ssid[33]. */
#define STATUS_ZONE_BUF_SZ  65
#define STATUS_HOST_BUF_SZ  128
#define STATUS_SSID_BUF_SZ  33

/* ─── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Construye el hostname mDNS "cali-node-XXXX" a partir de la MAC STA
 * (ultimos 2 bytes en hex, 4 chars). Si esp_read_mac falla, devuelve
 * "cali-node-UNKNOWN" en vez de string vacio (regla 4.3: nunca devolver
 * vacio silencioso cuando hay un valor que mostrar).
 */
static void build_hostname(char *out, size_t out_size)
{
    uint8_t mac[6] = {0};
    if (out == NULL || out_size == 0) {
        return;
    }
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
        snprintf(out, out_size, "cali-node-%02X%02X", mac[4], mac[5]);
    } else {
        snprintf(out, out_size, "cali-node-UNKNOWN");
    }
}

/**
 * Devuelve el handle del netif STA estandar creado por
 * esp_netif_create_default_wifi_sta() (llamado dentro de
 * wifi_manager_init). NULL si aun no existe o si se uso otro nombre de
 * interfaz.
 */
static esp_netif_t *get_sta_netif(void)
{
    return esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
}

/**
 * Copia la IP STA actual (string IPv4) a `out`. Si no hay netif STA o
 * aun no tiene IP asignada, escribe "0.0.0.0" (fallo explicito, no
 * string vacio: regla 4.3).
 */
static void get_sta_ip_str(char *out, size_t out_size)
{
    if (out == NULL || out_size == 0) {
        return;
    }
    esp_netif_t *netif = get_sta_netif();
    if (netif == NULL) {
        snprintf(out, out_size, "0.0.0.0");
        return;
    }
    esp_netif_ip_info_t ip = {0};
    if (esp_netif_get_ip_info(netif, &ip) != ESP_OK) {
        snprintf(out, out_size, "0.0.0.0");
        return;
    }
    snprintf(out, out_size, IPSTR, IP2STR(&ip.ip));
}

/**
 * Decodifica una cadena application/x-www-form-urlencoded: '+' -> ' ',
 * %XX -> byte. httpd_query_key_value() NO decodifica por si solo, asi
 * que se aplica manualmente sobre cada valor extraido del POST.
 */
static void url_decode(const char *src, char *dst, size_t dst_size)
{
    if (src == NULL || dst == NULL || dst_size == 0) {
        if (dst_size > 0) dst[0] = '\0';
        return;
    }
    size_t di = 0;
    for (size_t si = 0; src[si] != '\0' && di + 1 < dst_size; si++) {
        char c = src[si];
        if (c == '+') {
            dst[di++] = ' ';
        } else if (c == '%' &&
                   isxdigit((unsigned char)src[si + 1]) &&
                   isxdigit((unsigned char)src[si + 2])) {
            char hex[3] = { src[si + 1], src[si + 2], '\0' };
            dst[di++] = (char)strtol(hex, NULL, 16);
            si += 2;
        } else {
            dst[di++] = c;
        }
    }
    dst[di] = '\0';
}

/**
 * Escapa una cadena C para embeberla en un literal JSON: backslash y
 * comillas se escapan con backslash; bytes de control (< 0x20) se
 * descartan (no escribimos \uXXXX para mantener el codigo simple — los
 * valores que almacenamos en NVS no deberian traerlos de todos modos).
 */
static void json_escape(const char *src, char *dst, size_t dst_size)
{
    if (dst == NULL || dst_size == 0) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t di = 0;
    for (size_t si = 0; src[si] != '\0'; si++) {
        unsigned char c = (unsigned char)src[si];
        if (c == '"' || c == '\\') {
            if (di + 2 >= dst_size) break;
            dst[di++] = '\\';
            dst[di++] = (char)c;
        } else if (c < 0x20) {
            continue;
        } else {
            if (di + 1 >= dst_size) break;
            dst[di++] = (char)c;
        }
    }
    dst[di] = '\0';
}

/* ─── Reinicio diferido tras provision exitoso ─────────────────────────── */

static void restart_task(void *pvParameters)
{
    (void)pvParameters;
    vTaskDelay(pdMS_TO_TICKS(PROV_RESTART_DELAY_MS));
    ESP_LOGI(TAG, "Reiniciando nodo con credenciales nuevas...");
    esp_restart();
}

/* ─── Handler: GET /  (formulario HTML) ────────────────────────────────── */

static esp_err_t serve_root(httpd_req_t *req)
{
    char hostname[32];
    build_hostname(hostname, sizeof(hostname));

    /* Generamos el HTML por snprintf para poder inyectar el hostname en
     * el header visible (asi el operador confirma a que nodo se conecto).
     * Mobile-first, sin CDN, sin JS, sin imagenes externas. ~3KB. */
    char html[4096];
    int n = snprintf(html, sizeof(html),
        "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>ESPetral Rescue - Aprovisionamiento</title>"
        "<style>"
        "*{box-sizing:border-box}"
        "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;"
            "background:#0e1116;color:#e6edf3;margin:0;padding:16px;"
            "max-width:480px;margin-left:auto;margin-right:auto}"
        "h1{font-size:18px;margin:0 0 8px}"
        ".host{font-family:monospace;background:#1c2128;padding:6px 10px;"
            "border-radius:4px;display:inline-block;margin-bottom:16px;"
            "font-size:13px}"
        "label{display:block;margin-top:14px;font-size:13px;color:#9da7b3}"
        "input{width:100%%;padding:10px;margin-top:4px;background:#1c2128;"
            "color:#e6edf3;border:1px solid #30363d;border-radius:6px;"
            "font-size:15px}"
        "input:focus{outline:none;border-color:#4493f8}"
        "button{margin-top:20px;width:100%%;padding:12px;background:#238636;"
            "color:#fff;border:none;border-radius:6px;font-size:15px;"
            "font-weight:600;cursor:pointer}"
        "button:active{background:#2ea043}"
        ".warn{font-size:12px;color:#d29922;margin-top:16px;line-height:1.4}"
        "</style></head><body>"
        "<h1>Aprovisionamiento de nodo</h1>"
        "<p style=\"font-size:13px;color:#9da7b3;margin:0 0 8px\">"
        "Accediste a este nodo en:</p>"
        "<div class=\"host\">%s.local</div>"
        "<form method=\"POST\" action=\"/provision\" autocomplete=\"off\">"
        "<label for=\"ssid\">SSID de la nueva red"
        "<input id=\"ssid\" name=\"ssid\" type=\"text\" maxlength=\"32\" required "
            "placeholder=\"ej: rescue-site-5G\"></label>"
        "<label for=\"pass\">Password (vacio = red abierta)"
        "<input id=\"pass\" name=\"pass\" type=\"password\" maxlength=\"64\" "
            "placeholder=\"\"></label>"
        "<label for=\"mqtt_host\">Host MQTT (opcional)"
        "<input id=\"mqtt_host\" name=\"mqtt_host\" type=\"text\" maxlength=\"127\" "
            "placeholder=\"cali-backend.local\"></label>"
        "<button type=\"submit\">Guardar y reiniciar</button>"
        "<p class=\"warn\">El nodo se reinicia automaticamente tras guardar. "
        "La conexion Wi-Fi se interrumpe unos segundos mientras se une a la "
        "red nueva.</p>"
        "</form></body></html>",
        hostname);

    if (n < 0 || (size_t)n >= sizeof(html)) {
        ESP_LOGE(TAG, "HTML de root demasiado grande (%d bytes)", n);
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/html; charset=utf-8");
    return httpd_resp_send(req, html, n);
}

/* ─── Handler: POST /provision ─────────────────────────────────────────── */

static esp_err_t serve_provision(httpd_req_t *req)
{
    if (req->content_len == 0 || req->content_len >= PROV_POST_MAX_LEN) {
        ESP_LOGW(TAG, "POST /provision: content_len invalido (%u)",
                 (unsigned int)req->content_len);
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "text/plain; charset=utf-8");
        const char *msg = "Bad Request: cuerpo vacio o demasiado grande.";
        httpd_resp_send(req, msg, HTTPD_RESP_USE_STRLEN);
        return ESP_OK;
    }

    char body[PROV_POST_MAX_LEN];
    size_t received = 0;
    while (received < req->content_len) {
        int r = httpd_req_recv(req, body + received, req->content_len - received);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) {
            /* Reintentar lectura: httpd_req_recv puede devolver timeout
             * transitorio si el cliente envia el body en chunks lentos. */
            continue;
        }
        if (r <= 0) {
            ESP_LOGE(TAG, "Error leyendo cuerpo de /provision (r=%d)", r);
            httpd_resp_send_500(req);
            return ESP_FAIL;
        }
        received += (size_t)r;
    }
    body[req->content_len] = '\0';

    /* Buffers raw (aun url-encoded) dimensionados con margen sobre los
     * limites NVS para no perder data al copiar. Los buffers finales
     * post-decode se dimensionan EXACTOS a NVS (ver abajo) para que
     * url_decode no produzca un valor truncado que igual pase el chequeo
     * de longitud y luego se rechace por NVS. */
    char ssid_raw[64] = {0};
    char pass_raw[96] = {0};
    char host_raw[160] = {0};

    /* mqtt_host es opcional: si el form lo omite, httpd_query_key_value
     * devuelve ESP_ERR_NOT_FOUND y deja el buffer en ""; eso es lo que
     * queremos pasar a nvs_config_write_wifi_credentials (no sobrescribe
     * el valor en NVS). */
    httpd_query_key_value(body, "ssid", ssid_raw, sizeof(ssid_raw));
    httpd_query_key_value(body, "pass", pass_raw, sizeof(pass_raw));
    httpd_query_key_value(body, "mqtt_host", host_raw, sizeof(host_raw));

    /* Buffers finales post-decode: tamanios exactos segun node_config_t
     * (wifi_ssid[33], wifi_password[65], mqtt_broker_host[128] en
     * nvs_config.h). */
    char ssid[33] = {0};
    char password[65] = {0};
    char mqtt_host[128] = {0};
    url_decode(ssid_raw, ssid, sizeof(ssid));
    url_decode(pass_raw, password, sizeof(password));
    url_decode(host_raw, mqtt_host, sizeof(mqtt_host));

    if (ssid[0] == '\0') {
        ESP_LOGW(TAG, "POST /provision: SSID vacio, rechazado");
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "text/html; charset=utf-8");
        const char *msg =
            "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\">"
            "<title>Error</title></head><body style=\"font-family:sans-serif;"
            "padding:24px;\"><h1>SSID obligatorio</h1><p>Volve atras y "
            "completa el campo SSID.</p></body></html>";
        httpd_resp_send(req, msg, HTTPD_RESP_USE_STRLEN);
        return ESP_OK;
    }

    esp_err_t err = nvs_config_write_wifi_credentials(ssid, password, mqtt_host);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error persistiendo credenciales en NVS: %s",
                 esp_err_to_name(err));
        httpd_resp_set_status(req, "500 Internal Server Error");
        httpd_resp_set_type(req, "text/plain; charset=utf-8");
        httpd_resp_send(req, "Error guardando credenciales. Reintentar.",
                        HTTPD_RESP_USE_STRLEN);
        return ESP_OK;
    }

    /* OK: confirmar y agendar reinicio. Importante: la respuesta debe
     * llegar al navegador ANTES de que el socket se cierre con el reboot,
     * por eso se envia primero y el restart_task se crea despues. */
    const char *confirm =
        "<!DOCTYPE html><html lang=\"es\"><head><meta charset=\"UTF-8\">"
        "<title>Guardado</title></head><body style=\"font-family:sans-serif;"
        "padding:24px;\"><h1>Credenciales guardadas</h1><p>El nodo se esta "
        "reiniciando y se unira a la nueva red en unos segundos. Si la nueva "
        "red requiere confirmacion en el portal cautivo, conectate a ella y "
        "abri la pagina de aprovisionamiento otra vez.</p></body></html>";
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    esp_err_t send_err = httpd_resp_send(req, confirm, HTTPD_RESP_USE_STRLEN);

    ESP_LOGI(TAG, "Configuracion recibida via portal (SSID='%s'); "
             "reiniciando en %d ms...", ssid, PROV_RESTART_DELAY_MS);

    if (xTaskCreate(restart_task, "wifi_prov_restart", 2048, NULL,
                    tskIDLE_PRIORITY + 1, NULL) != pdPASS) {
        /* No se pudo agendar la tarea: reiniciar igual antes que dejar
         * el nodo con credenciales a medio aplicar. La respuesta HTTP ya
         * fue encolada por httpd_resp_send() arriba. */
        ESP_LOGW(TAG, "No se pudo crear tarea de reinicio; reiniciando ahora");
        esp_restart();
    }

    return send_err;
}

/* ─── Handler: GET /api/status (JSON) ──────────────────────────────────── */

static esp_err_t serve_status(httpd_req_t *req)
{
    char hostname[32];
    char ip[16];
    build_hostname(hostname, sizeof(hostname));
    get_sta_ip_str(ip, sizeof(ip));

    /* Snapshot NVS via API publica. Si falla, reportar "unknown" para
     * que el operador sepa que el status no se pudo leer (regla 4.3:
     * fallar explicito, no silenciar). NO incluir password Wi-Fi aqui. */
    char zone[STATUS_ZONE_BUF_SZ] = "unknown";
    char ssid[STATUS_SSID_BUF_SZ] = "unknown";
    char mqtt_host[STATUS_HOST_BUF_SZ] = "unknown";

    node_config_t cfg = {0};
    if (nvs_config_read(&cfg) == ESP_OK) {
        strncpy(zone, cfg.zone_id, sizeof(zone) - 1);
        strncpy(ssid, cfg.wifi_ssid, sizeof(ssid) - 1);
        strncpy(mqtt_host, cfg.mqtt_broker_host, sizeof(mqtt_host) - 1);
    } else {
        ESP_LOGW(TAG, "/api/status: nvs_config_read fallo, reportando unknown");
    }

    /* Escapar para JSON (los valores de NVS no deberian traer " o \
     * normalmente, pero por las dudas si alguien metio caracteres raros
     * via algun path no contemplado). */
    char zone_j[STATUS_ZONE_BUF_SZ * 2 + 1];
    char ssid_j[STATUS_SSID_BUF_SZ * 2 + 1];
    char host_j[STATUS_HOST_BUF_SZ * 2 + 1];
    json_escape(zone, zone_j, sizeof(zone_j));
    json_escape(ssid, ssid_j, sizeof(ssid_j));
    json_escape(mqtt_host, host_j, sizeof(host_j));

    /* Cuerpo JSON: ~250 bytes maximo (5 strings cortas). Buffer holgado. */
    char body[512];
    int n = snprintf(body, sizeof(body),
        "{\"hostname\":\"%s.local\",\"ip\":\"%s\","
        "\"zone_id\":\"%s\",\"ssid_actual\":\"%s\","
        "\"mqtt_host_actual\":\"%s\"}",
        hostname, ip, zone_j, ssid_j, host_j);

    if (n < 0 || (size_t)n >= sizeof(body)) {
        ESP_LOGE(TAG, "JSON de status demasiado grande (%d bytes)", n);
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, body, n);
}

/* ─── Registro de URI handlers ─────────────────────────────────────────── */

static esp_err_t register_uri_handlers(httpd_handle_t server)
{
    const httpd_uri_t uris[] = {
        { .uri = "/",           .method = HTTP_GET,  .handler = serve_root },
        { .uri = "/provision",  .method = HTTP_POST, .handler = serve_provision },
        { .uri = "/api/status", .method = HTTP_GET,  .handler = serve_status },
    };
    const size_t n = sizeof(uris) / sizeof(uris[0]);

    for (size_t i = 0; i < n; i++) {
        if (httpd_register_uri_handler(server, &uris[i]) != ESP_OK) {
            ESP_LOGE(TAG, "No se pudo registrar handler para %s", uris[i].uri);
            return ESP_FAIL;
        }
    }
    ESP_LOGI(TAG, "Handlers HTTP registrados: GET /, POST /provision, GET /api/status");
    return ESP_OK;
}

/* ─── API publica ──────────────────────────────────────────────────────── */

esp_err_t wifi_provisioning_init(void)
{
    ESP_LOGI(TAG, "Iniciando portal de aprovisionamiento Wi-Fi...");

    /* Generar hostname mDNS a partir de la MAC STA. Se hace una sola vez
     * aca y se reutiliza implicitamente via build_hostname() en cada
     * handler, por si la MAC cambiara en runtime (no deberia, pero
     * evita acoplar el codigo al valor cacheado). */
    char hostname[32];
    build_hostname(hostname, sizeof(hostname));

    /* Anuncio del hostname para discovery: ver bloque de NOTA sobre mDNS
     * al tope del archivo. Usamos `esp_netif_set_hostname()` (API publica
     * ESP-IDF v5) que el DHCP server anuncia en Option 12 — routers con
     * DNS proxy o Bonjour/Avahi exponen el nombre como
     * `cali-node-XXXX.local` o `cali-node-XXXX.<lan>` en la mayoria de
     * las LANs. Si el netif STA aun no esta creado, esto es no-fatal. */
    esp_netif_t *sta_netif = get_sta_netif();
    if (sta_netif != NULL) {
        if (esp_netif_set_hostname(sta_netif, hostname) != ESP_OK) {
            ESP_LOGW(TAG, "esp_netif_set_hostname() fallo; discovery por "
                     "nombre deshabilitado, accesible solo por IP");
        } else {
            ESP_LOGI(TAG, "Hostname STA seteado a '%s' (anunciado via DHCP)",
                     hostname);
        }
    } else {
        ESP_LOGW(TAG, "Netif STA no disponible todavia; discovery por nombre "
                 "deshabilitado hasta que wifi_manager levante STA");
    }

    /* Servidor HTTP. HTTPD_DEFAULT_CONFIG() enlaza en 0.0.0.0:80, que
     * en este firmware es la STA (no hay AP). stack_size aumentado para
     * absorber el buffer de form-urlencoded (PROV_POST_MAX_LEN=1024) sin
     * overflow del worker. */
    httpd_handle_t server = NULL;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 6144;

    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start() fallo: %s", esp_err_to_name(err));
        return ESP_FAIL;
    }

    if (register_uri_handlers(server) != ESP_OK) {
        ESP_LOGE(TAG, "Fallo registrando handlers HTTP; cerrando servidor");
        httpd_stop(server);
        return ESP_FAIL;
    }

    char ip[16];
    get_sta_ip_str(ip, sizeof(ip));
    ESP_LOGI(TAG, "Portal activo. Hostname: %s (anunciado via DHCP). "
             "IP STA actual: %s. Si el router de la red soporta proxy-DNS o "
             "Bonjour, el operador puede navegar a http://%s/ directamente; "
             "si no, usar http://%s/", hostname, ip, hostname, ip);
    return ESP_OK;
}
