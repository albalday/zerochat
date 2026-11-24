# Auditoría acotada de calidad de código y simplificación — M87

## 1. Resumen y línea base

- **Alcance revisado:** cambios de `M87` en `dev` desde `v10.42.0` (`e6da21af..94e0cd12`, versión actual `10.42.3`), correspondientes a las tareas cerradas `M87-T7`, `M87-T8`, `M87-T9`, `M87-T10` y el ajuste documental/plan `94e0cd12` (20 ficheros tocados: `js/ui-sidebar.js`, `js/app.js`, `js/i18n.js`, `css/components/sidebar.css`, `css/components/composer.css`, `zerochat.html`, `help/conversations.html`, `help/en/conversations.html`, `tests/browser/browser_sidebar.test.js`, `tests/browser/browser_conversation.test.js`, `tests/helpers/backend-env.js`, `tests/infrastructure/test_local_server.js`, `tests/README.md` y memoria `.zerochat/`).
- **Árbol de trabajo (`git status --short`):** limpio en código; solo `.zerochat/plan.md` con modificaciones locales sin commit (`M87-T12` y `M87-T13`).
- **`npm run lint`:** en verde (`ruff` y `pyright`: 0 errores, 0 advertencias).
- **`npm test`:** en verde en todos los niveles (`unit`, `integration`, `architecture`, `browser`, `infrastructure` y `unittest` de `py/`).
- **Artefactos generados:**
  - `zerochat.py`: sincronizado con `py/` (verificado por `tests/architecture/test_backend_hygiene.js`).
  - `sitemap.xml`: sincronizado (verificado por `tests/architecture/test_site.js`).
  - `services/manifest.json`, `py/tools/sandbox_script.py`, `js/sandbox-node-script.js` y `js/vendor/`: sin cambios en `M87`.
- **Valoración general:** las simplificaciones de `M87-T7` y `M87-T8` (quitar la jerarquía plegable por agente y pasar a un conmutador `Chats / Agentes` con lista plana por fecha) han reducido complejidad de `js/ui-sidebar.js` y `css/components/sidebar.css` de forma muy limpia y mantienen todos los contratos estáticos en verde. Sin embargo, al separar los dos historiales han quedado **dos fallos funcionales reales en el borrado** (`F-01`, `F-02`), una **brecha de portabilidad en el reintento de puertos de `M87-T10`** (`F-03`), **asimetrías en el conmutador y el menú de agentes** (`F-04`) y **documentación contractual sin actualizar** (`F-05`).

---

## 2. Tabla resumen de hallazgos

| ID | Prioridad | Área | Archivos | Resumen |
|---|---|---|---|---|
| `F-01` | Alta | Estabilidad | `js/conversation-service.js`, `js/ui-sidebar.js`, `js/storage.js`, `py/storage/db.py` | Borrar todo el historial ignora el conmutador `Chats / Agentes` y borra ambos historiales juntos |
| `F-02` | Alta | Estabilidad | `js/conversation-service.js`, `js/ui-sidebar.js`, `tests/browser/browser_sidebar.test.js` | Borrar la conversación de agente abierta sigue saltando a `Chats` si existe un chat humano más reciente |
| `F-03` | Media | Estabilidad / Duplicación | `tests/helpers/backend-env.js`, `tests/infrastructure/test_backend_run_mode.js` | `startServer` solo detecta `"Address already in use"` (falla en Windows/locales) y duplica el reintento de `runZerochat` |
| `F-04` | Media | Arquitectura | `js/ui-sidebar.js` | Asimetría de `.has-pending` (`Chats` no avisa desde `Agentes`) y «Renombrar» sin efecto visible en agentes |
| `F-05` | Media | Arquitectura | `docs/architecture.md`, `templates/project/mode-agent.txt` | Contratos y plantilla de agentes siguen describiendo el diseño retirado de secciones plegables por agente |
| `F-06` | Baja | Código muerto / Pruebas | `js/ui-sidebar.js`, `tests/browser/browser_sidebar.test.js` | Estado residual en `UISidebar.mount()` y montaje manual duplicado de `elements` en tests de barra lateral |

