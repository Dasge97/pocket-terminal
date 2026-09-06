# Seguridad

Pocket Terminal expone una terminal de propósito general del usuario que ejecuta el servidor. Un acceso autorizado permite ejecutar comandos y leer los archivos que ese usuario pueda leer. No existe aislamiento por carpeta ni separación entre clientes.

## Uso previsto

Un único propietario, contraseña larga y ejecución con usuario normal. Evita ejecutarlo con permisos administrativos.

**El acceso remoto del flujo principal es un Quick Tunnel público de Cloudflare.** El arranque desde el bot o desde el panel ejecuta `cloudflared tunnel --url http://127.0.0.1:3210`, que publica una dirección HTTPS alcanzable por cualquiera que la conozca. Que el servidor escuche solo en loopback no lo hace privado mientras ese túnel está abierto: la única barrera es la contraseña.

La dirección cambia en cada arranque y no está indexada, lo que reduce la probabilidad de que la encuentren, pero no es un control de acceso. Este flujo no configura Cloudflare Access ni ninguna autenticación previa al servidor.

Alternativa más cerrada, sin túnel público: **Tailscale Serve** sobre tu red privada, arrancando con la opción que no abre túnel. Ahí solo llegan tus dispositivos. Revisa qué otros dispositivos tienen acceso a esa red.

**El bot de Telegram forma parte de la seguridad del equipo.** Quien pueda usar tu cuenta de Telegram puede pedir `/arrancar` o `/estado` y recibir la dirección y la contraseña. Enviar el enlace y la contraseña en mensajes separados del mismo chat no añade un segundo factor. Protege esa cuenta con verificación en dos pasos.

El bot solo obedece a la persona vinculada y solo por mensaje privado. La vinculación exige un código de un solo uso generado en el ordenador, así que escribirle al bot no basta para quedar autorizado.

El servidor se enlaza a loopback. No confía en `X-Forwarded-For` ni `X-Forwarded-Host`; autoriza las operaciones por un origen configurado explícitamente. No dispone de CORS abierto. Los WebSockets exigen cookie y origen desde el establecimiento de la conexión y comprueban la caducidad antes de procesar entradas.

El historial en memoria, las contraseñas introducidas en programas de terminal y la sesión de Windows siguen siendo sensibles. No pegues credenciales en issues, capturas ni informes. La persistencia en memoria no impide que PowerShell, SSH, Claude u otras herramientas guarden sus propios archivos o historiales.

## Qué no cubre

- Usuarios maliciosos que conocen la contraseña.
- Malware, otras extensiones del navegador o acceso local al equipo.
- Aislamiento entre proyectos, cuentas, contenedores o servidores.
- Disponibilidad frente a ataques a gran escala. El límite de intentos de acceso es global: no distingue clientes, así que un atacante que conozca la dirección puede agotar el cupo y dejar sin poder entrar durante un minuto. Las peticiones malformadas no gastan cupo, pero los intentos con contraseña sí.
- Confidencialidad de la contraseña en curso frente a quien ya pueda leer tu perfil de usuario: `.pocket-terminal/state.json` la guarda en claro para poder mostrarla en el panel y reenviarla por Telegram.
- Seguridad de los comandos ejecutados, de scripts del perfil de PowerShell o de dependencias futuras.
- Recuperación de terminales después de reiniciar el servidor o Windows.

## Datos privados en el equipo

La carpeta `.pocket-terminal` guarda la contraseña en curso, el token del bot y la clave del panel. Los modos `0600` de Node no separan permisos en Windows, así que la carpeta y esos archivos se protegen además con ACL explícitas: se corta la herencia y solo queda tu usuario. Compruébalo con `icacls .pocket-terminal`.

Ninguno de esos archivos se sirve por la web. El riesgo que cubren las ACL es la lectura local, una copia de seguridad o un envío accidental.

## Informar de un problema

Si GitHub muestra la opción **Report a vulnerability** en la pestaña Security de este repositorio, úsala. Si no está habilitada, pide al propietario un canal privado sin publicar detalles explotables. No incluyas contraseñas, tokens, claves SSH ni archivos de configuración reales.

## Actualizar

Detén el servidor, actualiza el código, ejecuta `npm.cmd ci`, `npm.cmd run build` y las pruebas antes de volver a arrancar. Revisa las actualizaciones de Node.js 24 y las dependencias periódicamente. Los cambios de contraseña o configuración requieren reiniciar el proceso.
