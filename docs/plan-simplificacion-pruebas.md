# Plan de revisión y simplificación de pruebas (M24-T16 a M24-T27)

Borrador del 2026-10-17. Las tareas de una línea están en `.zerochat/plan.md`, dentro de M24. Este documento recoge los criterios, el inventario de partida y la propuesta por fichero que esas tareas aplican.

## 1. Situación de partida

| Nivel | Ficheros | Pruebas | Líneas |
|---|---|---|---|
| unit | 29 | 204 | 4.407 |
| integration | 27 | 345 | 9.527 |
| architecture | 14 | 48 | 1.057 |
| infrastructure | 6 | 43 | 2.554 |
| browser | 17 | 179 | 8.306 |
| helpers | 6 | — | 327 |
| **Total** | **99** | **≈820** | **≈26.200** |

El código que prueban suma 27.661 líneas en `js/` y 3.737 en `py/`, así que hay casi una línea de prueba por cada línea de aplicación.

### Causas de la inflación

1. **AGENTS.md §5.2**: «todo cambio de comportamiento debe incluir pruebas nuevas o modificadas». Cada tarea añade pruebas, también para cambios de texto, de maquetación o de código que se ejecuta en cada arranque.
2. **M24-D4**: «una prueba DOM en Node solo se borra si una de navegador comprueba todo lo que promete su nombre». Por eso se trasladaron al navegador unas 105 pruebas, incluidas trivialidades como `tableToCsv`, el escape de primitivas de DOM o el icono de copiar, en vez de evaluar si merecían existir. M24 añadió 2.767 líneas a `tests/browser/`.
3. **Pruebas de ausencia**: aunque `tests/README.md` ya dice que «la ausencia de elementos ya retirados» no merece prueba, M24 añadió dos: no hay DOM simulado y no hay proxies públicos.
4. **El mismo comportamiento probado en varios niveles**: el borrado de turnos, el bucle de herramientas, la detección de bucles, el SSRF, el escape de HTML y la telemetría de tokens están en unit, integration y browser a la vez.
5. **Pruebas del propio mock**: el montaje simula un Worker, una fachada o un fetch, y la aserción comprueba lo que devolvió esa simulación.
6. **Código fantasma**: 119 nombres exportados no los usa ningún otro módulo de producción, y 77 de ellos sí aparecen en las pruebas. La prueba de higiene actual solo mira declaraciones de función, no constantes, clases ni parámetros opcionales.

## 2. Criterios: qué se conserva y qué se borra

Cada prueba se clasifica con una letra. Las de la columna «borrar» se eliminan directamente; no se mueven a un nivel distinto ni a una categoría que no se ejecute.

| Conservar | Borrar |
|---|---|
| **S** Seguridad: escape, SSRF, sandbox, permisos, token, rutas | **A** La cubre el arranque: un fallo se nota al abrir la aplicación o al enviar un mensaje |
| **L** Lógica no trivial con ramas o bordes que no se ven al usar la aplicación: parsers, SSE, presupuesto de contexto, bucles, ranking RAG | **T** Trivial: getters, formateadores de pocas líneas, constantes, valores por defecto literales, textos de prompt |
| **D** Integridad de datos: persistencia, migraciones, borrados en cascada, cifrado | **C** Cosmética: colores, contornos, alineación o anchos sin consecuencia funcional |
| **X** Contrato externo: formato de los proveedores, MCP, paridad JS-Python, `task.py` | **Z** Ausencia de algo ya retirado |
| **R** Regresión de un fallo real que costó encontrar | **M** Prueba del mock: comprueba lo que la simulación devuelve |
| | **2** Duplicado: el mismo comportamiento ya se prueba en otro nivel; se queda en el nivel más bajo que lo observa |

**Fusión**: los casos de una misma función se juntan en una sola prueba con tabla de filas, en lugar de tener una prueba por caso.

### La categoría que no se ejecuta: se descarta

Se descarta mantener las trivialidades en una categoría que nunca se lance automáticamente, por cuatro motivos:

- una prueba que no se ejecuta se queda obsoleta sin que nadie lo note;
- sigue costando mantenimiento, porque aparece en búsquedas y refactorizaciones;
- obliga a excepciones en el runner y en las reglas;
- da una falsa sensación de cobertura.

En su lugar, la cobertura «de arranque» la da **una única prueba de humo en navegador**, que amplía la actual «zerochat.html carga sin errores de consola». Esa prueba:

- abre la aplicación;
- envía un mensaje con Espejo;
- abre cada sección de ajustes y el panel MCP;
- crea, renombra y borra una conversación;
- falla ante cualquier error de consola.

Esa sola prueba sustituye a decenas de pruebas de tipo **A**.

## 3. Código fantasma

Es código de producción cuyo único consumidor es una prueba: exportaciones, parámetros opcionales, inyecciones de dependencias, vistas en memoria o ramas. Para quitarlo:

1. **Exportaciones**: se revisa la lista de 119 nombres exportados que no usa ningún otro módulo; el script de detección está en la tarea M24-T26. Si el nombre solo se usa dentro de su módulo, se deja de exportar. Si una prueba lo necesita, la prueba pasa a usar la interfaz pública o se borra. Primeros candidatos:
   - `ChatCharts.render*Chart`
   - `ProjectContext.RULES_FILE…TASK_HELPER_FILE`
   - `ContextManager.groupIntoAtomicBlocks` y `pruneHistoricalToolMessage`
   - `WebBrowser.*Strategy`, `MAX_BINARY_BYTES` y `VISION_IMAGE_MIME_TYPES`
   - `ToolSecurity.GLOBAL_POLICIES`, `TOOL_POLICIES`, `SERVER_POLICIES`, `SCOPES` y `evaluate*`
   - `Providers.DEFAULT_CAPABILITIES` y `MirrorProviderAdapter`
   - `providers-webllm.getAppConfig`, `getModelAvailability`, `normalizeProgress` y `getActiveWebllmConfig`
   - `ui-mcp.render*` y `generateTerminalCommand`
   - `file-parser.unshiftAsciiString` y `collapseSpacedLettersAndNumbers`
   - `state.PROJECT_STATUSES` y `storage-db.DB_NAME`
2. **Inyecciones de M24**: hay que revisar si `ChatUIConversation.createTurnView`, `ChatToolCards.createCardView`, `getMessageRef` y `tests/helpers/turn-view.js` existen por la aplicación o solo para probar ChatEngine en Node.
   - Si tras la poda de M24-T21 no queda ninguna prueba de Node del bucle de turno que necesite la vista, se valora volver al contenedor directo.
   - Se conservan solo si el código de ChatEngine y AgentCore queda más simple con ellas que sin ellas.
3. **Parámetros opcionales** con valor por defecto y sin llamador en producción (`fetchImpl`, `now`, `deps`, `options.*`): se retiran.
4. **Guarda permanente**: la prueba de higiene «no hay funciones sin uso ni exportadas solo para las pruebas» se amplía a todos los nombres exportados. Es una ampliación de esa prueba, no una prueba nueva.

## 4. Cambios de normas

### AGENTS.md §2 (calidad del código)

- La viñeta de M24 sobre el DOM se reduce a esto: «En Node no hay DOM: lo que pinta o lee elementos no se prueba en Node; en navegador se prueba solo si cumple los criterios de §5».
- La viñeta «no exportar helpers internos exclusivamente para ser probados» se sustituye por esta: «no se añade a producción código cuyo único consumidor es una prueba (exportaciones, parámetros, inyecciones, vistas en memoria, ramas); si algo no se puede probar sin ello, se prueba en navegador o no se prueba».

### AGENTS.md §5 (pruebas)

- El punto 2 pasa a decir: «Llevan prueba los cambios de seguridad, lógica no trivial, integridad de datos, contratos externos y la corrección de fallos reales. No llevan prueba nueva los cambios de texto, de maquetación, de valores por defecto ni del código que se ejecuta en cada arranque. Cada comportamiento se prueba una sola vez, en el nivel más bajo que lo observa, y un caso nuevo se añade como fila de la prueba existente».
- El punto 3 (borde `N` y `N+1`) se limita a los topes que protegen memoria, contexto o seguridad, en una sola prueba de tabla por módulo.

### AGENTS.md §8 (finalización)

Se añade una viñeta: «sin pruebas triviales, duplicadas o de ausencia, ni código de producción que solo usen las pruebas».

### tests/README.md

La sección 6, «Qué no merece un test propio», se sustituye por la tabla de criterios de la sección 2 y la regla de la prueba de humo.

### .zerochat/log.md