---

## 3. Detalle de hallazgos

### `F-01` — Borrar el historial en bloque ignora el conmutador `Chats / Agentes` y borra ambos historiales

- **Evidencia:**
  - `M87-T7` separó visualmente las conversaciones en dos historiales excluyentes en `js/ui-sidebar.js:169-182` y `js/ui-sidebar.js:246-247` (`allSessions.filter(session => Boolean(session.agent) === agentsView)`).
  - El botón de borrado en bloque (`#btn-delete-all-chats`) invoca `ConversationService.deleteAllSessions` (`js/conversation-service.js:442-471`), que filtra únicamente por `targetProject` y no por `historyView`:
    - Con 2 chats humanos y 5 ejecuciones de agentes en el proyecto actual, estando en `Chats`, el botón pregunta por **7 conversaciones** y al aceptar borra los 2 chats **y también las 5 conversaciones de agentes** (cancelando además sus ejecuciones activas en `py/storage/rpc.py:101-104`).
    - Ocurre lo mismo a la inversa desde `Agentes`: limpiar el historial de ejecuciones de agentes borra todos los chats humanos del proyecto.
    - Si la vista actual (`Chats` o `Agentes`) está vacía pero la otra tiene sesiones en el mismo proyecto, el botón sigue activo y borra sesiones que no estaban en pantalla.
- **Norma o contrato afectado:** `docs/audit.md` §4.1 (pérdida silenciosa de datos no mostrados en la vista activa) y coherencia con la separación Chats/Agentes introducida en `M87-T7`.
- **Propuesta de solución y prueba:**
  - Hacer explícito el ámbito del historial en el borrado en bloque: pasar `onlyAgents` / `historyScope` (`'user' | 'agents'`) desde `UISidebar` a `deleteAllSessions` y soportarlo como filtro opcional en `ChatStorage` y `zerochat/conversations/delete` (`py/storage/db.py` y `py/storage/rpc.py`), deshabilitando `#btn-delete-all-chats` cuando `sessions` visibles del ámbito sean 0 (o, si se prefiere mantener borrado conjunto por proyecto, dejarlo explícito en el texto de confirmación especificando chats y agentes).
  - **Pruebas:** `tests/integration/test_conversation_service.js` (borrado acotado a chats sin tocar agentes y viceversa) y `tests/infrastructure/py/test_storage.py` (filtro por tipo de conversación en `delete_project_conversations` / `delete_all_conversations`).

---

### `F-02` — `M87-T9` no evita volver a `Chats` al borrar una conversación de agente abierta si hay un chat humano más reciente

- **Evidencia:**
  - `M87-T9` (commit `8b3fd50f`, documentado en `help/conversations.html:30`: *"al borrar la abierta se queda en el que estabas"*) modificó `renderHistorySwitch` (`js/ui-sidebar.js:169-174`) para no cambiar `historyView` cuando `currentSessionId` es una sesión nueva todavía sin guardar.
  - Sin embargo, `ConversationService.deleteSession` (`js/conversation-service.js:406-411`) sigue haciendo:
    ```js
    const remaining = getSavedSessions();
    if (remaining.length === 0) {
      await createNewSession({ ...options, saveCurrent: false });
    } else if (activeId === sessionId) {
      await switchToSession(remaining[0].id, { ...options, force: true, saveCurrent: false });
    }
    ```
  - **Caso de reproducción:** si existen un chat humano `h1` (más reciente) y dos conversaciones de agentes `ag1` (abierta) y `ag2`, al borrar `ag1` desde `Agentes`, `remaining[0]` es `h1`. `deleteSession` ejecuta `switchToSession('h1', { force: true, saveCurrent: false })`:
    1. `renderHistorySwitch` ve que `h1` sí está en `sessions` con `!h1.agent`, y **cambia igualmente de `Agentes` a `Chats`**.
    2. Como `switchToSession` se llama sin `confirmProjectSwitch: true`, si `h1` pertenece a otro proyecto, **cambia silenciosamente el proyecto del servidor** (`app.js` `onSessionSwitched`) al borrar un agente.
  - Además, la prueba añadida en `tests/browser/browser_sidebar.test.js:289-300` solo simula el cambio de `activeId` a una sesión no guardada mediante `page.evaluate`, por lo que no ejercita `deleteSession` con chats y agentes coexistiendo.
