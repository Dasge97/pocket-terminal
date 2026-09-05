# Decisiones sobre las funciones nuevas para el móvil

Fecha del acuerdo: 5 de septiembre de 2026.

Estado: **decidido, sin implementar**. No se ha tocado ningún archivo de código. En el momento de escribir este documento había otra sesión trabajando en el repositorio.

Este documento recoge cuatro funciones aprobadas, lo que se ha descartado, y las mediciones técnicas que condicionan cómo hay que construirlas.

---

## Índice

1. [Joystick de scroll](#1-joystick-de-scroll)
2. [Arreglar el reinicio al volver a la app](#2-arreglar-el-reinicio-al-volver-a-la-app)
3. [Explorador de carpetas](#3-explorador-de-carpetas)
4. [PWA instalable en el iPhone](#4-pwa-instalable-en-el-iphone)
5. [Descartado](#5-descartado)
6. [Mediciones técnicas](#6-mediciones-técnicas)
7. [Orden de trabajo](#7-orden-de-trabajo)

---

## 1. Joystick de scroll

Es la función más importante de las cuatro. El objetivo es poder mover el texto arriba y abajo con comodidad durante una sesión de Claude Code o de Codex.

### Definido por el usuario

- Es un **joystick**, no una barra lateral. Durante la conversación se mencionó una barra lateral, pero únicamente como forma de explicar el gesto de agarrar y arrastrar. La barra lateral no es la función pedida.
- Sirve **solo para arriba y abajo**. No tiene movimiento horizontal ni ninguna otra función.
- Tiene que ser **sencillo de usar**.
- Lo agarras con el dedo, lo mantienes pulsado y lo deslizas.
- Al deslizarlo hacia arriba, **la vista baja**. Al deslizarlo hacia abajo, la vista sube.
- Si lo aprietas y lo mantienes desplazado, **va saltando un poco más rápido**.
- La sensación buscada es la de deslizar la terminal como se desliza una aplicación del móvil, pero **desde un único sitio**, que es el joystick.
- **Posición aprobada**: flotando sobre la esquina inferior derecha de la terminal, por encima de la fila de teclas, siempre visible.
- Sobre la posición y el tacto, el usuario indicó que se harán pruebas.

### Precisión sobre la dirección

Deslizar el mando hacia arriba equivale a arrastrar el dedo hacia arriba sobre una app del móvil. El texto sube en la pantalla y avanzas hacia el final del historial.

Deslizar el mando hacia abajo hace lo contrario. El texto baja en la pantalla y retrocedes hacia el principio del historial, que es donde está la salida más antigua.

Esta dirección es lo primero que hay que comprobar en la primera prueba real.

### Decisión de diseño: velocidad, no posición

La distancia del mando respecto a su centro controla la **velocidad** del desplazamiento, no la posición dentro del texto.

Motivo: el mando tendrá unos 60 píxeles de recorrido y el historial puede llegar a 3.000 líneas. Con una correspondencia de uno a uno entre píxeles arrastrados y líneas desplazadas, nunca se llegaría al principio del historial.

Comportamiento concreto:

- Mando en el centro: no se mueve nada.
- Desplazamiento corto: avanza despacio, una línea cada poco tiempo, para leer con precisión.
- Desplazamiento a fondo: recorre el historial rápido.
- Al soltarlo, el mando vuelve al centro y el desplazamiento se detiene.

La sensación sigue siendo la de una app del móvil porque la dirección y la fuerza las pone el dedo sin levantarlo en ningún momento.

### Por qué un control aparte y no arrastrar sobre el texto

Claude Code activa el reporte de ratón completo mientras está en marcha. Significa que se queda con todos los toques que caigan sobre el área de la terminal.

Si el desplazamiento se hiciera arrastrando el dedo sobre el texto, dentro de Claude Code no funcionaría, porque Claude Code interceptaría el gesto antes.

Un mando que vive fuera del área de la terminal no tiene ese problema.

### Tres modos de funcionamiento

El mismo mando tiene que hacer tres cosas distintas según qué programa esté activo. La detección se hace en caliente, sin configuración del usuario.

| Situación | Programa típico | Qué hace el joystick |
|---|---|---|
| Búfer normal | Codex, PowerShell, `git log` | Llama a `term.scrollLines(n)` |
| Pantalla alternativa con reporte de ratón | Claude Code | Envía eventos de rueda de ratón al programa |
| Pantalla alternativa sin reporte de ratón | `vim`, `less` | Envía Re Pág y Av Pág |

Datos que expone xterm.js para decidir el modo:

- `term.buffer.active.type` vale `normal` o `alternate`.
- `term.modes.mouseTrackingMode` vale `none` cuando no hay reporte de ratón activo.

Secuencias de rueda de ratón en formato SGR, necesarias para el caso de Claude Code:

- Subir: `ESC [ < 64 ; columna ; fila M`
- Bajar: `ESC [ < 65 ; columna ; fila M`

### Propuesto pero sin confirmar

Estas dos ideas se propusieron y el usuario no se pronunció sobre ellas. No forman parte de lo aprobado.

- Un toque rápido sobre el centro del mando para saltar directamente al final del texto.
- Poder arrastrar el mando a la esquina izquierda, recordando la posición elegida, para el uso con la otra mano.

---

## 2. Arreglar el reinicio al volver a la app

### Definido por el usuario

"Lo del reinicio hay que arreglarlo."

### El problema

Cuando la app vuelve al primer plano, el código del navegador cierra la conexión, borra el contenido de la terminal y lo vuelve a pedir entero al servidor.

En el móvil se cambia de aplicación constantemente, así que ocurre muchas veces al día. Se ve un parpadeo y se pierde la posición de lectura en cada vuelta.

Además, cada reconexión descarga el historial completo. El servidor envía hasta 3.000 líneas serializadas con sus colores, lo que supone bastante tráfico con datos móviles.

### Por qué va unido al joystick

Con el joystick puesto, el efecto se nota más. De nada sirve poder desplazarse cómodamente si la posición de lectura se pierde cada vez que se cambia de aplicación.

### Dirección del arreglo

- Comprobar si la conexión sigue viva antes de reconectar, en lugar de reconectar siempre.
- Cuando haya que reconectar de verdad, pedir solo la pantalla visible más una parte del historial, no las 3.000 líneas completas.

---

## 3. Explorador de carpetas

### Definido por el usuario

- Mejorar toda la parte previa a entrar en una carpeta.
- Un explorador de archivos del ordenador, **antes** de abrir la terminal.
- **Sin abrir nada**: solo ver qué hay y elegir dónde quiero abrir la terminal.
- Todo con **iconos**.
- Moverse fácil **con clics**, como en un PC.

### Qué resuelve

Hoy, para crear una terminal hay que teclear a mano una ruta absoluta de Windows en el formulario. En un teclado de móvil resulta incómodo y propenso a errores.

### Límites que impone la definición

El explorador solo mira. No abre archivos, no los ejecuta, no los edita y no los borra. Su única salida es la carpeta elegida, que pasa al formulario de nueva terminal.

---

## 4. PWA instalable en el iPhone

### Definido por el usuario

"El PWA hay que hacerlo, si falta algo se lo pones."

La petición original era poder instalar la aplicación en el iPhone desde la pantalla de inicio.

### Qué falta hoy

- **No hay `apple-touch-icon`.** Falta una etiqueta `link` de tipo `apple-touch-icon` con un PNG de 180 × 180. iOS ignora los iconos SVG del manifest, así que el icono de la pantalla de inicio sale como una captura de la página.
- **El manifest solo declara un icono SVG.** Faltan también PNG de 192 × 192 y 512 × 512.
- **No hay service worker.** Sin él, abrir la aplicación sin conexión muestra un error de red en lugar de la pantalla de la aplicación.
- **La cabecera de seguridad bloquearía el service worker.** La política de contenido empieza por `default-src 'none'` y no incluye `worker-src`, así que registrar un service worker fallaría aunque se añadiera.
- **Todo se sirve sin caché.** El servidor manda `Cache-Control: no-store` en todas las respuestas, incluidos los archivos de `/assets/`, que ya llevan el hash en el nombre y podrían cachearse indefinidamente.

El encargo incluye añadir cualquier otra pieza que falte para que la instalación funcione bien.

---

## 5. Descartado

El usuario descartó explícitamente lo siguiente.

**Avisos al terminar un comando largo.** La idea era recibir un mensaje de Telegram o una notificación web al acabar una tarea con el móvil bloqueado. Respuesta: "de momento no hace falta".

**Entrar con Face ID.** La idea era sustituir la contraseña por un passkey, o alargar la duración de la sesión. Respuesta: "de momento no hace falta".

**Teclas adicionales en la fila táctil.** La idea era añadir los símbolos que el teclado del iPhone esconde, más Ctrl+D, Ctrl+Z, Ctrl+L, Ctrl+R, Home y End, y repetición al mantener pulsadas las flechas. Respuesta: "me sobra".

**Lista de comandos frecuentes.** La idea era insertar comandos habituales con un toque. Respuesta: "me sobra".

---

## 6. Mediciones técnicas

Todo lo de esta sección se midió el 5 de septiembre de 2026 lanzando cada programa en una terminal real con `node-pty` y capturando las secuencias de control que emite. No son suposiciones.

### Claude Code v2.1.138

Una vez pasadas las pantallas de bienvenida, Claude Code emite:

- La orden de pasar a **pantalla alternativa**, `ESC [ ? 1049 h`.
- Las órdenes que activan el **reporte de ratón completo** en formato SGR: `ESC [ ? 1000 h`, `ESC [ ? 1002 h`, `ESC [ ? 1003 h` y `ESC [ ? 1006 h`.

Consecuencias:

- En pantalla alternativa no existe historial. Solo hay lo que cabe en la pantalla. Claude Code guarda la conversación en su propia memoria y la dibuja él mismo.
- Por tanto `term.scrollLines()` no sirve para nada dentro de Claude Code.
- La única forma de mover su conversación es enviarle eventos de rueda de ratón, que es exactamente lo que él espera recibir.
- Mientras está activo, se queda con los toques que caigan sobre el área de la terminal.

### Codex 0.128.0

Codex se comporta al revés que Claude Code.

- **No** usa pantalla alternativa.
- **No** activa el reporte de ratón.
- Define una región de scroll, `ESC [ 1 ; 19 r`, y va escribiendo su historial en el búfer normal.

Consecuencia: su historial sí lo guarda la terminal, y `term.scrollLines()` funciona con normalidad.

### xterm.js 6

xterm.js en la versión 6 **no tiene scroll táctil**. El problema no es de CSS ni de Safari.

- El paquete incluye el código de gestos táctiles de Visual Studio Code, pero no lo usa. El método `addTarget`, que es el que registra un elemento para recibir gestos, aparece una sola vez en todo el paquete y es su propia definición. Nadie lo llama.
- Tampoco usa el scroll nativo del navegador. Ya no existe el elemento `xterm-scroll-area` que tenían las versiones antiguas.

Por eso hoy arrastrar el dedo sobre la terminal no hace nada. El scroll táctil hay que escribirlo.

---

## 7. Orden de trabajo

Orden propuesto, sin objeción del usuario.

1. **Joystick de scroll y arreglo del reinicio, juntos.** Van unidos porque el joystick queda a medias si la posición de lectura se pierde al cambiar de aplicación.
2. **Explorador de carpetas.** Es la pieza más grande de las cuatro.
3. **PWA instalable.** Son cambios pequeños e independientes del resto.

Sobre el joystick, el usuario indicó que se harán pruebas antes de darlo por bueno.
