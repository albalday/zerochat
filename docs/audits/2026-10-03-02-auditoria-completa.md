# Auditoría completa de código — ZeroChat 8.10.3

- **Fecha**: 2026-10-03
- **Procedimiento**: `docs/audits/AuditFull.md`
- **Normas de referencia**: `AGENTS.md`, `tests/README.md`, `js/tools/README.md`
- **Rama y commit auditados**: `dev` @ `340693b` (versión `8.10.3`)
- **Enfoque**: auditoría externa sobre el estado actual del árbol. No se han consultado
  versiones anteriores, diffs ni auditorías previas. Cada hallazgo se ha comprobado con
  referencias estáticas en el código y, cuando se indica, se ha reproducido en Node.js o Python.
- **Estado del informe**: abierto. Los hallazgos están pendientes de corrección o de
  aceptación explícita.

## 1. Línea base

| Comando | Resultado |
| --- | --- |
| `git status --short` (antes) | Árbol limpio |
| `npm test` | 758 pruebas, 758 correctas, 0 fallos (15,8 s) |
| `npm run test:browser` | 105 pruebas, 105 correctas, 0 fallos (4,4 s) |
| `npm run build` | Correcto (`build:vendor`, `build:managed-services`, `build:backend`) |
| `git status --short` (después) | Árbol limpio: `zerochat.py`, `py/dd-managed-services.py` y `js/vendor/orama.browser.js` ya estaban sincronizados |

En la salida de `npm test` aparecen trazas `console.error` (`[WebLLM] Preparation error`,
`[ChatAgentCore] Error during auto-synthesis`). Son esperadas: las provocan pruebas de errores
de WebLLM y de síntesis. Las pruebas de navegador no muestran errores de consola.

Limitaciones del entorno: Linux, Node 24 y Chromium de Playwright. No se ha probado Windows
(rama PowerShell de `dd-tools.py`) ni la instalación real de MCP con npm.

## 2. Resumen de hallazgos

| ID | Hallazgo | Riesgo | Prioridad |
| --- | --- | --- | --- |
| S2 | Cifrado de perfiles y API keys con clave pública por defecto y derivación débil | Seguridad | **Alta** |
| S3 | Cookies, almacenamiento y CORS compartidos con todo `albalday.github.io` | Seguridad | **Alta** |
| E1 | El gestor MCP bloquea todas las herramientas durante instalaciones y OAuth | Estabilidad | **Alta** |
| S1 | `apiUrl` y campos de perfiles importados sin validar | Seguridad | Media |
| S4 | El token del backend es diario, se guarda sin permisos restrictivos y `--host` no se valida | Seguridad | Media |
| S6 | `ChatI18n.t` no escapa los parámetros de plantillas con HTML | Seguridad / presentación | Media |
| S7 | `ToolExecutor` adivina argumentos que no son JSON válido | Seguridad | Media |
| S8 | La codificación de nombres MCP no es inyectiva | Seguridad / estabilidad | Media |
| E2 | `StdioMcpClient` sin límites de tamaño ni cierre del árbol de procesos | Estabilidad | Media |
| E3 | `execute_command` con `cwd` explícito no termina subprocesos y oculta errores | Estabilidad | Media |
| E4 | La cancelación no llega a las herramientas web; hay dos `fetchWithTimeout` incompatibles | Estabilidad | Media |
| E5 | `ChatState` pierde notificaciones anidadas y comparte referencias | Estabilidad | Media |
| A1 | `app.js` concentra lógica de dominio (modo importación, latido, telemetría) | Deuda técnica | Media |
| A2 | Lógica de estado de generación triplicada, con escrituras directas en `ui` | Deuda técnica | Media |
| P1 | Texto visible fuera de `ChatI18n` | Presentación | Media |
| E6 | El Service Worker puede activar una caché incompleta o mezclar versiones | Estabilidad | Baja |
| P2 | Emojis crudos en controles y cabeceras interactivas | Presentación | Baja |
| A3 | 17 envoltorios `t()` locales y 165 textos de respaldo en español | Deuda técnica | Baja |
| R1 | Documentación normativa desalineada con el código | Deuda técnica | Baja |

