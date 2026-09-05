$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    if (-not (Test-Path '.pocket-terminal/config.json') -or -not (Test-Path 'dist/index.html')) {
        throw 'Ejecuta primero .\scripts\Setup.ps1'
    }
    & node.exe server/index.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Pocket Terminal se ha detenido con un error.' }
} finally { Pop-Location }
