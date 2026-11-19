@echo off
chcp 65001 >nul
title Puente de WhatsApp - Sigo
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Falta instalar Node.js. Se abrira la pagina de descarga: instala la version LTS y vuelve a abrir este archivo.
  start https://nodejs.org/es/download
  pause
  exit /b
)

:inicio
echo.
echo   Cerrando puentes que hayan quedado abiertos...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*puente.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo   Buscando la ultima version del puente...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $b='https://raw.githubusercontent.com/joacovm66-source/seguimiento-whatsapp-servicio/main/'; foreach($f in 'puente.js','sigo-extra.mjs','package.json'){ try { $t = Invoke-WebRequest -UseBasicParsing ($b + $f + '?t=' + [DateTimeOffset]::Now.ToUnixTimeSeconds()); [IO.File]::WriteAllText((Join-Path (Get-Location) ($f + '.nuevo')), $t.Content) ; Move-Item -Force ($f + '.nuevo') $f } catch { Write-Host ('   (sin internet para actualizar ' + $f + ', uso la version guardada)') } }"

if not exist puente.js (
  echo   No se pudo descargar el puente. Revisa tu internet y vuelve a abrir este archivo.
  pause
  exit /b
)

fc /b package.json package.instalado >nul 2>&1
if errorlevel 1 (
  echo   Instalando lo necesario, solo la primera vez o cuando hay cambios. Puede tardar unos minutos...
  call npm install --no-audit --no-fund --loglevel=error
  if not errorlevel 1 copy /y package.json package.instalado >nul
)

echo.
echo   Iniciando el puente... deja esta ventana abierta y el equipo encendido.
node puente.js
echo.
echo   El puente se detuvo. Reiniciando en 5 segundos...
timeout /t 5 /nobreak >nul
goto inicio
