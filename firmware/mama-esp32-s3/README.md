# Firmware — Nodo Mama (ESP32-S3)

Firmware de alta potencia para el **Nodo Maestro "Mama"**, implementado sobre **ESP32-S3-DevKitC-1 / ESP32-S3-N16R8** (16MB Flash, 8MB PSRAM Octal).

## Rol en el Sistema de Rescate
- **Nodo Principal de Procesamiento y Recepción**: Ejecuta el cálculo matricial pesado de varianza de amplitud y extracción de fase cruda `atan2f(Q,I)` de 64 subportadoras OFDM.
- **Detección de Signos Vitales**: Publica spikes de fase a 10 Hz para análisis de respiración humana en escombros.
- **Búfer Circular MQTT**: Retiene eventos en memoria ante pérdidas de enlace con el puesto de mando.
- **Semaforización Visual**: Controla el LED RGB WS2812 con histéresis visual.

## Especificaciones Técnicas
- **Chip**: ESP32-S3 (Xtensa Dual-Core 32-bit @ 240 MHz con extensiones SIMD/DSP).
- **Memoria Flash**: 16 MB Octal Flash (`partitions.csv` con slots dual-OTA de 4MB).
- **Consola**: `USB-Serial-JTAG` nativo.
- **Configuración NVS**: `nvs_mama.csv` (`node_id = mama`).

## Flasheo Rápido (Windows)
```cmd
flash.bat COM5
```

## Compilación Manual (ESP-IDF)
```bash
idf.py set-target esp32s3
python "%IDF_PATH%\components\nvs_flash\nvs_partition_generator\nvs_partition_gen.py" generate nvs_mama.csv nvs.bin 0x6000
idf.py build
idf.py -p COM5 flash monitor
```
