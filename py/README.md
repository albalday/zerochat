# Backend local y distribución Python (`py/`)

Este documento contiene las especificaciones de arquitectura, entorno local y empaquetado del backend de ZeroChat. Complementa a `AGENTS.md`.

---

## 1. Arquitectura y ensamblado de `zerochat.py`

* **Modularización:** El código fuente del backend reside dividido por dominios en `py/`.
* **Punto de entrada:** El módulo que contiene la función `main()` y el bloque de ejecución se denomina obligatoriamente `zz-main.py` para que la concatenación alfabética lo ubique siempre al final.
* **Proceso de compilación:** Cualquier cambio en `py/` requiere reconstruir el ejecutable unificado con:
  ```bash
  npm run build:backend
  ```
  Este script sincroniza los servicios gestionados, concatena ordenadamente los módulos de `py/` en `zerochat.py` y asegura sus permisos de ejecución. `zerochat.py` es un archivo autogenerado y debe mantenerse estrictamente sincronizado con `py/`.

---

## 2. Entorno local y aislamiento (`~/zerochat/`)

El backend opera de forma idéntica provenga del paquete PyPI o de la descarga con `curl`:

* **Directorio de datos:** Crea y gestiona la carpeta del usuario `~/zerochat/`, que contiene:
  * `config/`: configuración local y token diario de sesión. `config/browser.json` guarda el navegador de Playwright MCP (modo propio con motor y ventana, o el Chrome o Edge del usuario con la extensión); `ee-browser-config.py` lo valida y añade sus argumentos en cada arranque del servicio.
  * `playwright/profile/<motor>/<almacenamiento>/`: almacenamientos persistentes con nombre (`0700`) del navegador propio de Playwright MCP (por defecto funciona aislado en memoria con `--isolated`).
  * `runs/`: ficheros `<conversation_id>.json` (`0600`, directorio `0700`) con el estado en vivo de las ejecuciones en segundo plano (`--conversation`), limpiados automáticamente al concluir con éxito.
  * `services/`: servicios locales y definiciones MCP.
  * `.venv/`: entorno virtual Python aislado.
* **Aislamiento de dependencias MCP:** Las herramientas y dependencias Python de MCP se instalan y ejecutan exclusivamente dentro de `~/zerochat/.venv/`. Queda prohibido instalar dependencias en el Python global o en el entorno del comando de PyPI.
* **Ejecución del servidor:** El servidor se ejecuta con el intérprete Python que lo lanzó. No se reinstala ni se reejecuta dentro del venv aislado.
* **Ciclo de vida limpio:** Borrar `~/zerochat/` debe restablecer por completo el estado del backend y eliminar los servicios MCP sin afectar al ejecutable ni a los datos almacenados en el navegador.

---

## 3. Seguridad y red

