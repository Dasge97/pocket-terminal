# Run from PowerShell as your normal Windows user.
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Instala Node.js 24 LTS desde https://nodejs.org y abre otra ventana de PowerShell.'
    }
    $nodeVersion = & node.exe --version
    if ($nodeVersion -notlike 'v24.*') { throw 'Este proyecto requiere Node.js 24 LTS.' }
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron instalar las dependencias. Consulta README.md (node-pty).' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar la interfaz.' }
    & node.exe scripts/setup.mjs
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo completar la configuracion.' }
    Write-Host "`nListo. Ejecuta .\scripts\Start.ps1" -ForegroundColor Green
} finally { Pop-Location }
