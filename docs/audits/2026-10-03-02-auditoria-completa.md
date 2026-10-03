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
| E1 | El gestor MCP bloquea todas las herramientas durante instalaciones y OAuth | Estabilidad | **Alta** |
| S1 | `apiUrl` y campos de perfiles importados sin validar | Seguridad | Media |
| S6 | `ChatI18n.t` no escapa los parámetros de plantillas con HTML | Seguridad / presentación | Media |
| E4 | La cancelación no llega a las herramientas web; hay dos `fetchWithTimeout` incompatibles | Estabilidad | Media |
| E5 | `ChatState` pierde notificaciones anidadas y comparte referencias | Estabilidad | Media |
| A1 | `app.js` concentra lógica de dominio (modo importación, latido, telemetría) | Deuda técnica | Media |
| P1 | Texto visible fuera de `ChatI18n` | Presentación | Media |
| S3 | «Borrar datos» elimina cachés y Service Workers ajenos a ZeroChat | Estabilidad | Baja |
| E6 | El Service Worker puede mezclar versiones | Estabilidad | Baja |
| P2 | Emojis crudos en controles y cabeceras interactivas | Presentación | Baja |
| A3 | 17 envoltorios `t()` locales y 165 textos de respaldo en español | Deuda técnica | Baja |

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
- Con la clave cacheada, cualquier script del origen descifra las claves sin conocer la contraseña.

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

### E1 — El gestor MCP bloquea todas las herramientas durante instalaciones y OAuth · Alta

**Evidencia** (`py/ee-mcp.py`)
- `start()` (`:582-639`) mantiene `self._lock` durante todo este trabajo:
  - `_prepare_service`: `npm install` (`timeout=600`) y `playwright install` (`timeout=600`);
  - el handshake, que puede durar hasta `handshakeTimeoutSeconds` (150 s en Composio, a la
    espera de la autorización OAuth del usuario).
- `tools()` (`:668-693`), `call()` (`:695-715`), `stop()`, `configure()` y `close()` adquieren el mismo cerrojo.

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
XSS en el origen de la aplicación, con acceso al token del backend y a `tools/call`.

**Alcance y alternativa**
1. Validar `apiUrl` en `ConfigStore.normalize` y en `normalizeSettings`. Admitir solo `http:`,
   `https:` o `mirror:` mediante `new URL`, y rechazar el perfil en caso contrario.
2. Validar en `normalizeSettings` el tipo de cada campo importado (cadenas, números, booleanos,
   `enabledTools` como mapa de booleanos).

**Prueba**
- Integración: `ChatProfileRepository.mergeImported` rechaza `apiUrl` no HTTP(S) y tipos inválidos.

### S6 — `ChatI18n.t` no escapa los parámetros de plantillas con HTML · Media

**Evidencia**
- Varias plantillas contienen HTML (`err_no_model_desc`, `err_api_connect`), de modo que cada
  llamador decide si escapa los parámetros. `ui-inspector.js:610` y `generation-controller.js`
  lo hacen; no hay ninguna garantía para los demás.

**Alcance y alternativa**
- Separar las claves con HTML (`*_html`) o dejar que `t()` escape los parámetros en las plantillas HTML.

**Prueba**
- Unitaria (`test_i18n.js`): un parámetro con `<` en una plantilla HTML se inserta escapado.

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
- la telemetría (`State.set('telemetry', …)` en `:628-655`).

`AGENTS.md` §3 dice que `app.js` solo coordina y que la lógica específica vive en su módulo.

**Alcance y alternativa**
Mover cada bloque a su módulo, en cambios separados:
- importación → `ui-transfer.js` o un `profile-import-service.js`;
- latido → `mcp.js` o un servicio propio.

No hace falta cambiar comportamiento.

**Prueba**
Las pruebas existentes de arranque e importación (`test_app_startup.js`,
`browser_profiles_settings.test.js`) más una unitaria del nuevo servicio con `postMessage` simulado.

### P1 — Texto visible fuera de `ChatI18n` · Media