No se encontraron infracciones en estas áreas:

- No hay diálogos nativos (`alert`, `confirm`, `prompt`) ni alias suyos.
- Las claves de `ChatI18n` están a la par en español e inglés (681/681), y todas las claves referenciadas existen.
- Todos los proveedores extienden `BaseProviderAdapter`.
- Las herramientas no usan `ui` ni `handler`.
- Los módulos de `js/` están todos cargados en `zerochat.html` y precacheados en `sw.js`.

## 3. Hallazgos detallados

### S2 — Cifrado de perfiles y API keys con clave pública por defecto y derivación débil · Alta

**Evidencia** (`js/profile-backup.js`)
- `:18` y `:51-53`: sin contraseña, la clave AES-GCM es `SHA-256('ZeroChat profile transfer key v1')`.
  Es una constante publicada en el código.
- `:93-96`: con contraseña, la clave es un único `SHA-256(password)`, sin sal ni iteraciones.
- `:62-87`: la clave derivada se guarda en `localStorage` (`zerochat_crypto_session_v1`)
  durante 24 h, en claro.
- `js/profile-repository.js:165`: las API keys se guardan con `encryptApiKey`, que usa la clave
  cacheada o, si no la hay, la clave por defecto.

**Riesgo**
- Sin contraseña, el cifrado es solo ofuscación. Cualquiera con el archivo exportado o con
  acceso a `localStorage` obtiene las API keys.
- Con contraseña, la ausencia de sal y de coste permite ataques de diccionario masivos a los
  paquetes exportados.
- Con la clave cacheada, cualquier script del origen (por ejemplo, vía S3) descifra las claves sin conocer
  la contraseña.

**Alcance y alternativa**
- Derivar la clave con PBKDF2-SHA-256 (WebCrypto, ≥ 600 000 iteraciones) y una sal aleatoria
  guardada en el sobre del archivo.
- Versionar el formato (`VERSION = 2`) y migrar al descifrar.
- Cachear solo una `CryptoKey` no extraíble en memoria, o en IndexedDB, que puede guardar
  `CryptoKey` no extraíbles. Nunca el material en bruto en `localStorage`.
- Documentar en `/help` que sin contraseña las claves no están protegidas, o exigir contraseña al exportar.

**Prueba**
- Unitaria: dos cifrados con la misma contraseña producen sobres con sal distinta.
- Unitaria: un archivo v1 se migra.
- Unitaria: `localStorage` no contiene material de clave tras `cacheKeyMaterial`.

### S3 — Cookies, almacenamiento y CORS compartidos con todo `albalday.github.io` · Alta

**Evidencia**
- `js/cookies.js:159`: la cookie de sesión del backend (`token`, `host`, `port`) se crea con `Path=/`.
- `js/cookies.js:61`: las preferencias se crean con `path=/`.
- `py/ee-mcp.py:116-127` (`is_allowed_origin`): acepta cualquier página de `https://albalday.github.io`.
- `localStorage` e IndexedDB pertenecen al origen completo. Lo comparten todos los
  repositorios publicados en GitHub Pages bajo ese usuario.
- `js/cookies.js:197-225` (`clearAllStorage`): ejecuta `localStorage.clear()` y
  `sessionStorage.clear()`, y borra todas las cookies del origen.

**Riesgo**
Cualquier página de otro repositorio del mismo usuario en GitHub Pages puede:
- leer el token del backend local y llamar a `http://127.0.0.1:<puerto>` con un origen permitido;
- leer las API keys cifradas y la clave cacheada (S2).

Una vulnerabilidad o dependencia de terceros en cualquiera de esas páginas compromete ZeroChat.
Además, «Borrar datos» en ZeroChat borra los datos de las demás aplicaciones del origen.

**Alcance y alternativa**
1. A corto plazo:
   - limitar las cookies a `Path=/zerochat/`;
   - restringir `is_allowed_origin` a `https://albalday.github.io` y validar además el
     `Referer` o una cabecera propia (el `Origin` no incluye la ruta);
   - limpiar solo las claves con prefijo `zerochat_` en `clearAllStorage`.
