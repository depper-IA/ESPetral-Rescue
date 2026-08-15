@echo off
setlocal EnableDelayedExpansion
rem ============================================================
rem  ESPetral Rescue - Flasher para Nodo Mama (ESP32-S3 - 16MB)
rem ============================================================
set "PORT=%~1"
set "CSV=%~2"
if "%CSV%"=="" set "CSV=nvs_mama.csv"

if "%PORT%"=="" (
    echo [ERROR] Falta puerto serial.
    echo Uso: flash.bat COM_PORT [NVS_CSV]
    echo Ejemplo: flash.bat COM5
    echo          flash.bat COM5 nvs_mama.csv
    exit /b 1
)

echo [1/4] Configurando target esp32s3...
call idf.py set-target esp32s3

echo [2/4] Generando particion NVS desde %CSV%...
python "%IDF_PATH%\components\nvs_flash\nvs_partition_generator\nvs_partition_gen.py" generate %CSV% nvs.bin 0x6000

echo [3/4] Compilando firmware para Nodo Mama (ESP32-S3)...
call idf.py build

echo [4/4] Flasheando a %PORT%...
call idf.py -p %PORT% flash

echo [extra] Flasheando particion NVS al offset 0x9000...
python -m esptool --chip esp32s3 --port %PORT% --baud 460800 write_flash 0x9000 nvs.bin

echo.
echo [OK] Nodo Mama (ESP32-S3) flasheado exitosamente.
echo Para abrir el monitor serial: idf.py -p %PORT% monitor
