idf_component_register(
    SRCS "main.c" "nvs_config.c" "csi_engine.c" "csi_transmitter.c" "csi_publisher.c" "led_indicator.c" "power_mgmt.c" "cali_mqtt.c" "wifi_manager.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash driver esp_timer esp_wifi esp_netif esp_event esp_pm log mqtt
)