- **Norma o contrato afectado:** `docs/audit.md` §4.1 (fallo funcional reproducible frente al contrato de `M87-T9`) y `docs/architecture.md` §2.4 (supervisar agentes no cambia el proyecto de la pestaña).
- **Propuesta de solución y prueba:**
  - En `ConversationService.deleteSession`, guardar la sesión eliminada antes de borrarla y, si era la activa (`activeId === sessionId`), buscar el sustituto dentro del mismo ámbito (`Boolean(s.agent) === Boolean(deleted?.agent)`): para agentes, abrir el siguiente agente restante (si existe) o `createNewSession` si ya no queda ninguno; para chats humanos, preferir el siguiente chat del mismo proyecto (o `createNewSession` para no cambiar de proyecto sin confirmación).
  - **Pruebas:** `tests/integration/test_conversation_service.js` cubriendo borrado del agente activo con chat humano más reciente y con otro agente disponible.

---

### `F-03` — Reintento de puerto de `M87-T10`: frágil en Windows/locales y duplicado con `test_backend_run_mode.js`

- **Evidencia:**
  - `tests/helpers/backend-env.js:101` condiciona el reintento de `startServer` al literal inglés de POSIX:
    ```js
    if (attempt >= START_ATTEMPTS || !/Address already in use/.test(error.message)) throw error;
    ```
    En Windows (`WinError 10048`: *"Only one usage of each socket address..."*) y en entornos POSIX con locale distinto de inglés (p. ej. `es_ES.UTF-8`: *"La dirección ya se está usando"*), ese patrón **no coincide nunca** y el reintento de `M87-T10` no se dispara en la CI de Windows ni en máquinas locales en español.
  - Paralelamente, `tests/infrastructure/test_backend_run_mode.js:103-107` reimplementa su propio reintento (`runZerochat`) con otra política (solo 1 reintento frente a `START_ATTEMPTS = 3`) y otro patrón (`/No se pudo escuchar/`).
- **Norma o contrato afectado:** `AGENTS.md` §2 (una única fuente por decisión; simetría entre variantes hermanas) y `docs/audit.md` §3.2 / §4.1.
- **Propuesta de solución y prueba:**
  - Unificar en `tests/helpers/backend-env.js` el predicado de puerto ocupado para cubrir todas las plataformas e idiomas (`/(?:Address already in use|Errno (?:98|48)|WinError 10048|No se pudo escuchar)/i`) y exportar/compartir la constante o helper de reintento con `tests/infrastructure/test_backend_run_mode.js`.
  - *(Simplificación adicional a valorar junto con `M87-T12`: si `open_server` en `py/cli/main.py:349-353` actualiza `set_active_address(host, server.server_address[1])` tras abrir el socket, las pruebas que no prueban un `--port` fijo podrían lanzar `zerochat.py --port 0` y leer el puerto real de la cabecera `Servidor HTTP:`, eliminando `freePort()` y la condición de carrera de raíz.)*
  - **Pruebas:** `tests/infrastructure/test_local_server.js` y `tests/infrastructure/test_backend_run_mode.js` (plus una prueba unitaria breve del predicado si se extrae, o cubierto directamente con un puerto ocupado en `test_local_server.js`).

---

### `F-04` — Asimetrías en el conmutador `Chats / Agentes` y en el menú contextual de agentes