2. A medio plazo: servir la interfaz desde un origen dedicado (dominio propio o subdominio) y
   documentar el riesgo como aceptado mientras tanto.

**Prueba**
- Unitaria (`test_cookies.js`): la cookie del backend se escribe con `Path=/zerochat/`.
- Unitaria: `clearAllStorage` conserva claves ajenas a `zerochat_`.
- Infraestructura: tabla de orígenes aceptados y rechazados.

### E1 — El gestor MCP bloquea todas las herramientas durante instalaciones y OAuth · Alta

**Evidencia** (`py/ee-mcp.py`)
- `start()` (`:493-549`) mantiene `self._lock` durante todo este trabajo:
  - `_prepare_service`: `npm install` (`timeout=600`) y `playwright install` (`timeout=600`);
  - el handshake, que puede durar hasta `handshakeTimeoutSeconds` (150 s en Composio, a la
    espera de la autorización OAuth del usuario).
- `tools()` (`:578-596`), `call()` (`:598-614`), `stop()`, `configure()` y `close()` adquieren el mismo cerrojo.

**Riesgo**
Mientras un servicio se instala o espera OAuth (hasta unos 22 minutos en el peor caso), las
llamadas `tools/list` y `tools/call` de los demás servidores se bloquean. También se bloquean
las peticiones HTTP que las atienden. El agente se queda colgado y el usuario no puede detener
el servicio que causa el bloqueo.

**Alcance y alternativa**
1. Separar en `start()` una fase rápida protegida (estado `installing`/`starting` y reserva del
   identificador) de la fase lenta sin cerrojo (instalación, `Popen` y handshake).
2. Publicar el cliente bajo el cerrojo solo al terminar.
3. Permitir que `stop()` cancele un arranque en curso.

**Prueba**
Infraestructura (`test_local_server.js`): un servicio simulado con handshake de 5 s no impide
que `call()` de otro servidor responda en menos de 1 s.

### S1 — `apiUrl` y campos de perfiles importados sin validar · Media

**Evidencia**
- `js/config-store.js:52`: `apiUrl` solo se recorta (`trim`). No se valida el esquema ni el formato.
- `js/profile-repository.js:49-63` (`normalizeSettings`): clona los campos importados sin validar
  tipo ni valor. `mergeImported` (`:207-232`) acepta perfiles de un archivo o del paquete de
  exportación y sustituye en silencio los que tengan el mismo `id`.
- `zerochat.html:22`: la CSP incluye `script-src 'unsafe-inline'`, así que cualquier punto que
  interpole estos valores en HTML sin escapar ejecutaría atributos `onerror`/`onload` inyectados.

**Riesgo**
Un perfil compartido introduce valores arbitrarios en la configuración. Hoy no hay un punto
conocido que los interprete como HTML, pero cualquier consumidor nuevo que no escape abriría un
XSS en el origen de la aplicación, con acceso al token del backend (S3) y a `tools/call`.

**Alcance y alternativa**
1. Validar `apiUrl` en `ConfigStore.normalize` y en `normalizeSettings`. Admitir solo `http:`,
   `https:` o `mirror:` mediante `new URL`, y rechazar el perfil en caso contrario.
2. Validar en `normalizeSettings` el tipo de cada campo importado (cadenas, números, booleanos,
   `enabledTools` como mapa de booleanos).

**Prueba**
- Integración: `ChatProfileRepository.mergeImported` rechaza `apiUrl` no HTTP(S) y tipos inválidos.

### S4 — El token del backend es diario, se guarda sin permisos restrictivos y `--host` no se valida · Media

**Evidencia**
- `py/cc-environment.py:61-84`: `get_daily_token` reutiliza el mismo token todo el día y lo
  guarda en `~/zerochat/config/token.json` con los permisos por defecto (umask, normalmente 0644).
  `get_data_dir` crea los directorios sin `0o700`.
- `py/cc-environment.py:87`: el token se genera y escribe al importar el módulo, antes de
  procesar los argumentos.
