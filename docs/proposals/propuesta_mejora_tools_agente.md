# Propuesta de Mejora e Implantación: Conjunto Unificado de Herramientas (Tools) Agénticas

**Fecha:** 23 de septiembre de 2026  
**Estado:** Borrador de propuesta técnica  
**Objetivo:** Adaptar las capacidades de herramientas (*tool calling*) de ZeroChat al estándar unificado de agentes de ingeniería (estilo Codex / SWE-agent / Google Antigravity), optimizando la edición quirúrgica, shell interactivo con estado, inspección multimodal y control agéntico del plan de trabajo.

---

## 1. Motivación y Principios de Diseño

ZeroChat cuenta con herramientas locales en `zerochat.py` (`zmcp_*`) y módulos en el navegador (`js/tools/builtin/`). Para elevar el nivel de autonomía y fiabilidad al resolver tareas complejas de desarrollo de software, se adopta un conjunto de principios:

1. **Edición quirúrgica unívoca (`edit_file`):** Reemplazo estricto de fragmentos (`old_str` -> `new_str`) validando que exista exactamente 1 coincidencia para evitar alucinaciones y escrituras destructivas accidentales.
2. **Creación/Sobrescritura atómica separada (`write_file`):** Separar la escritura de ficheros completos de la modificación parcial de código.
3. **Shell de sesión persistente (`bash`):** Conservar directorio de trabajo (`cwd`), variables de entorno y estado entre ejecuciones sucesivas del agente.
4. **Búsqueda eficiente en repositorio (`search_files`):** Búsqueda de contenido (texto/regex) con filtrado glob para evitar lecturas masivas innecesarias.
5. **Respuestas defensivas y truncado inteligente:** Límites en terminal y búsquedas (>8.000 caracteres) conservando cabecera y cola para no agotar la ventana de contexto.
6. **Soporte multimodal (`browser_action`):** Capacidad de devolver capturas visuales en Base64 (`image/png` en `inlineData`) en la respuesta de la función para validación de interfaces.
7. **Control agéntico explícito (`update_plan`, `finish_task`):** Seguimiento interactivo en la interfaz del estado de tareas y cierre formal del ciclo del agente.

---

## 2. Catálogo Unificado de Herramientas

### 2.1. `bash`
* **Descripción:** Ejecuta un comando en la terminal interactiva dentro del entorno/sandbox. Mantiene el directorio y variables de entorno entre llamadas.
* **Parámetros:**
  - `command` (string, obligatorio): Comando de shell a ejecutar (ej: `npm test`, `git diff`).
  - `timeout_seconds` (integer, opcional, por defecto 30): Límite de tiempo antes de enviar SIGKILL.
* **Truncado:** Salidas >8.000 caracteres se truncan a primeras 50 líneas + aviso + últimas 30 líneas.

### 2.2. `read_file`
* **Descripción:** Lee el contenido de un archivo en el workspace con soporte para rangos de líneas.
* **Parámetros:**
  - `path` (string, obligatorio): Ruta relativa al proyecto.
  - `start_line` (integer, opcional, por defecto 1): Línea inicial (base 1).
  - `end_line` (integer, opcional): Línea final inclusiva. Si se omite, lee hasta el final o límite defensivo.
* **Control de memoria:** Streaming incremental y respeto estricto del presupuesto de bytes UTF-8 (resolviendo el hallazgo de auditoría F4).

### 2.3. `write_file`
* **Descripción:** Crea un archivo nuevo o sobrescribe completamente un archivo existente de forma atómica.
* **Parámetros:**
  - `path` (string, obligatorio): Ruta relativa del archivo.
  - `content` (string, obligatorio): Contenido completo del archivo.

### 2.4. `edit_file`
* **Descripción:** Sustitución quirúrgica de texto dentro de un archivo existente.
* **Parámetros:**
  - `path` (string, obligatorio): Ruta del archivo.
  - `old_str` (string, obligatorio): Fragmento exacto a sustituir (con contexto suficiente para ser único).
  - `new_str` (string, obligatorio): Nuevo fragmento de reemplazo.
* **Reglas de fallo:**
  - 0 coincidencias: Error explicativo sugiriendo inspeccionar el fichero con `read_file`.
  - >1 coincidencia: Error de ambigüedad solicitando ampliar el contexto circundante.

### 2.5. `search_files`
* **Descripción:** Búsqueda recursiva por texto plano o expresión regular en archivos del proyecto.
* **Parámetros:**
  - `query` (string, obligatorio): Cadena o regex de búsqueda.
  - `path` (string, opcional, por defecto `.`): Carpeta base de búsqueda.
  - `file_pattern` (string, opcional): Filtro glob (ej. `*.js`, `*.py`).

### 2.6. `list_directory`
* **Descripción:** Lista archivos y directorios con control de recursividad.
* **Parámetros:**
  - `path` (string, opcional, por defecto `.`): Directorio a inspeccionar.
  - `recursive` (boolean, opcional, por defecto `false`): Si es `true`, recorre subdirectorios hasta un nivel seguro controlado (máx. 3).