* **Autenticación obligatoria:** Todas las peticiones al backend requieren el token diario de sesión. El token se genera al primer arranque del día, se almacena en `~/zerochat/config/token.json` con permisos `0600` (directorio `0700`) y se reutiliza durante el día para permitir recargas y reinicios sin perder la sesión. Caduca al cambiar el día también con el servidor en marcha: `verify_token` compara con el token vigente (`current_session_token`), rechaza el anterior con 401 y genera el nuevo. Se lee de `X-ZeroChat-Token` y, si falta, de `Authorization: Bearer`, que tras el proxy inverso lleva la clave del proxy. Cualquier petición de un origen permitido cuenta como presencia del navegador para el auto-cierre, aunque su token haya caducado.
* **Identificación (`zerochat/login`, `ee-login.py`):** sin token válido el servidor solo atiende `zerochat/login` (cuerpo de hasta 4096 bytes; cualquier otra petición recibe 401). Con el usuario y la contraseña de la cuenta que ejecuta `zerochat.py` devuelve `{token}`, el token diario vigente. La contraseña se comprueba con ctypes y sin dependencias: PAM con el servicio `login` en Linux y macOS (un proceso sin privilegios comprueba su propia cuenta) y `LogonUserW` en Windows; se comprueba también si el usuario es otro, para no delatar la cuenta. Un fallo devuelve el error `-32001`; tras 5 fallos seguidos los intentos se rechazan sin comprobarlos durante 15 minutos con `-32002` y `data.retryAfter` (segundos).
* **Interfaz de red:** Por defecto, el servidor escucha exclusivamente en `127.0.0.1`. Si se configura `--host` o `ZEROCHAT_HOST` para escuchar en interfaces públicas, el arranque debe mostrar una advertencia explícita sobre la exposición sin cifrar de ejecución de comandos.
* **Transporte web seguro (`zerochat/web/fetch`):** Permite al cliente web consultar páginas y búsquedas web a través del servidor local autorizado cuando está conectado, superando restricciones de CORS del navegador sin intermediarios ni proxies públicos. Incluye validación anti-SSRF de la URL pedida y de cada redirección: se bloquean los metadatos cloud, los nombres locales y cualquier host cuyas direcciones resueltas no sean públicas. El cuerpo se lee descomprimido hasta `max_bytes` (con `truncated` si había más), los tipos textuales vuelven como texto y el resto en base64.
* **Motores de Playwright (`zerochat/browser/engines/list|install|remove`):** Lista los motores propios de Playwright MCP (Chromium, Firefox, WebKit) según las rutas que da `playwright install --dry-run` (ninguno sin el Playwright del servicio, y error si no puede listarlos) y los navegadores del sistema (Chrome, Edge y Chromium para el modo extensión; Chromium no es un canal de Playwright y se lanza con `--browser=chrome`, `--executable-path` y la carpeta de su perfil como `--user-data-dir`), y si algún perfil de cada uno tiene la extensión de Playwright instalada desde la tienda (`extensions`). Instala un motor en segundo plano con el progreso de cada descarga (20 min de plazo) y lo quita solo de la caché de Playwright, con Playwright MCP detenido y sin tocar ffmpeg; nunca instala nada en el sistema. Si se quita el motor elegido en la configuración, esta pasa a otro motor instalado.
* **Configuración y datos del navegador (`zerochat/browser/config/get|set`, `zerochat/browser/data/clear`):** Lee y guarda `config/browser.json` validado (`mode`, `engine`, `userBrowser`, `headless`, `extensionToken`) con permisos 0600; el token de la extensión pasa a Playwright MCP como `PLAYWRIGHT_MCP_EXTENSION_TOKEN` solo en el modo del usuario; el cambio se aplica al siguiente arranque de Playwright MCP. En modo propio, Playwright MCP arranca por defecto con `--isolated` (en memoria, sin guardar datos al cerrar y compatible con ejecuciones concurrentes); solo usa `--user-data-dir` en `~/zerochat/playwright/profile/<engine>/<storage>` cuando el perfil indica un nombre de almacenamiento (`storage`). `zerochat/external/servers/start` exige `remember` (booleano: si el servicio se guarda como activo para ofrecerlo en la siguiente sesión) y admite para Playwright MCP `browser`, el navegador que exige el perfil activo (`{mode: own, engine[, headless: false][, storage]}` o `{mode: user, userBrowser}`), que sustituye al modo, navegador, ventana y almacenamiento de `browser.json` solo en ese arranque; la lista de servicios informa en `browser` el modo y navegador con que está en marcha. Borrar los datos elimina los almacenamientos persistentes de un motor y exige Playwright MCP detenido.
* **Transporte solo por POST y estado vivo (`zerochat/heartbeat`):** toda la API es JSON-RPC por POST (GET solo sirve la interfaz en desarrollo y el favicon). `initialize` (en `liveState`) y cada `zerochat/heartbeat` (que acepta opcionalmente `focus_conversation_id`) traen el mismo estado vivo, de `live_state()`: `cwd`, `jobs` (comandos en marcha), `exit_on_close`, `playwright`, `servers`, `runs` (resumen de ejecuciones activas o pendientes en `~/zerochat/runs/`) y `focus_run` (detalle en vivo de la conversación enfocada); el latido es la única lectura periódica de ese estado, cada 10 s solo con auto-cierre o mientras haya ejecuciones en marcha (sin ellos, el cliente lo relee al volver a la pestaña); el cliente lo publica en ChatState con `McpManager.applyLiveState`, que también recibe las respuestas de los controles (`jobs/list`, `project/set_directory`, `external/servers/start|stop|configure`) y solo escribe lo que cambia. `playwright` es `{installed, browserAction: {available, error?}}`, calculado sin lanzar Node: si está el Playwright del servicio (`services/playwright`, nunca el `node_modules` de la carpeta de arranque) y si browser_action tiene además Node y un Chromium (de Playwright, Chrome o Edge); de él dependen la disponibilidad de browser_action y las opciones de Ajustes › Navegador. `servers` es la lista de servicios MCP externos, sin tomar el cerrojo del gestor: un servicio guardado en marcha cuyo proceso ha muerto figura con `status: error` y el motivo; cuando cambian los que están en marcha, el cliente vuelve a registrar sus herramientas. Así, instalar Playwright o arrancar, detener o perder un servicio desde otra pestaña se refleja sin reconectar.
* **Perfiles generales (`zerochat/profiles/list|save|delete`):** Almacenamiento local persistente en SQLite (`~/zerochat/storage/zerochat.db`, permisos 0600) para perfiles de conexión generales (mostrados en la interfaz con `Z-`). Se cargan al conectar y al abrir el panel de perfiles, y están disponibles en la CLI (`--list-profiles` y `--prompt --profile`).
* **Conversaciones locales (`zerochat/conversations/list|get|save|rename|delete`):** Almacenamiento local persistente en SQLite (`~/zerochat/storage/zerochat.db`, permisos 0600) para las conversaciones y sus mensajes con borrado en cascada. Se cargan y sincronizan con IndexedDB en la conexión inicial y al cambiar de conexión desde el panel de Conexión, y están disponibles para inspección desde la línea de comandos mediante `--list-conversations`. Mientras una conversación tiene un proceso `--conversation` vivo en el servidor principal, `save` y `delete` desde el navegador se rechazan (`-32000`) para evitar condiciones de carrera.
* **Visor externo de diferencias (`zerochat/diff/open`):** Permite al cliente web solicitar la apertura desacoplada de `git difftool` en una ventana del sistema operativo para comparar archivos modificados frente a Git `HEAD` (o frente al último commit cuando el árbol de trabajo está limpio), sin transferir diffs por red ni cargar el contexto del modelo. Exige un visor gráfico configurado (`diff.guitool` o `merge.guitool`): sin él no lanza nada (git recurriría a una herramienta de terminal invisible) y devuelve en `setup` el visor que propone (el primero instalado de vscode, meld, kdiff3, kompare y gvimdiff, o webdiff) con las órdenes `git config --global` exactas. `zerochat/diff/configure` las aplica tras la confirmación del usuario e instala antes webdiff, con versión fijada, en `~/zerochat/.venv` si es el elegido y falta.