- `py/zz-main.py:12`: `--token` en la línea de comandos queda visible en `ps`.
- `py/zz-main.py:11` y `:64`: `--host`/`ZEROCHAT_HOST` aceptan `0.0.0.0` sin aviso, lo que
  expone ejecución de comandos a la red local con un token que dura todo el día.

**Riesgo**
`AGENTS.md` exige un «token efímero de sesión», pero el token dura un día. En sistemas
multiusuario o con copias de seguridad del directorio personal, el token es legible por otros.

**Alcance y alternativa**
- Crear `config/` con `0o700` y `token.json` con `0o600` (escritura atómica con `os.open`).
- Mover la generación a `main()`.
- Aceptar el token también por variable de entorno.
- Rechazar `--host` distinto de bucle local salvo con un indicador explícito (`--allow-remote`) y aviso.
- Si el token diario es una decisión de producto (pestañas nuevas tras reinicio), documentarla
  en `AGENTS.md`.

**Prueba**
- Infraestructura: los permisos de `token.json` son `0o600`.
- Infraestructura: `--host 0.0.0.0` sin `--allow-remote` termina con error.

### S6 — `ChatI18n.t` no escapa los parámetros de plantillas con HTML · Media

**Evidencia**
- Varias plantillas contienen HTML (`err_no_model_desc`, `err_api_connect`), de modo que cada
  llamador decide si escapa los parámetros. `ui-inspector.js:610` y `generation-controller.js`
  lo hacen; no hay ninguna garantía para los demás.

**Alcance y alternativa**
- Separar las claves con HTML (`*_html`) o dejar que `t()` escape los parámetros en las plantillas HTML.

**Prueba**
- Unitaria (`test_i18n.js`): un parámetro con `<` en una plantilla HTML se inserta escapado.

### S7 — `ToolExecutor` adivina argumentos que no son JSON válido · Media

**Evidencia** (`js/agent-core.js`)
- `:557-576`: si los argumentos no son JSON válido, `parseArguments` extrae `url`, `query` o
  `code` con expresiones regulares y ejecuta la herramienta con valores adivinados (por ejemplo,
  código truncado para `execute_javascript`).

**Riesgo**
Una herramienta ejecuta argumentos que el modelo no emitió.

**Alcance y alternativa**
- Devolver al modelo un error explícito de argumentos inválidos en lugar de adivinarlos.

**Prueba**
- Integración: argumentos no JSON producen `ToolOutcome` de error sin llamar a `execute`.

### S8 — La codificación de nombres MCP no es inyectiva · Media

**Evidencia**
- `js/mcp.js:35-49` y `py/ee-mcp.py:130-142` conservan `[a-zA-Z0-9]`, incluida la `z`.
- `js/tools/README.md` afirma que solo se conservan `a-y` y `0-9` y que `z` y las mayúsculas se escapan.
- Reproducido en Python: `public_tool_name('_', 'x') == public_tool_name('z5fz', 'x') == 'z5fz_x'`.
- `py/ee-mcp.py:598-614` (`call`): ante una colisión ejecuta la primera coincidencia.
- `tools()` (`:592-594`) descarta en silencio los nombres que fallan.

**Riesgo**
Un servicio con un identificador elegido puede ocultar herramientas de otro o recibir sus
llamadas, y los permisos persistidos por identificador canónico se aplican a la herramienta
equivocada.

**Alcance y alternativa**
- Restablecer la codificación documentada: escapar `z` y las mayúsculas en JS y Python a la vez.
- Rechazar los duplicados también en `McpServiceManager.tools()`.
- Registrar los descartes.

**Prueba**
- Unitaria cruzada JS/Python con la misma tabla de casos: `_`↔`z5fz`, mayúsculas y límite de 64 caracteres.

### E2 — `StdioMcpClient` sin límites de tamaño ni cierre del árbol de procesos · Media

**Evidencia** (`py/ee-mcp.py`)
- `_read_stdout` (`:230-258`) lee líneas sin límite. Una respuesta enorme o sin salto de línea
  agota la memoria y se reenvía al navegador sin tope.
