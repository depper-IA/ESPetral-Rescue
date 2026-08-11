@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem  ESPetral Rescue - Lanzador local
rem  Deteccion de movimiento CSI + acustica + GPS para
rem  busqueda y rescate en sitio de siniestro
rem ============================================================
rem  Servicios:
rem    Backend dashboard :  http://localhost:3000
rem    Backend MQTT      :  tcp://localhost:1883
rem    Backend WS relay  :  ws://localhost:9001  (sync PWA)
rem    Backend WS MQTT   :  ws://localhost:9003  (raw, interno)
rem    Mobile dev server :  http://localhost:5173
rem    Mobile en LAN     :  http://192.168.1.3:5173
rem ============================================================

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "MOBILE_DIR=%ROOT%mobile"

rem Verificar Node y pnpm en PATH
where node >nul 2>&1 || (echo [ERROR] Node.js no encontrado en PATH & pause & exit /b 1)
where pnpm >nul 2>&1 || (echo [ERROR] pnpm no encontrado en PATH & pause & exit /b 1)

rem Verificar estructura del proyecto
if not exist "%BACKEND_DIR%\package.json" (
    echo [ERROR] No se encontro %BACKEND_DIR%\package.json
    pause
    exit /b 1
)
if not exist "%MOBILE_DIR%\package.json" (
    echo [ERROR] No se encontro %MOBILE_DIR%\package.json
    pause
    exit /b 1
)

rem Verificar dependencias instaladas
if not exist "%BACKEND_DIR%\node_modules" (
    echo [INFO] backend\node_modules no existe.
    echo        Ejecuta primero: cd backend ^&^& pnpm install
    pause
    exit /b 1
)
if not exist "%MOBILE_DIR%\node_modules" (
    echo [INFO] mobile\node_modules no existe.
    echo        Ejecuta primero: cd mobile ^&^& pnpm install
    pause
    exit /b 1
)

rem Matar procesos previos que ocupen los puertos del sistema
echo [INFO] Liberando puertos 3000, 1883, 9001, 9003, 5173...
for %%P in (3000 1883 9001 9003 5173) do (
    for /f "tokens=5" %%I in ('netstat -ano 2^>nul ^| findstr /R ":%%P.*LISTENING"') do (
        echo [INFO]   Puerto %%P ocupado por PID %%I, terminando...
        taskkill /F /PID %%I >nul 2>&1
    )
)

rem Esperar que liberen los puertos
timeout /t 2 /nobreak >nul

echo.
echo  ============================================================
echo   ESPetral Rescue - Iniciando servicios locales
echo  ============================================================
echo    Backend :  %BACKEND_DIR%
echo               http://localhost:3000
echo    Mobile  :  %MOBILE_DIR%
echo               http://localhost:5173  (tel: http://192.168.1.3:5173)
echo.

rem Abrir backend en ventana dedicada
start "ESPetral Rescue - Backend" cmd /k "cd /d "%BACKEND_DIR%" && pnpm dev"

rem Esperar a que el backend termine de inicializar
timeout /t 6 /nobreak >nul

rem Abrir mobile dev server en ventana dedicada
start "ESPetral Rescue - Mobile" cmd /k "cd /d "%MOBILE_DIR%" && pnpm dev --host"

rem Esperar a que Vite este listo
timeout /t 5 /nobreak >nul

rem Abrir navegador en la PWA mobile y en el dashboard
start "" "http://localhost:5173"
timeout /t 1 /nobreak >nul
start "" "http://localhost:3000"

echo  ============================================================
echo   [OK] ESPetral Rescue corriendo.
echo  ============================================================
echo   Backend dashboard: http://localhost:3000
echo   Mobile app      : http://localhost:5173
echo.
echo   Para usarlo desde el telefono, conecta el cel a la misma
echo   red Wi-Fi y abre: http://192.168.1.3:5173
echo.
echo   [INFO] El dashboard mostrara zonas grises (sin datos) hasta
echo          que algun nodo ESP32 publique CSI en el broker.
echo   [INFO] El microfono del navegador exige HTTPS en LAN.
echo          Para pruebas en laptop usa http://localhost:5173.
echo.
echo   Para detener: cierra las ventanas "ESPetral Rescue - Backend"
echo   y "ESPetral Rescue - Mobile", o ejecuta taskkill /F /IM node.exe
echo.

endlocal
