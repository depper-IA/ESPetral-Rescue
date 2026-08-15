idf_component_register(
    SRCS "main.c" "nvs_config.c" "ota_update.c" "csi_engine.c" "csi_transmitter.c" "csi_publisher.c" "led_indicator.c" "ws2812_led.c" "power_mgmt.c" "cali_mqtt.c" "wifi_manager.c" "wifi_provisioning.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash driver esp_driver_rmt esp_timer esp_wifi esp_netif esp_event esp_pm log mqtt esp_http_client app_update mbedtls esp_http_server
    PRIV_REQUIRES esp_http_client app_update mbedtls
)