Se añade la decisión M24-D9, que revoca M24-D4: una prueba que se retira de Node no se traslada al navegador salvo que cumpla los criterios de conservación.

## 5. Propuesta por fichero

Es una propuesta preliminar hecha a partir de los títulos de las pruebas. Cada tarea la confirma leyendo el código. Las cifras son objetivos orientativos.

### architecture (48 → ~28)

| Fichero | Propuesta |
|---|---|
| test_code_hygiene | Borrar «sin DOM simulado» y «sin proxies» (**Z**); ampliar «sin uso ni exportadas solo para pruebas» a todos los exportados |
| test_backend_hygiene | Borrar zz-main (**T**) y la concatenación (**2**, ya está en infrastructure); conservar except genérico y la paridad de herramientas |
| test_context_cache_architecture | No es de arquitectura: fusionar las de payload en `test_providers` y borrar la de «solo lee ChatState» (**T**) |
| test_ui_modernization | Borrar transiciones, defer, ancho de imágenes y orden de carga (**C/A**); dejar una sola comprobación de emojis y quitar los duplicados de icon_sprite y browser_a11y |
| test_english_literals | Borrar «el analizador distingue…», que prueba la propia prueba |
| test_state_contract | Conservar la escritura del slice ui; borrar las otras dos (**T**) |
| test_help_pages | Fusionar las tres en una |
| html_sinks, persistence_boundary, i18n_literals, style_hygiene, error_handling, ui_listeners, icon_sprite | Conservar: son normas de AGENTS §3 que el código generado tiende a romper |

### infrastructure (43 → ~32)

| Fichero | Propuesta |
|---|---|
| test_local_server, test_backend_runtime, test_backend_mcp | Conservar casi todo (**S/L**: token, procesos, plazos, SSRF, Windows). Borrar la reconstrucción repetida, el versionado duplicado y «la ayuda sale en texto plano» (**T**) |
| test_runner | Borrar el análisis de argumentos y los niveles (**A**: el runner falla a la vista); conservar los grupos si el README los cita |
| test_vendor_build | Conservar la reproducibilidad y las licencias; borrar `bundleInfo` (**2** con unit y browser) y «global ejecutable en Node» (**T**) |

### unit (204 → ~110)

| Fichero | Propuesta |
|---|---|
| test_icons, test_charts, test_pwa_install, test_tool_cards, test_command_card | Borrar el fichero entero (**A/T/2**) |
| test_i18n | Conservar la simetría es/en y el reemplazo literal (**R**); borrar la traducción básica, los parámetros, el título y onChange (**A**) |
| test_utils | Conservar el escape y el saneado (**S**) y fetchWithTimeout (**L**); borrar serializeContent, clone y resolveDep (**T**) |
| test_state | De 19 a ~8: conservar los mutadores con invariantes (removeTurn, concurrencia, importación); borrar init, actualización parcial, funcional y reset (**A/T**) |
| test_config_store | Borrar los valores por defecto literales (tema, razonamiento, 16K, palabras del prompt) (**T**); conservar la migración, la activación de perfil y la limpieza de credenciales (**D/S**) |
| test_storage | Conservar la fidelidad de turnos, el orden, la cascada, el borrado solo de lo propio y los errores (**D**); borrar el CRUD básico de crear, listar y renombrar (**A**) |
| test_api_utils | Juntar las tres de Espejo en una; borrar «estimateTokens delega» (**M**); conservar SSE, errores, corte, reintento sin parámetro y `<tool_call>` |
| test_web_tools | Conservar SSRF y bordes; juntar en tablas los cuatro bloques de bordes y transporte |
| test_ui_telemetry | Borrar formatTokenCount y los umbrales (**T**); pasar TokenTelemetry a test_providers (**2**) |
| test_ui_generation_status, test_attachments, test_export, test_dialogs | Dejar una o dos por fichero (**L/D**) |
| test_project_context, test_task_helper | Conservar la paridad de `task.py` (**X**) y computeStatus; borrar las que leen textos de prompt (**T**) |
| test_ui_mcp | Conservar la URL de ayuda (**S**) y los reintentos de arranque (**L**); borrar generateTerminalCommand y browser_action activa (**T**) |
| test_office_parser, test_file_parser, test_markdown, test_message_turns, test_text_tool_calls, test_service_worker, test_vendor_loader, test_browser_compat, test_ui_inspector | Conservar (**L/R/S**); juntar en tablas; borrar el manifiesto válido (**T**) y el vendor_loader duplicado |

