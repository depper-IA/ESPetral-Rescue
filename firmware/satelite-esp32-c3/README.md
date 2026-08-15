# Firmware — Nodo Satélite (ESP32-C3)

Firmware económico para el **Nodo Satélite Perimetral**, implementado sobre placas **ESP32-C3 Super Mini / DevKitM-1** (4MB Flash).

## Rol en el Sistema de Rescate
- **Nodo Satélite de Despliegue Perimetral**: Dispositivo ultra accesible de bajo costo (~$8–$12 USD) para cubrir múltiples zonas colapsadas en paralelo.
- **Captura CSI Continua**: Envía métricas de varianza al broker MQTT sobre la red Wi-Fi local.

## Especificaciones Técnicas
- **Chip**: ESP32-C3 (CPU RISC-V 32-bit @ 160 MHz).
- **Memoria Flash**: 4 MB Flash (`partitions.csv` con slots dual-OTA de 1.75MB).
- **Configuración NVS**: `nvs_data.csv`.

## Flasheo Rápido (Windows)
```cmd
flash.bat COM3
```

## Compilación Manual (ESP-IDF)
```bash
idf.py set-target esp32c3
python "%IDF_PATH%\components\nvs_flash\nvs_partition_generator\nvs_partition_gen.py" generate nvs_data.csv nvs.bin 0x6000
idf.py build
idf.py -p COM3 flash monitor
```
