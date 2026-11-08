# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright and browser_action configuration: closed 2026-10-19

## M4 Images and office files in the chat: closed 2026-10-16

## M5 Test suite architecture and optimization: closed 2026-10-16

## M6 Investigation and rendering of LaTeX/math notation in chat responses: closed 2026-10-15

## M7 Temporary tests and scratchpad execution in /tmp: closed 2026-10-16

## M8 Project memory automation and acceleration: closed 2026-10-15

## M9 Update project management manual documentation: closed 2026-10-15

## M10 MCP state refresh on startup and in the panel: closed 2026-10-15

## M11 Fixes and refactoring from post-9.1.0 findings: closed 2026-10-15

## M12 PDF reading with pdf.js: closed 2026-10-16

## M13 Document generation in the chat: closed 2026-10-16

## M14 Project mode detection via task.py and legacy migration: closed 2026-10-16

## M15 Legacy binary Office (.doc and .xls) reading: closed 2026-10-16

## M16 RAG and web image rendering with local models and reasoning levels: closed 2026-10-17

## M17 Native XLSX reading without external libraries: closed 2026-10-16

## M18 Unattended prompt execution and browser profiles: closed 2026-10-19

## M19 Web image ingestion and multimodal analysis: closed 2026-10-16

## M20 Diff visualization for file edits: closed 2026-10-17

## M21 Unified browser resource download and public proxy removal: closed 2026-10-16

## M22 CI workflow optimization, retry resilience and browser test synchronization: closed 2026-10-17

## M23 Fallback cleanup, public proxy elimination and backend-first web transport: closed 2026-10-16

## M24 happy-dom removal: closed 2026-10-17

## M25 History summarization reliability, transcript sanitization and tool-call protection: closed 2026-10-17

## M26 Web transport hardening and post-9.2.3 audit fixes: closed 2026-10-17

## M27 Unified web fetch with backend or Jina Reader proxy: closed 2026-10-17

## M28 Quiet public presence: minimal discoverability: closed 2026-10-22

## M29 Configuration profiles: MCP servers per profile: closed 2026-10-19

## M30 Fixes from the 9.2.0–9.6.1 code quality audit: closed 2026-10-20

## M31 Fixes from the 9.2.0–9.7.1 scoped audit: closed 2026-10-20

## M32 Review of the tests added since 9.2.0: closed 2026-10-20

## M33 Live MCP state from the local server: closed 2026-10-21

## M34 Refactor of the spaghetti hotspots found in the 9.8.1 audit: closed 2026-10-21

## M35 Frontend complexity and spaghetti refactor: closed 2026-10-21

## M36 Native PDF stream bounds from /Length: closed 2026-10-22

## M37 Diff tool configuration onboarding: closed 2026-10-22

## M38 MVC separation between presentation and domain processes: closed 2026-10-23

## M39 UI logic testable without a browser: closed 2026-10-23

## M40 Automatic reconnection to the local backend: closed 2026-10-23

## M41 Faster test suite without duplicates: closed 2026-10-23

## M42 MCP service state, JS–Python contract and reverse-proxy transport: closed 2026-10-24

## M43 Dark theme link contrast: closed 2026-10-23

## M44 WebP images readable by every vision model: closed 2026-11-05

## M45 Local backend storage for general connection profiles (Z-): closed 2026-11-06

## M46 Local backend storage and synchronization for conversations (SQLite): closed 2026-11-07

## M47 Server-side background turn execution and conversation continuation (--conversation): closed 2026-11-07

## M48 Revisar modo servidor y robustez de ejecución: closed 2026-11-07

## M49 Almacenamiento paralelo de adjuntos e imágenes para sincronización eficiente de conversaciones: closed 2026-11-08

## M50 Ajustes del modo servidor: perfil de conversación y control responsive en móvil: closed 2026-11-08

## M51 Desacoplo de perfiles de servidor, panel responsive en móvil y acciones de guardado e importación

Goal: Separar los perfiles del servidor de la lista local del cliente eliminando el prefijo y lógica Z-, dotar al editor de perfiles de opciones independientes para «Guardar» (local) y «Guardar en servidor», enriquecer el panel selector de perfiles con pantalla completa en móvil y acciones para importar perfiles del servidor y seleccionar perfil para ejecuciones en segundo plano, y actualizar el backend y las pruebas.
Done when: El menú de perfiles solo muestra perfiles locales sin prefijo Z-; el editor de perfiles cuenta con botones independientes para guardar en local y guardar en el servidor; el panel selector de perfiles se muestra a pantalla completa en móvil (< 640px) y permite importar perfiles del servidor y seleccionar el perfil para ejecución en servidor; el backend maneja los perfiles sin prefijos Z- de forma limpia; y pasan todas las suites de pruebas (unit, infrastructure, architecture, integration, browser).
- [x] M51-T1 Limpieza del prefijo Z- en backend (SQLite, CLI, ejecuciones desatendidas) y perfiles de servidor limpios con pruebas de infraestructura (2026-11-08)
- [x] M51-T2 Desacoplo de perfiles de servidor en frontend (eliminación de mezcla automática en profile-repository y mcp) y API de consulta/importación con pruebas unitarias e integración (2026-11-08)
- [x] M51-T3 Editor de perfiles: sustitución del selector de ámbito por botones independientes «Guardar» y «Guardar en servidor» con pruebas unitarias (2026-11-08)
- [x] M51-T4 Panel selector de perfiles: diseño responsive a pantalla completa en móvil (< 640px), acción de importación desde servidor y selección de perfil para ejecución en servidor (2026-11-08)
- [x] M51-T5 Restauración de conversación en servidor: recuperación del perfil asociado y activación automática del modo servidor al cargar del historial con pruebas (2026-11-08)
- [ ] M51-T6 Validación integral de la suite completa, pruebas de navegador y actualización de documentación

