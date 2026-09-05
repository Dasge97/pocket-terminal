# Pocket Terminal

**Tu terminal de Windows, cómoda en el móvil.**

Una web pequeña que muestra una terminal real de tu ordenador. El texto se ajusta a las columnas disponibles en el teléfono: puedes leerlo a tamaño normal, abrir PowerShell, entrar en un proyecto y ejecutar `claude`, `git`, `ssh` o tus comandos habituales.

El servidor se ejecuta en tu Windows con tu usuario. El móvil envía pulsaciones y recibe la salida a través de WebSocket. No necesita la extensión de VS Code ni una clave de la API de Anthropic.

## Qué incluye

- Terminal a pantalla completa, tema oscuro y letra ajustable de 12 a 28 px (17 px por defecto).
- Ajuste de columnas y filas al girar el móvil o abrir el teclado.
- Teclas táctiles: Ctrl, Esc, Tab, Ctrl+C, flechas e Intro.
- Campo auxiliar para escribir, pegar o usar el dictado del teclado del móvil.
- Varias terminales, con nombre y carpeta inicial. Máximo: 8.
- Reconexión a la misma sesión, conservando la pantalla y hasta 3.000 líneas de historial en memoria.
- Contraseña, cookie HttpOnly, comprobación de origen y límite de intentos.
- Scripts de instalación, arranque e inicio automático para Windows.
- Acceso tipo app desde la pantalla de inicio del móvil. Requiere conexión; no hay modo sin conexión.

**La persistencia cubre cerrar el navegador o perder cobertura.** Reiniciar el servidor, cerrar la sesión de Windows o apagar el PC termina las terminales. Bloquear la pantalla de Windows mantiene los procesos; suspender el ordenador pausa el acceso hasta que despierte. Los programas que se lancen de forma independiente pueden tener otro ciclo de vida.

## 1. Preparar Windows

Objetivo principal: **Windows 11 x64**, PowerShell y **Node.js 24 LTS**. Windows 10 reciente dispone de ConPTY, pero no se valida aquí cada versión. Windows ARM64 no está verificado.