- `stop()` (`:295-310`) termina solo el proceso directo. `Popen` (`:175`) no crea grupo de
  procesos, así que los hijos (`npm`, `node`, navegadores de Playwright) quedan huérfanos.
- `request()` (`:260-284`) escribe en `stdin` mientras retiene `self._lock`. Si el hijo no lee,
  se bloquean todas las peticiones.
- `call()` usa el `timeout=30` por defecto para `tools/call`, que es insuficiente para
  automatización de navegador.

**Alcance y alternativa**
- Limitar el tamaño de línea y de resultado; por ejemplo, devolver un error por encima de `MAX_HTTP_BODY_BYTES`.
- Usar `start_new_session=True` y terminar el grupo, como ya hace `_kill_process_tree` en `dd-tools.py`.
- Escribir fuera del cerrojo.
- Hacer configurable el tiempo de `tools/call` por servicio.

**Prueba**
- Infraestructura: un MCP simulado que emite 5 MB en una línea produce un error controlado.
- Infraestructura: `stop()` no deja procesos hijos.

### E3 — `execute_command` con `cwd` explícito no termina subprocesos y oculta errores · Media

**Evidencia** (`py/dd-tools.py`)
- `:417-446`: con un `cwd` distinto del de la sesión, se usa `subprocess.run(..., shell=True,
  timeout=…)`. Al vencer el plazo solo se mata el shell; los nietos siguen vivos. La sesión
  persistente sí usa `_kill_process_tree`.
- `:423-425`: un `cwd` inexistente se sustituye en silencio por `Path.cwd()`. El comando se
  ejecuta en otro directorio del que autorizó el usuario.
- `:387` y `:431`: `communicate`/`capture_output` acumulan toda la salida en memoria antes de truncarla.

**Alcance y alternativa**
- Reutilizar `_run_runner` o `Popen` con grupo de procesos para ambos caminos.
- Devolver un error si `cwd` no existe.
- Leer la salida con un límite y descartar el exceso.

**Prueba**
- Infraestructura: `sleep 100 & sleep 100` con tiempo de 1 s no deja procesos.
- Infraestructura: `cwd` inexistente → error.

### E4 — La cancelación no llega a las herramientas web; hay dos `fetchWithTimeout` incompatibles · Media

**Evidencia**
- `js/utils.js:112-124`: `fetchWithTimeout` sustituye la `signal` del llamador por la suya, así
  que la cancelación del usuario se ignora.
- `js/mcp.js:130-146`: la otra implementación hace lo contrario. Si llega una `signal`, el
  temporizador deja de tener efecto.
- `js/web-browser.js`, `js/web-search.js` y las herramientas `search-web`, `fetch-web-page` y
  `download-pdf` no contienen ninguna referencia a `signal`. El pipeline de `web-browser.js`
  encadena estrategias de hasta 12 s cada una.

**Riesgo**
Tras pulsar «Detener», las peticiones web siguen hasta agotar sus plazos. Es justo la
duplicación con contratos divergentes que `AuditFull.md` pide priorizar.

**Alcance y alternativa**
1. Una única `ChatUtils.fetchWithTimeout(resource, options, timeoutMs)` que combine ambas
   señales (`AbortSignal.any` o un enlace manual).
2. Eliminar la copia de `mcp.js`.
3. Propagar `context.signal` desde las herramientas al pipeline.

**Prueba**
- Unitaria: abortar la señal externa rechaza antes del plazo.
- Unitaria: el plazo vence aunque exista señal externa.
- Integración: cancelar `fetch_web_page` detiene la estrategia en curso.

### E5 — `ChatState` pierde notificaciones anidadas y comparte referencias · Media

**Evidencia** (`js/state.js`)
- `:331-347`: con `isEmitting`, una escritura hecha desde un listener cambia el estado pero no
  notifica a ningún suscriptor. Los listeners posteriores reciben una instantánea anterior.
- `:220-229` y `:262-268`: al fusionar slices de objeto, `Object.assign({}, prev, next)` guarda
  por referencia los objetos anidados del llamador, sin clonar. Una mutación posterior del
  llamador altera el estado sin pasar por los mutadores.