### integration (345 → ~170)

| Grupo | Propuesta |
|---|---|
| chat_engine, agent_runtime, agent_core, tool_dispatcher, delegate_task, generation_controller (79) | Objetivo ~35. El bucle de turno, la detección de bucles, el reenvío del razonamiento y la cancelación se prueban una vez cada uno. Borrar generation_controller (**2** con browser) |
| providers, context_cache, webllm, inspector, context_manager (76 + 7) | Objetivo ~40: una prueba de tabla por adaptador para payload, SSE y errores (**X**). En webllm, borrar las del Worker simulado (**M**) y la «ejecución incompleta» trivial |
| mcp, mcp_tools, tool_security, security, builtin_tools (78) | Objetivo ~45. tool_security pasa a una matriz de casos sin perder ninguno (**S**). Borrar test_security (**2**: sanitize ya está en markdown/utils y CSP es estático) y builtin «carga exactamente los módulos» (**A**) |
| rag_service, rag_index, rag_storage, ingestion_*, office_documents (56) | Objetivo ~30: conservar el aislamiento de ramas (**S**), la cascada y la importación (**D**) y el ranking como tabla (**L**) |
| profiles, project_context, conversation_service, storage_reset, temporal_context, error_infrastructure (60) | Objetivo ~25: conservar el cifrado y la ausencia de claves en claro (**S/D**) y la máquina de estados del proyecto en tabla. Borrar error_infrastructure (**T**) y las de «conserva la descripción» (**T**) |

### browser (179 → ~70)

| Bloque | Propuesta |
|---|---|
| Lo trasladado en M24 (2.767 líneas) | Revisarlo primero: borrar `tableToCsv`, «primitivas de DOM», el icono de copiar, «una conversación nueva deja la telemetría neutra» y las que prueban un render concreto en vez de un flujo (**T/2**) |
| Cosmética y maquetación | Borrar el contorno azul de los select, la alineación, las «superficies suaves», el ancho del panel y el ancho completo en móvil (**C**). Se conservan solo las que evitan un fallo funcional, como un botón que queda fuera de la pantalla o un menú tapado |
| Flujos duplicados | El borrado de turno (3 veces), la bifurcación (3 veces) y la importación de JSON (2 veces) quedan en una prueba cada uno |
| browser_startup | Se convierte en la prueba de humo de la sección 2 y absorbe las pruebas **A** del resto |
| browser_sandbox_security, browser_dialogs_notices | Conservar (**S**); juntar en tablas |

### Resultado final y objetivos acordados (M24-T27)

| Nivel | Ficheros | Pruebas | Líneas | Tiempo ejecución |
|---|---|---|---|---|
| unit | 22 (-24%) | 146 (-28%) | 3.213 (-27%) | ~0,8s |
| integration | 25 (-7%) | 272 (-21%) | 7.527 (-21%) | ~2,3s |
| architecture | 13 (-7%) | 35 (-27%) | 879 (-17%) | ~0,8s |
| infrastructure | 5 (-17%) | 34 (-21%) | 2.426 (-5%) | ~6,5s |
| browser | 17 (=) | 104 (-42%) | 4.828 (-42%) | ~12,6s |
| helpers | 7 | — | 338 | — |
| **Total** | **89 (-10%)** | **591 (-28%)** | **19.211 (-27%)** | **~20s total suite** |

Se eliminaron 229 pruebas y 6.967 líneas de prueba redundantes sin comprometer la seguridad ni la integridad de datos. Los objetivos máximos acordados en M24-T27 para la cláusula *Done when* son:
- Suite: ≤ 600 pruebas y ≤ 20.000 líneas.
- Tiempos de ejecución: Node (`npm test`) < 10s, navegador (`npm run test:browser`) < 15s.

## 6. Procedimiento en cada tarea

1. Medir el antes: número de pruebas, líneas y tiempo del nivel.
2. Clasificar cada prueba con su letra. Si alguna no encaja, se pregunta antes de decidir.
3. Borrar y fusionar. Sin añadir pruebas nuevas, salvo la de humo (M24-T17).
4. Volver a pasar el detector de código fantasma y quitar lo que haya quedado sin consumidor.
5. Pasar el nivel afectado y el de arquitectura, y anotar el antes y el después en el mensaje del commit.