### 2.7. `get_diagnostics`
* **Descripción:** Obtiene errores y advertencias de LSP o linters del workspace o de un archivo específico.
* **Parámetros:**
  - `path` (string, opcional): Ruta del archivo a consultar.

### 2.8. `browser_action`
* **Descripción:** Controla un navegador headless para pruebas e inspección de UI.
* **Parámetros:**
  - `action` (string, enum: `navigate`, `screenshot`, `click`, `fill`, obligatorio).
  - `url` (string, opcional si acción es `navigate`).
  - `selector` (string, opcional para `click` o `fill`).
  - `value` (string, opcional para `fill`).
* **Respuesta multimodal:** Si la acción es `screenshot`, devuelve el binario en Base64 (`inlineData` con `image/png`) para inspección visual directa.

### 2.9. `update_plan`
* **Descripción:** Actualiza la lista visible de tareas y su estado para seguimiento del plan en la interfaz.
* **Parámetros:**
  - `tasks` (array de objetos `{ title: string, status: 'pending'|'in_progress'|'completed'|'failed' }`, obligatorio).

### 2.10. `finish_task`
* **Descripción:** Señal de finalización de tarea por parte del agente.
* **Parámetros:**
  - `summary` (string, obligatorio): Resumen de los cambios realizados y validaciones ejecutadas.

---

## 3. Plan de Implantación y Despliegue en `dev`

Cada fase se desarrolla sobre la rama `dev`, acompañada de su batería de pruebas automatizadas y verificaciones de regresión antes de realizar el commit y push:

```
 ┌──────────────────────────┐
 │ Fase 1: Archivos Local   │  read_file, write_file, edit_file, list_directory
 └─────────────┬────────────┘
               │  [Tests + push a dev]
 ┌─────────────▼────────────┐
 │ Fase 2: Shell & Búsqueda │  bash persistente, search_files
 └─────────────┬────────────┘
               │  [Tests + push a dev]
 ┌─────────────▼────────────┐
 │ Fase 3: Control Agéntico │  update_plan, finish_task
 └─────────────┬────────────┘
               │  [Tests + push a dev]
 ┌─────────────▼────────────┐
 │ Fase 4: Multimodal / UI  │  browser_action, get_diagnostics
 └──────────────────────────┘
```

### Fase 1: Núcleo de Archivos Local
* **Archivos afectados:** `zerochat.py`, `js/mcp.js`, `js/tool-security.js`.
* **Tareas:**
  1. Adaptar `read_file` a `start_line` / `end_line` y aplicar lectura en streaming acotada.
  2. Implementar `write_file` atómico en el backend Python.
  3. Implementar `edit_file` quirúrgico (`old_str` / `new_str`) con manejo estricto de 0 y >1 coincidencias.
  4. Soportar `recursive: bool` controlado en `list_directory`.
  5. Actualizar directivas de seguridad en `tool-security.js`.
* **Pruebas:** `npm run test:infrastructure` y `npm run test:integration`.
* **Push dev:** `feat(tools): implement unified local file operations (read, write, edit, list)`.

### Fase 2: Shell Persistente y Búsqueda de Código
* **Archivos afectados:** `zerochat.py`, `js/tool-security.js`.
* **Tareas:**
  1. Implementar sesión bash persistente en `zerochat.py` manteniendo variables de entorno y `cwd`.
  2. Implementar truncado inteligente de búfer (>8.000 chars) y timeout con SIGKILL.
  3. Implementar `search_files` con soporte de regex y filtros glob.
* **Pruebas:** Tests de persistencia de variables y `cwd`, tests de truncado y búsqueda.
* **Push dev:** `feat(tools): add persistent bash shell session and search_files`.

### Fase 3: Control Agéntico y Plan de Trabajo
* **Archivos afectados:** `js/tools/builtin/update-plan.tool.js`, `js/tools/builtin/finish-task.tool.js`, `js/agent-core.js`, `js/state.js`.
* **Tareas:**
  1. Crear módulo `update_plan` con sincronización de estado y componente visual de tareas en el chat.
  2. Crear módulo `finish_task` con detención limpia del bucle de inferencia y tarjeta de resumen.
* **Pruebas:** `npm run test:unit` y `npm run test:integration`.
* **Push dev:** `feat(agent): add update_plan and finish_task agentic tools`.

### Fase 4: Multimodal y Navegación
* **Archivos afectados:** `js/providers.js`, `zerochat.py`, servicios MCP (`@playwright/mcp`).
* **Tareas:**
  1. Conectar `browser_action` con soporte para inyección de imágenes Base64 en `inlineData`.
  2. Conectar `get_diagnostics` con servidores LSP o linters del workspace.
* **Pruebas:** `npm run test:unit`, `npm run test:integration`, `npm run test:browser`.
* **Push dev:** `feat(tools): support multimodal browser_action and diagnostics`.

---

## 4. Gobernanza y Versionado

* Todos los cambios se integran y verifican en `dev`.
* Al culminar la implantación, se ejecutará `npm run bump minor` para reflejar las nuevas capacidades del backend en `pyproject.toml` y `zerochat.py`.
* Tras la validación completa en `dev`, se procederá a la promoción a `master` y la consiguiente publicación.