- `:339`: los listeners reciben además `nextState` y `prevState` internos (mutables).

**Riesgo**
Esto contradice la garantía de cambios atómicos y sincronizados de `AGENTS.md` §3. Pueden
aparecer desincronizaciones difíciles de reproducir entre interfaz y estado.

**Alcance y alternativa**
- Encolar las notificaciones anidadas y emitirlas al terminar.
- Clonar `nextVal` en la fusión.
- Dejar de pasar el estado interno a los listeners.

**Prueba**
- Unitaria (`test_state.js`): un listener que escribe provoca una segunda notificación.
- Unitaria: mutar el objeto pasado a `set` no altera `get`.

### A1 — `app.js` concentra lógica de dominio · Media

**Evidencia**
`js/app.js` tiene 1893 líneas y 84 funciones. Incluye:
- el modo de importación de perfiles por `postMessage`: descifrado, confirmación, fusión,
  respuesta al opener y banner (`:1484-1745`);
- el latido del backend (`buildHeartbeatUrl`, `sendHeartbeatPing`, `startServerHeartbeat`);
- la telemetría (`State.set('telemetry', …)` en `:628-655`);
- una copia del estado de generación (A2).

`AGENTS.md` §3 dice que `app.js` solo coordina y que la lógica específica vive en su módulo.

**Alcance y alternativa**
Mover cada bloque a su módulo, en cambios separados:
- importación → `ui-transfer.js` o un `profile-import-service.js`;
- latido → `mcp.js` o un servicio propio.

No hace falta cambiar comportamiento.

**Prueba**
Las pruebas existentes de arranque e importación (`test_app_startup.js`,
`browser_profiles_settings.test.js`) más una unitaria del nuevo servicio con `postMessage` simulado.

### A2 — Lógica de estado de generación triplicada · Media

**Evidencia**
Aparece la misma máquina de fases (`phaseChanged`, `startedAt`) en:
- `js/state.js:620-660` (`setGenerationStatus`, `clearGenerationStatus`);
- `js/ui-generation-status.js:85-117` (rama alternativa con `State.set('ui', …)`);
- `js/app.js:519-556` (rama alternativa con `State.set('ui', …)`).

Las dos ramas alternativas solo se ejecutan si falta un módulo que `zerochat.html` carga
siempre, y escriben el slice `ui` saltándose los mutadores. Lo mismo ocurre en
`js/attachments.js:53-56` (alternativa a `setAttachments`).

**Alcance y alternativa**
- Eliminar las ramas alternativas y delegar en `ChatState.setGenerationStatus` y `setAttachments`.
- Añadir una prueba de arquitectura que prohíba `State.set('ui'` fuera de `state.js` e `ui-inspector.js`.

**Prueba**
Las pruebas de `test_ui_generation_status.js`, `test_attachments.js` y la nueva regla de arquitectura.

### P1 — Texto visible fuera de `ChatI18n` · Media

**Evidencia**
- `js/markdown.js:446-458`: «Console:», «Retorno:», «Error».
- `js/mcp.js:804-808`: «Sin salida», «Error».
- `js/app.js:1726-1732`: banner «Importando perfiles…», solo en español.
- `js/profile-repository.js` y `js/profile-backup.js` lanzan errores en español
  (`'Los cambios de este perfil están bloqueados.'`, `'La contraseña de cifrado no es válida.'`…)
  que llegan a `ChatDialogs.alert`.
- `js/profile-export-bundle.js:270-480`: la página HTML generada para importar está solo en español.

**Alcance y alternativa**
- Sustituir por claves de `ChatI18n`.
- Usar errores con código (`error.code`) traducidos en la capa de UI.

**Prueba**
- Unitaria: con `setLanguage('en')`, los resultados de `execute_javascript` en `markdown.js` y
  de MCP en `mcp.js` no contienen palabras en español.

### E6 — El Service Worker puede activar una caché incompleta o mezclar versiones · Baja

