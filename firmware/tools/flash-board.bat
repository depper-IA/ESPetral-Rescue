@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem  ESPetral Rescue - Flash helper para nodos ESP32 (C3 / S3)
rem ============================================================
rem  Requisitos:
rem    1. ESP-IDF v5+ instalado (ej: C:\Users\Matt\esp\esp-idf\)
rem    2. Variables de entorno ESP-IDF activas (correr "ESP-IDF PowerShell"
rem       desde el menu Inicio antes de invocar este script)
rem    3. Board conectada por USB y driver USB-Serial visible
rem    4. python en PATH (incluido en ESP-IDF)
rem
rem  Uso:
rem    flash-board.bat esp32c3 COM3
rem    flash-board.bat esp32s3 COM5
rem ============================================================

set "TARGET=%~1"
set "PORT=%~2"

if "%TARGET%"=="" (
    echo [ERROR] Falta target. Uso: flash-board.bat esp32c3^|esp32s3 COM_PORT
    echo         Ejemplo: flash-board.bat esp32c3 COM3
    pause
    exit /b 1
)
if "%PORT%"=="" (
    echo [ERROR] Falta puerto serial. Uso: flash-board.bat %TARGET% COM_PORT
    echo         Ejemplo: flash-board.bat %TARGET% COM3
    echo         Para ver puertos disponibles: Get-CimInstance Win32_SerialPort
    pause
    exit /b 1
)

rem Verificar ESP-IDF
where idf.py >nul 2>&1
if errorlevel 1 (
    echo [ERROR] idf.py no encontrado. Abrir "ESP-IDF PowerShell" desde el menu Inicio.
    pause
    exit /b 1
)

rem Verificar python
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] python no encontrado. Instalar ESP-IDF con soporte Python.
    pause
    exit /b 1
)

rem Verificar que NVS CSV existe
if not exist "nvs_data.csv" (
    echo [ERROR] No se encontro nvs_data.csv en %CD%
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo   ESPetral Rescue - Flashing ESP32
echo   Target : %TARGET%
echo   Puerto : %PORT%
echo   Zona   : ver nvs_data.csv
echo  ============================================================
echo.

echo [1/4] Configurando target...
idf.py set-target %TARGET%
if errorlevel 1 (
    echo [ERROR] Fallo en set-target %TARGET%
    pause
    exit /b 1
)

echo [2/4] Generando particion NVS desde nvs_data.csv...
python "%IDF_PATH%\components\nvs_flash\nvs_partition_generator\nvs_partition_gen.py" generate nvs_data.csv nvs.bin 0x6000
if errorlevel 1 (
    echo [ERROR] Fallo generando nvs.bin. Verificar formato del CSV.
    pause
    exit /b 1
)

echo [3/4] Compilando firmware...
idf.py build
if errorlevel 1 (
    echo [ERROR] Fallo de compilacion. Ver mensajes arriba.
    pause
    exit /b 1
)

echo [4/4] Flasheando a %PORT%...
echo       (esto incluye bootloader, tabla de particiones, app y NVS)

rem Borrar flash previo (especialmente si cambia layout de particiones)
idf.py -p %PORT% erase_flash
if errorlevel 1 (
    echo [WARN] No se pudo borrar flash previo. Continuando igual...
)

idf.py -p %PORT% flash
if errorlevel 1 (
    echo [ERROR] Fallo de flasheo. Verificar que %PORT% sea correcto y la board conectada.
    pause
    exit /b 1
)

rem Flashear particion NVS al offset 0x9000 (definido en partitions.csv)
echo [extra] Flasheando particion NVS al offset 0x9000...
python -m esptool --chip %TARGET% --port %PORT% --baud 460800 write_flash 0x9000 nvs.bin
if errorlevel 1 (
    echo [WARN] Fallo flasheando NVS. El nodo entrara en halt_with_blink 4Hz hasta que NVS este correcto.
)

echo.
echo  ============================================================
echo   [OK] Flash completo.
echo.
echo   Siguiente paso: monitor serial para ver logs:
echo     idf.py -p %PORT% monitor
echo.
echo   Presionar Ctrl+] para salir del monitor.
echo  ============================================================
echo.

endlocal