---

## 4. Distribución y publicación en PyPI

### Formatos de distribución

1. **Paquete PyPI (`pip install zerochat`):** Instala exclusivamente el ejecutable `zerochat.py` como comando global de consola. El paquete wheel (`.whl`) no debe contener HTML, CSS, JavaScript ni ningún otro recurso web.
2. **Descarga directa (`curl`):** Descarga el archivo ejecutable `zerochat.py` directamente.
3. Ambos modos abren siempre la interfaz web universal servida desde `https://albalday.github.io/zerochat/zerochat.html` para preservar un único origen para cookies, almacenamiento y token de sesión.

### Verificación de empaquetado

Antes de publicar cualquier versión de backend, debe verificarse la pureza del wheel:
```bash
python tests/packaging_smoke_test.py dist
```

### Procedimiento de release PyPI

1. **Preparar en `dev`:** Realizar y validar todos los cambios en la rama `dev`.
2. **Incrementar versión:** Ejecutar `npm run bump minor` o `major` (nunca editar versiones a mano).
3. **Validación completa:** Pasar la suite completa (`npm test` o `npm run test:all`).
4. **Promoción:** Promover el commit a la rama `master`.
5. **Release:** Publicar la release en GitHub, que crea también la etiqueta. Subir solo la etiqueta no publica nada: `release.yml` se lanza al publicarse la release.
   ```bash
   gh release create v<version> --target master --generate-notes
   ```