**Evidencia**
- `js/app.js:1726-1732`: banner «Importando perfiles…», solo en español.
- `js/profile-repository.js` y `js/profile-backup.js` lanzan errores en español
  (`'Los cambios de este perfil están bloqueados.'`, `'La contraseña de cifrado no es válida.'`…)
  que llegan a `ChatDialogs.alert`.
- `js/profile-export-bundle.js:270-480`: la página HTML generada para importar está solo en español.

**Alcance y alternativa**
- Sustituir por claves de `ChatI18n`.
- Usar errores con código (`error.code`) traducidos en la capa de UI.

**Prueba**
- Unitaria: con `setLanguage('en')`, los errores de perfiles y el banner de importación no
  contienen palabras en español.

### S3 — «Borrar datos» elimina cachés y Service Workers ajenos a ZeroChat · Baja

**Evidencia**
- `js/cookies.js` (`clearAllStorage`): borra todas las cachés de Cache Storage y anula todos los
  Service Workers del origen `albalday.github.io`, que comparten las demás páginas de GitHub Pages
  del mismo usuario.

**Alcance y alternativa**
Limitar el borrado a las cachés con prefijo de ZeroChat y a los registros cuyo `scope` sea el de ZeroChat.

**Prueba**
Unitaria: `clearAllStorage` conserva cachés y registros de Service Worker ajenos.

### E6 — El Service Worker puede mezclar versiones · Baja

**Evidencia** (`sw.js`, manejador `fetch`)
- La estrategia stale-while-revalidate actualiza archivos individuales en la caché activa, de
  modo que una pestaña puede combinar `zerochat.html` de una versión con módulos de otra.

**Alcance y alternativa**
- Servir `zerochat.html` y `js/` con caché por versión, sin actualización parcial.

**Prueba**
Unitaria (`test_service_worker.js`): una respuesta de red de otra versión no sustituye un recurso de la caché activa.

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

## 4. Interfaces públicas que no pueden cambiarse sin migración

- **Formato `zerochat-profile-backup` v1 y sobre de API key** (`profile-backup.js`): S2 exige
  un formato v2 con migración de lectura v1.
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
| 3 | `fix:` borrado limitado a las cachés y Service Workers de ZeroChat | S3 | `test:unit`, `test:browser` |
| 4 | `feat:` formato de cifrado v2 (PBKDF2 + sal) con migración v1 y caché no extraíble | S2 | `test:unit`, `test:integration`, `test:browser` |
| 5 | `fix:` arranque MCP sin cerrojo durante instalación y handshake | E1 | `test:infrastructure` |
| 6 | `refactor:` `fetchWithTimeout` único y `signal` en herramientas web | E4 | `test:unit`, `test:integration` |
| 7 | `fix:` notificaciones anidadas y clonado en `ChatState` | E5 | `test:unit`, `test:integration` |
| 8 | `fix:` caché por versión en el Service Worker | E6 | `test:unit`, `test:browser` |
| 9 | `fix:` textos a `ChatI18n` | P1, P2 | `test:unit`, `test:browser` |
| 10 | `refactor:` extraer importación de perfiles y latido de `app.js` | A1 | `test:integration`, `test:browser` |
| 11 | `chore:` unificar envoltorios `t()` y retirar textos de respaldo por módulo | A3 | Todas las aplicables |

Pruebas de arquitectura nuevas que se proponen, para impedir que se reintroduzcan los problemas:

- `State.set('sessions'|'messages'` prohibido fuera de `state.js` y de una lista explícita de excepciones;
- `t(` con parámetros dentro de una plantilla `innerHTML` sin `escapeHtml`, con una lista
  blanca de parámetros numéricos;
- emojis en `button`, `summary` y `[role=button]`;
- un único `fetchWithTimeout` en el repositorio.

## 6. Criterio de cierre

Esta versión no es mayor (`8.10.3`), así que el procedimiento no bloquea la promoción. Aun
así, antes del próximo `X.0.0` deben quedar resueltos o aceptados explícitamente los hallazgos
**S2 y E1**. Después hay que repetir `npm test`, `npm run test:browser` y
`npm run build`, comprobar que el árbol queda limpio y actualizar este informe con el estado de
cada hallazgo antes de considerarlo cerrado.