- **Evidencia:**
  1. **Aviso `.has-pending` unidireccional (`js/ui-sidebar.js:179-180`):**
     ```js
     const agentWaiting = agentSessions.some(session => runStatusMap.get(session.id) === 'needs_input');
     container.querySelector('[data-history="agents"]').classList.toggle('has-pending', agentWaiting && historyView !== 'agents');
     ```
     Si el usuario está revisando la pestaña `Agentes` y un **chat normal en segundo plano** se pausa en `needs_input`, el botón `Chats` no recibe `.has-pending`. Como `Tareas pendientes` ahora filtra solo por el historial activo (`js/ui-sidebar.js:249`), ese chat pendiente queda completamente invisible mientras se está en `Agentes`.
  2. **Acción «Renombrar» sin efecto visible en conversaciones de agentes (`js/ui-sidebar.js:100-124`):**
     `M87-T8` hizo que las filas de agentes muestren `session.agent` y dejen `session.title` solo en el `title="..."` (*tooltip*), pero `renderChatItem` sigue pintando el botón `btn-rename` en su menú. Al renombrar una conversación de agente, se modifica `session.title` y se repinta la lista, pero el texto visible de la fila no cambia, dando la impresión de que la acción no funcionó.
- **Norma o contrato afectado:** `AGENTS.md` §6 (comprobaciones simétricas entre variantes hermanas) y coherencia del modo supervisión de solo lectura (`docs/architecture.md` §2.4).
- **Propuesta de solución y prueba:**
  - En `renderHistorySwitch`, aplicar `.has-pending` de forma simétrica a ambos botones (`[data-history="user"]` y `[data-history="agents"]`) cuando haya sesiones con `needs_input` en el historial no visible (y ajustar `css/components/sidebar.css:472` el comentario).
  - En `renderChatItem`, omitir `btn-rename` cuando `session.agent` está presente (alineado con el modo solo lectura del agente, donde el identificador del agente es inmutable).
  - **Pruebas:** ampliar el caso de historial de agentes en `tests/browser/browser_sidebar.test.js` verificando `has-pending` en `Chats` cuando un chat humano espera respuesta y la ausencia de `btn-rename` en conversaciones de agentes.

---

### `F-05` — Desfase contractual en `docs/architecture.md` y `templates/project/mode-agent.txt`

- **Evidencia:**
  - `M87-T7` y `M87-T8` actualizaron `help/conversations.html` y `help/en/conversations.html`, pero dejaron intacta la descripción del diseño anterior de `M86` en dos documentos contractuales:
    - `docs/architecture.md:82`: *"las conversaciones de agentes (`agent`) se agrupan en la barra lateral tras los chats humanos en secciones plegables por agente con su estado más urgente"*.
    - `templates/project/mode-agent.txt:19`: *"agent conversations (`agent`) appear grouped by `<set>.<name>` under Agents (with their most urgent status badge)"* (se inyecta en el `AGENTS.md` de todo proyecto de agentes recién inicializado).
- **Norma o contrato afectado:** `AGENTS.md` §1 y §6 (mantener sincronizada `docs/architecture.md` y la documentación contractual tras cambios estructurales).
- **Propuesta de solución y prueba:**
  - Actualizar ambas líneas para describir el conmutador `Chats / Agentes`, la lista plana por fecha nombrada por `<subconjunto>.<nombre>`, el indicador de `needs_input` y el aviso de solo lectura sobre el compositor. No requiere prueba adicional (documentación/plantilla).

---

### `F-06` — Estado de módulo sin reiniciar en `UISidebar.mount()` y duplicación del repintado en `browser_sidebar.test.js`

- **Evidencia:**
  - `js/ui-sidebar.js:28-33` declara cuatro variables mutables de módulo (`groupLimits`, `expandedGroups`, `historyView`, `followedSessionId`). `mount()` (`js/ui-sidebar.js:296-312`) limpia `cleanups` y `searchState`, pero deja sin reiniciar esas cuatro variables, reteniendo estado entre remontajes.
  - En `tests/browser/browser_sidebar.test.js` hay 3 llamadas manuales repetidas a `ChatUISidebar.renderSidebarChats({ sidebarChatsList, sidebarSearchInput, sidebarProjectFilter, sidebarHistorySwitch, btnDeleteAllChats }, ...)` (`L24-26`, `L106-112`, `L543-549`) que obligaron en `M87-T7` a actualizar los tres sitios a la vez, además de 6 disparos sintéticos `document.getElementById('sidebar-search-input').dispatchEvent(new Event('input'))` (`L219`, `L248`, `L259`, `L298`, `L306`, `L318`) usados únicamente para forzar un repintado desde `app.js`.