**Evidencia** (`sw.js:95-168`)
- La instalación usa `Promise.allSettled` y descarta fallos, y después llama a `skipWaiting()`.
- La estrategia stale-while-revalidate actualiza archivos individuales en la caché activa, de
  modo que una pestaña puede combinar `zerochat.html` de una versión con módulos de otra.

**Alcance y alternativa**
- Fallar la instalación si falta algún recurso del precache.
- Servir `zerochat.html` y `js/` con caché por versión, sin actualización parcial.

**Prueba**
Unitaria (`test_service_worker.js`): un recurso que falla aborta `install`.

### P2 — Emojis crudos en controles y cabeceras interactivas · Baja

**Evidencia**
- `js/profile-export-bundle.js:287` (🚀 en el botón «Importar»), además de 📦, 🔄, ⚠️, ✅ y ❌ en los estados.
- `js/attachments.js:184` (📕, 🖼️ y 📎 en el texto del mensaje: admisible según `AGENTS.md`).

**Alcance y alternativa**
Usar `ChatIcons` en el botón y los estados de la página de exportación, y dejar los del texto del mensaje.

**Prueba**
Ampliar `test_ui_modernization.js` para cubrir la página generada por `profile-export-bundle.js`.

### A3 — 17 envoltorios `t()` locales y 165 textos de respaldo · Baja

**Evidencia**
- 17 módulos redefinen `function t(key, params)`: `app.js:58`, `debug.js:27`, `rag-ui.js:34`, `ui-*.js`…
- Hay 165 expresiones `t('clave') || 'texto en español'`. En el navegador el respaldo nunca se
  usa: `ChatI18n.t` devuelve la propia clave si falta. Solo actúan en Node sin `ChatI18n`.

**Alcance y alternativa**
- Usar un único acceso `ChatUtils.resolveDep('ChatI18n')`.
- Eliminar los respaldos de forma progresiva, por módulo, cuando se toquen.

No se recomienda un cambio masivo.

### R1 — Documentación normativa desalineada con el código · Baja

**Evidencia**
- `AGENTS.md` §4 habla de «token efímero de sesión», pero el token es diario (S4).
- `js/tools/README.md` describe una codificación de nombres distinta de la implementada (S8).
- `AGENTS.md` §9 reserva `docs/audits/` para informes cerrados, pero guarda ahí el procedimiento `AuditFull.md`.

**Alternativa**
Corregir los textos en un único cambio `docs:`. Valorar si `AuditFull.md` debe trasladarse
junto a las normas (por ejemplo, como sección o anexo de `AGENTS.md`).

### Observación — fuentes externas de las herramientas web

`js/web-browser.js:223` y `:304` y `js/web-search.js:263` envían las URL y consultas del
usuario a servicios de terceros: `r.jina.ai`, `api.allorigins.win` y DuckDuckGo. No es un
defecto, pero debe constar en la ayuda (`/help`) como tratamiento de datos. No se clasifica como hallazgo.

## 4. Interfaces públicas que no pueden cambiarse sin migración

- **Formato `zerochat-profile-backup` v1 y sobre de API key** (`profile-backup.js`): S2 exige
  un formato v2 con migración de lectura v1.
- **Cookie `zerochat_backend_session_v1`** (`cookies.js`): cambiar `Path` (S3) requiere borrar
  la cookie antigua con `Path=/`.
- **Nombres públicos de herramientas MCP** (`publicToolName` en JS y Python) y permisos
  persistidos por identificador canónico en `localStorage` (`tool-security.js`). Cambiar la
  codificación (S8) invalida las autorizaciones guardadas. `js/tools/README.md` descarta migrar
  nombres antiguos, así que hay que documentarlo y avisar.
- **Mensajes `postMessage` `zerochat_import_ready`, `import_profiles` e `import_result`**
  (`app.js` ↔ `profile-export-bundle.js`): los paquetes ya exportados dependen de ellos (A1).
- **`ChatState` y sus mutadores**, consumidos por todos los módulos de UI (E5).
- **Esquema `service.json`/`installer.json`** de `services/` y las variables `${serviceDir}`,
  `${nodeExecutable}`, `${pythonExecutable}` y `${option:…}`.
