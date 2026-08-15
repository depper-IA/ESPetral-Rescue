# Firmware — Nodo Bebe (ESP32-C6 LCD)

Firmware para el **Nodo "Bebe"**, implementado sobre **Waveshare ESP32-C6-LCD-1.47** (Wi-Fi 6 de 2.4 GHz, pantalla LCD IPS de 1.47" ST7789, ranura MicroSD/TF).

## Rol en el Sistema de Rescate
- **Nodo Emisor / Monitor de Campo Portátil**: Actúa como transmisor de ráfagas continuas CSI Ping a 20 Hz para sondear escombros y estructura colapsada.
- **Diagnóstico en Sitio**: Muestra el estado del escaneo inalámbrico Wi-Fi 6, canal de radio, ráfagas transmitidas e intensidad de señal directamente en su pantalla integrada, sin requerir una laptop ni teléfono en el borde de los escombros.
- **Eficiencia y Movilidad**: Batería/USB-C para despliegue rápido por los rescatistas en el perímetro.

## Especificaciones Técnicas
- **Chip**: ESP32-C6 (CPU RISC-V 32-bit @ 160 MHz con radio Wi-Fi 6 802.11ax).
- **Memoria Flash**: 4 MB Flash (`partitions.csv` con slots dual-OTA de 1.75MB).
- **Pantalla**: LCD IPS 1.47 pulgadas (Controlador ST7789).
- **Configuración NVS**: `nvs_bebe.csv` (`node_id = bebe`).

## Flasheo Rápido (Windows)
```cmd
flash.bat COM3
```

## Compilación Manual (ESP-IDF)
```bash
idf.py set-target esp32c6
python "%IDF_PATH%\components\nvs_flash\nvs_partition_generator\nvs_partition_gen.py" generate nvs_bebe.csv nvs.bin 0x6000
idf.py build
idf.py -p COM3 flash monitor
```