- **Norma o contrato afectado:** `AGENTS.md` §2 y `docs/audit.md` §3.1 / §4.4 (higiene de ciclo de vida de `mount()` y ahorro >15 líneas duplicadas en pruebas).
- **Propuesta de solución y prueba:**
  - Reiniciar `groupLimits = {}`, `expandedGroups = new Set()`, `historyView = 'user'` y `followedSessionId = null` en `UISidebar.mount()`.
  - Extraer un helper local `renderSidebar(...)` / `triggerSidebarRender(page)` dentro de `tests/browser/browser_sidebar.test.js` para centralizar la lista de elementos de la barra y los repintados en una sola función.
  - **Pruebas:** `npm run test:browser` (`tests/browser/browser_sidebar.test.js`).

---

## 4. Observaciones menores (sin propuesta de tarea)

- **`css/components/sidebar.css:433-434`:** quedó el comentario antiguo `/* Selector de proyecto: ... */` justo encima del nuevo `/* Historial: conmutador chats/agentes... */`.
- **`css/components/composer.css:86-88`:** `.agent-supervision-notice .ui-icon` no lleva `flex-shrink: 0`; en pantallas estrechas donde el aviso salta a 2–3 líneas el icono SVG puede comprimirse horizontalmente.
- **`css/components/sidebar.css:473-482`:** `.has-pending::after` está posicionado en `top: 0.15rem; right: 0.15rem` dentro de un contenedor con `border-radius: var(--radius-full); overflow: hidden`, muy pegado a la esquina redondeada del botón derecho (`Agentes`); un ligero `right: 0.4rem` evita que la curva lo roce.
- **`tests/infrastructure/test_local_server.js:404`:** línea en blanco sobrante tras `try {` al sustituir `waitForServer` por `startServer` en `M87-T10`.

---

## 5. Propuesta de tareas para discusión

Todas quedan acotadas (<150 líneas cada una) para que decidas cuáles aprobar y pasar a `.zerochat/plan.md` con `python3 .zerochat/task.py add-task M87 "..."`:

1. **Corrección de borrado con historiales separados (`F-01` + `F-02`):**
   - Acotar `deleteAllSessions` al historial activo (`Chats` o `Agentes`, con filtro opcional en `ChatStorage` y `zerochat/conversations/delete`, deshabilitando el botón si ese historial está vacío en la vista).
   - En `deleteSession`, elegir el sustituto de la conversación borrada dentro del mismo historial (y mismo proyecto para chats) para que borrar el agente abierto nunca salte a `Chats` ni cambie el proyecto del servidor silenciosamente.
   - Pruebas en `tests/integration/test_conversation_service.js`, `tests/infrastructure/py/test_storage.py` y `tests/browser/browser_sidebar.test.js`, y actualización posterior de `help/conversations.html` y `help/en/conversations.html` si se acota el borrado en bloque por pestaña.

2. **Simetría de barra lateral, limpieza de `mount()` y docs de `M87` (`F-04` + `F-05` + `F-06`):**
   - Hacer `.has-pending` simétrico entre `Chats` y `Agentes`, ocultar `btn-rename` en conversaciones de agentes, reiniciar el estado de módulo en `UISidebar.mount()` y limpiar el helper repetido en `tests/browser/browser_sidebar.test.js` (más los tres ajustes menores de CSS).
   - Sincronizar `docs/architecture.md` (§2.4) y `templates/project/mode-agent.txt` (L19) con el diseño vigente de `M87`.

3. **Unificación y portabilidad del reintento de puertos en tests (`F-03`):**
   - Ampliar la detección de puerto ocupado en `tests/helpers/backend-env.js` a Windows (`WinError 10048`) y locales no ingleses (`Errno 98`/`48`, `No se pudo escuchar`) y reutilizarla en `tests/infrastructure/test_backend_run_mode.js` (o resolverlo directamente con `--port 0` al abordar `M87-T12`).
