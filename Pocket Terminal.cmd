@echo off
chcp 65001 >nul
title Pocket Terminal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo No encuentro Node.js en el PATH.
  echo Instala Node.js 24 y vuelve a abrir esta ventana.
  echo.
  pause
  exit /b 1
)
node scripts\open-panel.mjs
if errorlevel 1 (
  echo Abriendo el panel de consola como alternativa...
  node scripts\panel.mjs
  pause
)