Instala [Node.js 24](https://nodejs.org/en/download) y [Git para Windows](https://git-scm.com/downloads/win). Cierra y vuelve a abrir PowerShell para que recoja el PATH actualizado.

```powershell
git clone https://github.com/Dasge97/pocket-terminal.git
cd pocket-terminal
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup.ps1
```

El script instala dependencias, compila la web y pregunta:

1. **Carpeta inicial**, por ejemplo `C:\Users\TuUsuario\proyectos`.
2. **URL de acceso**. Para probar en el PC, acepta `http://localhost:3210`.
3. **Contraseña**, de al menos 12 caracteres. No aparece al escribirla y se guarda únicamente un hash con sal.

`-ExecutionPolicy Bypass` se limita a este proceso de PowerShell; no cambia la política permanente del equipo. Puedes ejecutar directamente el script si tu política ya lo permite. No necesitas abrir Pocket Terminal como administrador.

### Si falla la instalación de node-pty

`node-pty` contiene componentes nativos. Si no hay un binario compatible, necesita compilarse. Instala Python 3 y Visual Studio 2022 Build Tools con **Desarrollo para el escritorio con C++**, MSVC y Windows SDK. Si aparece `MSB8040`, añade las bibliotecas MSVC con mitigación Spectre correspondientes. Después vuelve a ejecutar `Setup.ps1`. Referencias: [node-pty](https://github.com/microsoft/node-pty#dependencies) y [node-gyp para Windows](https://github.com/nodejs/node-gyp#on-windows).

## 2. Arrancar

Desde la carpeta del proyecto:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start.ps1
```

Abre [Pocket Terminal en este PC](http://localhost:3210), introduce tu contraseña y pulsa **Nueva terminal**. La ruta del formulario corresponde a una carpeta de Windows, no del teléfono. También puedes cambiar de carpeta con `cd` dentro de PowerShell.

Mantén abierto el proceso del servidor. Cerrar una pestaña del navegador no lo detiene. `Ctrl+C` en la consola **del servidor** lo detiene y cierra las terminales; el botón `Ctrl+C` de la web se envía únicamente al programa de la terminal seleccionada.

### Claude Code, Git y SSH

Comprueba primero en PowerShell normal que funcionan:

```powershell
claude --version
git --version
ssh -V
```

Si solo usabas Claude como extensión, instala también su [CLI oficial para Windows](https://code.claude.com/docs/en/setup) e inicia sesión allí una vez. Desde Pocket Terminal ejecuta `claude` en tu proyecto. Se mantiene la autenticación propia de Claude Code: Pocket Terminal no añade una suscripción ni llama por su cuenta a la API.

PowerShell hereda el usuario y las variables del proceso del servidor, y carga su perfil habitual. Git, claves SSH y herramientas disponibles para ese usuario funcionan en ese entorno. Reinicia Pocket Terminal si instalas herramientas o cambias el PATH. Las conexiones y ajustes exclusivos de VS Code no se importan. Para un servidor remoto, ejecuta `ssh usuario@servidor` y después Claude allí si lo tienes instalado en ese servidor.

## 3. Entrar desde el móvil, también fuera de casa

La configuración recomendada utiliza **Tailscale en Windows y en el móvil** y **Tailscale Serve** para ofrecer la web por HTTPS dentro de tu red privada. No requiere abrir puertos en el router ni desplegar una web en otro servidor.

1. Instala [Tailscale para Windows](https://tailscale.com/docs/install/windows) y la app de Tailscale en tu móvil. Inicia sesión en la misma cuenta y conecta ambos dispositivos.
2. Con Pocket Terminal arrancado, ejecuta en PowerShell:

   ```powershell
   tailscale serve --bg http://127.0.0.1:3210
   ```

3. Sigue las indicaciones de Tailscale para habilitar HTTPS si te lo pide. Copia la URL HTTPS que muestra, por ejemplo `https://tu-pc.tu-red.ts.net`.
4. Detén Pocket Terminal y ejecuta:

   ```powershell
   npm.cmd run setup
   ```

5. Conserva la carpeta, introduce esa **URL HTTPS sin barra final** y deja la contraseña vacía si quieres conservarla. Vuelve a arrancar Pocket Terminal.
6. Con Tailscale activo en el móvil, abre esa URL y entra con la contraseña.

Después de configurar HTTPS, usa esa misma URL también desde el PC: la autenticación está ligada a un único origen. `localhost` deja de servir como origen de inicio de sesión hasta que vuelvas a configurarlo.

En **iPhone**: abre la URL en Safari → Compartir → Añadir a pantalla de inicio. Se abrirá sin la barra habitual del navegador. En Android, usa la opción equivalente de Chrome. La disponibilidad exacta del menú depende del navegador; la web funciona también en una pestaña normal.

Usa **Serve** para esta configuración privada. Tailscale **Funnel** tiene otra finalidad: publicación en Internet. Documentación: [Serve](https://tailscale.com/docs/features/tailscale-serve) y [comando Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Uso desde el móvil

| Control | Acción |
|---|---|
| Selector superior | Cambiar entre terminales |
| `＋` | Crear una terminal con nombre y carpeta |
| `A−` / `A+` | Cambiar el tamaño de letra |
| Teclado | Abrir o cerrar el teclado del teléfono |
| Ctrl | Aplicar Ctrl a la siguiente letra o carácter compatible |
| Ctrl+C | Interrumpir el programa en primer plano |
| Escribir | Escribir o dictar texto en un campo normal y después insertarlo |
| Pegar | Revisar el portapapeles antes de insertarlo; si el navegador no da acceso, pegar manualmente en el campo |
| Copiar | Copiar la selección de xterm; la selección táctil depende del navegador |
| Ajustes → Bloquear acceso | Cerrar la sesión de acceso, conservando las terminales |
| Ajustes → Cerrar esta terminal | Terminar esa terminal, previa confirmación |

**Insertar texto no añade Intro automáticamente**, pero un texto con saltos de línea puede ejecutar comandos, según el programa activo y su soporte de pegado entre delimitadores. Revísalo antes de insertarlo. No se guardan el texto auxiliar ni la salida de terminal en el almacenamiento del navegador; solo se recuerdan el tamaño de letra y el identificador de la última sesión.

Solo un dispositivo controla cada terminal a la vez. Si la abres desde otro, el anterior se desconecta para evitar cambios de tamaño y pulsaciones simultáneas. Puedes recuperarla desde **Ajustes → Volver a conectar**.

## Inicio automático opcional

Después de completar la configuración:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Enable-Autostart.ps1
```

Crea una tarea llamada `PocketTerminal` para tu usuario, con permisos normales, **al iniciar sesión en Windows**. No guarda tu contraseña de Windows ni configura inicio de sesión automático. Puede ser necesario autorizar la creación de tareas según la política de tu equipo. El script no sustituye una tarea existente del mismo nombre.

Para arrancar la tarea ahora, cierra primero el servidor manual y ejecuta:

```powershell
Start-ScheduledTask -TaskName PocketTerminal
```

Para quitarla y detener el servidor de esa tarea:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Disable-Autostart.ps1
```

Si cambias la ubicación del proyecto o reinstalas Node en otra ruta, vuelve a registrar la tarea. El PC debe permanecer encendido y sin suspensión para trabajar a distancia.

## Configuración local

Se guarda en `.pocket-terminal/config.json`, excluido de Git. Usa `npm.cmd run setup` para modificar URL, carpeta o contraseña. También puedes editar el archivo con el servidor detenido:

- `port`: puerto local, 3210 por defecto.
- `publicOrigin`: único origen autorizado; HTTPS obligatorio salvo en localhost para pruebas.
- `defaultCwd`: carpeta inicial absoluta.
- `shell`: `powershell.exe` por defecto. Puedes usar `pwsh.exe` si tienes PowerShell 7.
- `shellArgs`: `['-NoLogo']` por defecto, escrito como una lista JSON con comillas dobles.
- `passwordSalt` / `passwordHash`: gestionados por el asistente.

Los argumentos se pasan como lista a la terminal, sin concatenar la carpeta en un comando. Para restablecer una contraseña olvidada, ejecuta el asistente desde Windows. Reiniciar el servidor invalida todas las cookies de acceso.

## Seguridad y alcance

Esta aplicación da acceso a una **terminal completa con los permisos de tu usuario**. La carpeta inicial es una comodidad, no un aislamiento. Está pensada para una persona y sus dispositivos de confianza, no para dar terminales a terceros.

- Escucha únicamente en `127.0.0.1`; el acceso remoto se hace mediante el proxy HTTPS de tu red privada.
- Comprueba el origen de las operaciones y del WebSocket, además de la cookie de acceso.
- Contraseña con scrypt y sal aleatoria; tokens aleatorios, revocables y con caducidad de 12 horas.
- Cookies HttpOnly, SameSite=Strict y Secure cuando se configura HTTPS.
- Límite global de diez intentos de acceso por minuto, tamaños de entrada limitados y máximo de ocho terminales.
- Salida y pantalla solo en memoria; el servidor no registra las pulsaciones ni el historial. PowerShell, Claude y otras herramientas sí pueden guardar su propio historial habitual.
- Sin scripts de terceros ni recursos remotos en la interfaz. Los archivos del proyecto y la configuración no se sirven como contenido web.
- La configuración privada, certificados y dependencias se excluyen del repositorio.

El código puede ser público; tus credenciales y configuración real deben seguir fuera de Git. No es una auditoría de seguridad ni una plataforma multiusuario. Consulta [SECURITY.md](SECURITY.md).

## Desarrollo y comprobaciones

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd test
```

Node sirve la compilación de `web/` desde `dist/`. Después de editar la interfaz, vuelve a compilar. El proyecto usa JavaScript, Node HTTP, `ws`, `node-pty`, xterm.js y Vite. La copia de xterm sin interfaz mantiene la pantalla para reconectar; no se intenta reconstruir el chat de Claude.

La integración verifica una PTY real: entrada, salida Unicode, cambio de tamaño, Ctrl+C, salida durante desconexión, recuperación, exclusión de control simultáneo y cierre. También verifica autenticación, revocación, origen y límites. GitHub Actions ejecuta las pruebas en Windows y Linux y añade una prueba de PowerShell/ConPTY en Windows.

**Estado de validación de esta primera versión:** compilación y pruebas disponibles en CI. La experiencia de teclado, dictado, selección y área visible debe comprobarse en tu iPhone concreto. La ejecución en Linux permite comprobar el protocolo y buena parte del servidor; no sustituye la prueba de Windows/ConPTY ni una sesión real de Claude.

Comprobación manual recomendada al instalar: abrir una terminal, ejecutar `claude`, aumentar la letra, abrir/cerrar el teclado, girar la pantalla, mandar Ctrl+C cuando proceda y volver tras bloquear el móvil. No se ha probado la sesión de Claude de tu ordenador desde este entorno.

## Estructura

| Ruta | Contenido |
|---|---|
| `web/` | Interfaz móvil y controles |
| `server/` | HTTP, autenticación, WebSocket y PTY |
| `scripts/` | Configuración y scripts para Windows |
| `test/` | Pruebas de integración y seguridad |
| `.github/workflows/ci.yml` | Verificación en Windows y Linux |

Publicar el repositorio no despliega el servidor: el siguiente paso es instalarlo en tu Windows siguiendo esta guía.