- **Cabeceras `X-ZeroChat-Token` y `X-ZeroChat-Tool-*`** y el algoritmo de firma `zerochat-tool-auth-v1`.

## 5. Plan de corrección

Cada paso es un cambio pequeño e independiente, con sus pruebas y con `npm run build:backend`
cuando toque `py/`. No se mezclan limpieza, funciones nuevas y refactorización.

| Orden | Cambio | Hallazgos | Validación mínima |
| --- | --- | --- | --- |
| 1 | `fix:` validar URL y tipos en configuración y perfiles importados | S1 | `test:unit`, `test:integration`, `test:browser` |
| 2 | `fix:` escapar parámetros en las plantillas HTML de `ChatI18n` | S6 | `test:unit` |
| 3 | `fix:` cookies con `Path=/zerochat/`, origen y `Referer` en backend, limpieza por prefijo | S3 | `test:unit`, `test:infrastructure`, `test:browser` |
| 4 | `feat:` formato de cifrado v2 (PBKDF2 + sal) con migración v1 y caché no extraíble | S2 | `test:unit`, `test:integration`, `test:browser` |
| 5 | `fix:` permisos de token y datos, generación en `main()`, control de `--host` | S4 | `test:infrastructure` |
| 6 | `fix:` arranque MCP sin cerrojo durante instalación y handshake | E1 | `test:infrastructure` |
| 7 | `fix:` límites de tamaño, grupo de procesos y tiempo configurable en MCP stdio | E2 | `test:infrastructure` |
| 8 | `fix:` `execute_command` con grupo de procesos, error por `cwd` inválido y salida acotada | E3 | `test:infrastructure` |
| 9 | `fix:` codificación inyectiva de nombres MCP (JS y Python) y rechazo de duplicados | S8 | `test:unit`, `test:integration`, `test:infrastructure` |
| 10 | `fix:` sin argumentos adivinados en `ToolExecutor` | S7 | `test:integration` |
| 11 | `refactor:` `fetchWithTimeout` único y `signal` en herramientas web | E4 | `test:unit`, `test:integration` |
| 12 | `fix:` notificaciones anidadas y clonado en `ChatState` | E5 | `test:unit`, `test:integration` |
| 13 | `fix:` precache estricto en el Service Worker | E6 | `test:unit`, `test:browser` |
| 14 | `fix:` textos a `ChatI18n` | P1, P2 | `test:unit`, `test:browser` |
| 15 | `refactor:` extraer importación de perfiles y latido de `app.js` | A1 | `test:integration`, `test:browser` |
| 16 | `refactor:` eliminar ramas alternativas de estado de generación y adjuntos, con prueba de arquitectura | A2 | `test:architecture`, `test:unit` |
| 17 | `chore:` unificar envoltorios `t()` y retirar textos de respaldo por módulo | A3 | Todas las aplicables |
| 18 | `docs:` alinear `AGENTS.md` (token), `js/tools/README.md`, ubicación de `AuditFull.md` y `/help` (ES/EN) | R1, observación | — |

Pruebas de arquitectura nuevas que se proponen, para impedir que se reintroduzcan los problemas:

- `State.set('ui'|'sessions'|'messages'` prohibido fuera de `state.js` y de una lista explícita de excepciones;
- `t(` con parámetros dentro de una plantilla `innerHTML` sin `escapeHtml`, con una lista
  blanca de parámetros numéricos;
- emojis en `button`, `summary` y `[role=button]`;
- un único `fetchWithTimeout` en el repositorio.

## 6. Criterio de cierre

Esta versión no es mayor (`8.10.3`), así que el procedimiento no bloquea la promoción. Aun
así, antes del próximo `X.0.0` deben quedar resueltos o aceptados explícitamente los hallazgos
**S2, S3 y E1**. Después hay que repetir `npm test`, `npm run test:browser` y
`npm run build`, comprobar que el árbol queda limpio y actualizar este informe con el estado de
cada hallazgo antes de considerarlo cerrado.
