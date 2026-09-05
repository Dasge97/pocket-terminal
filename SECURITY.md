# Seguridad

Pocket Terminal expone una terminal de propósito general del usuario que ejecuta el servidor. Un acceso autorizado permite ejecutar comandos y leer los archivos que ese usuario pueda leer. No existe aislamiento por carpeta ni separación entre clientes.

## Uso previsto

Un único propietario, contraseña larga, ejecución con usuario normal y acceso remoto mediante Tailscale Serve por HTTPS. Revisa qué otros dispositivos tienen acceso a tu red privada. Evita ejecutarlo con permisos administrativos.

El servidor se enlaza a loopback. No confía en `X-Forwarded-For` ni `X-Forwarded-Host`; autoriza las operaciones por un origen configurado explícitamente. No dispone de CORS abierto. Los WebSockets exigen cookie y origen desde el establecimiento de la conexión y comprueban la caducidad antes de procesar entradas.

El historial en memoria, las contraseñas introducidas en programas de terminal y la sesión de Windows siguen siendo sensibles. No pegues credenciales en issues, capturas ni informes. La persistencia en memoria no impide que PowerShell, SSH, Claude u otras herramientas guarden sus propios archivos o historiales.

## Qué no cubre

- Usuarios maliciosos que conocen la contraseña.
- Malware, otras extensiones del navegador o acceso local al equipo.
- Aislamiento entre proyectos, cuentas, contenedores o servidores.
- Disponibilidad frente a ataques a gran escala. El límite de login es global y puede causar bloqueo temporal durante un ataque.
- Seguridad de los comandos ejecutados, de scripts del perfil de PowerShell o de dependencias futuras.
- Recuperación de terminales después de reiniciar el servidor o Windows.

## Informar de un problema

Si GitHub muestra la opción **Report a vulnerability** en la pestaña Security de este repositorio, úsala. Si no está habilitada, pide al propietario un canal privado sin publicar detalles explotables. No incluyas contraseñas, tokens, claves SSH ni archivos de configuración reales.

## Actualizar

Detén el servidor, actualiza el código, ejecuta `npm.cmd ci`, `npm.cmd run build` y las pruebas antes de volver a arrancar. Revisa las actualizaciones de Node.js 24 y las dependencias periódicamente. Los cambios de contraseña o configuración requieren reiniciar el proceso.