6. **Publicación automatizada:** El flujo de GitHub Actions (`release.yml`) comprueba que la etiqueta coincide con la versión de `pyproject.toml`, ejecuta los tests, genera el wheel y publica en PyPI mediante Trusted Publishing (sin credenciales manuales).

---

## 5. Modo ejecución desatendida (`--prompt` y `--conversation`)

Uso, opciones y códigos de salida para el usuario: [`help/run-mode.html`](../help/run-mode.html). Implementación en `ii-run-mode.py` (backend) y `js/run-mode.js` (interfaz).

* **Arranque y navegador:** `--prompt` y `--conversation <id>` añaden `run=<id>` al fragmento de la URL y, por defecto, abren la interfaz sin ventana con el Chromium instalado en la caché de Playwright (`playwright_chromium_executable` / `launch_playwright_chromium`) y usan el perfil general `Z-local` de SQLite (si no existe y no se indica `--profile`, terminan con error de argumentos). Con `--browser` abren el navegador predeterminado del usuario en modo visible (`launch_browser`), y con `--browser --headless` lo lanzan sin ventana sobre su perfil normal (`launch_headless_browser`, cayendo al lanzador normal si el perfil ya está en uso). Con el puerto por defecto ocupado escuchan en uno libre, salvo en desarrollo con la interfaz local, cuyo origen incluye el puerto (código 3). La pestaña de la ejecución guarda la conexión solo en memoria y no pisa la cookie de sesión de las demás.
* **Transporte y ejecución en servidor:** la interfaz del worker habla con su backend por JSON-RPC sobre POST con token: `zerochat/run/prompt` entrega una sola vez el prompt, `conversation_id` y las opciones (`profile`, `export`, `keep_page`, `allow_dangerous_tools`, `security_rules`, `global_mcp_policy`, `workspace_trust`, `allow_once`); `zerochat/run/progress` actualiza el estado en `~/zerochat/runs/<conversation_id>.json` (texto parcial, razonamiento y herramientas en curso) y el registro (recortado a 500 caracteres); `zerochat/run/export` recibe la conversación exportada (cuerpo HTTP de hasta 64 MB mientras se espera; cualquier otro método por encima del tope general de 1 MB recibe 413); `zerochat/run/result` recibe `text`, `error` o `needs_input` (cuando una conversación con `--conversation` se detiene limpiamente ante `ask_user` o una aprobación de herramienta y queda guardada en SQLite). Desde el servidor principal, la interfaz lanza y detiene ejecuciones en segundo plano con `zerochat/run/start` y `zerochat/run/cancel`.
* **Fin de la ejecución:** `run_supervisor` detiene el servidor al recibir el resultado, si termina el proceso de Chromium de Playwright, al agotar el plazo total (900 s) o tras 180 s sin progreso; el latido detecta el navegador cerrado. Las variables `ZEROCHAT_RUN_TIMEOUT` y `ZEROCHAT_RUN_IDLE_SECONDS` solo las usan las pruebas.
* **Salidas:** stdout queda para la respuesta final (o el JSON de `needs_input` con `--conversation`); la cabecera y el registro van a stderr con `--log on` y se descartan con `--log off` (por defecto). El motivo de un final sin respuesta va siempre a stderr. Códigos: 0 terminado (o pausado en `needs_input` con `--conversation`), 1 error de generación, 2 plazo o navegador cerrado, 3 fallo de arranque, 4 argumentos no válidos (`ZeroChatArgumentParser`, en cualquier modo).
