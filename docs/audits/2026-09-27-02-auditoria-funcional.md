# Auditoría funcional de ZeroChat para uso personal puntual

Fecha: 27 de septiembre de 2026. Base: ZeroChat **7.12.0**, rama `dev`, commit `b0d55a7d3094178ca0a5f9afe24747ae283102b3`.

Estado: informe cerrado, sin cambios funcionales. Complementa la [auditoría técnica](2026-09-27-01-auditoria-tecnica.md) y la [comparativa competitiva](2026-09-27-03-comparativa-competencia.md).

## 1. Dictamen y criterio de evaluación

**El producto encaja bien como banco de pruebas personal de modelos, endpoints, herramientas y pequeños proyectos.** Su amplitud funcional ya es suficiente para ese propósito. El mayor retorno vendría de facilitar la vuelta después de semanas sin usarlo, mejorar la reproducibilidad de los experimentos y hacer inequívocos el alcance de las herramientas y el destino de los datos.

No se penaliza la ausencia de organizaciones, SSO, facturación, permisos de equipo, alta disponibilidad o despliegues distribuidos: quedan fuera del objetivo indicado. Tampoco se presupone que deba competir con un IDE completo o convertirse en plataforma de automatización permanente.

Se evalúa a una persona técnica que usa su propio equipo, dispone de un modelo local o una API, trabaja de forma supervisada y necesita resolver tareas acotadas. El éxito consiste en abrir, configurar o recuperar una conexión, probar algo, entender el resultado, conservar lo necesario y cerrar sin residuos confusos.

La evidencia procede del código, la ayuda y las **666 pruebas aprobadas** de la suite completa. La valoración de facilidad de uso es heurística: no se realizaron sesiones con usuarios ni una batería de tareas con proveedores reales. «Disponible» significa implementado y respaldado por la evidencia indicada; no garantiza la calidad del modelo seleccionado.

## 2. Inventario evaluado

| Capacidad | Estado observado | Valor para el objetivo | Condiciones y límites |
|---|---|---|---|
| Chat con streaming | Disponible | Esencial | Depende del proveedor, red y capacidades del modelo |
| Adaptadores OpenAI compatible, Claude, Gemini, Ollama y OpenRouter | Disponibles | Muy alto para cambiar de sistema | CORS y diferencias de API requieren diagnóstico; compatibilidad de protocolo no garantiza todas las funciones |
| LM Studio y vLLM | Utilizables mediante endpoint compatible | Muy alto para pruebas locales | ZeroChat no instala esos motores ni sus modelos |
| Perfiles de conexión | Disponibles, con exportación/importación | Muy alto para volver a una configuración | El perfil no sustituye una instantánea completa e inmutable de un experimento |
| Modo Espejo | Disponible | Excelente para observar la petición sin consumir API | No ejecuta un modelo ni certifica que el proveedor real acepte la petición |
| Inspector, debug y telemetría | Disponibles | Diferenciador para pruebas | Distinguir métricas publicadas de estimaciones y capacidades asumidas |
| Razonamiento y parámetros | Disponibles según adaptador | Alto | Lo visible depende de lo que exponga el proveedor |
| Conversaciones y gestión de turnos | Disponibles | Alto | Persistencia ligada al origen/perfil del navegador |
| Exportación de conversación a JSON/Markdown e impresión | Disponible | Alto para conservar resultados | No equivale a copia única del estado completo del producto |
| Adjuntos y extracción documental | Disponibles | Alto | Parser propio: verificar fidelidad según formato y documento |
| Conocimiento local por ramas | Disponible | Alto para manuales y notas pequeñas | Ingesta local; consulta textual, con límites de recuperación semántica |
| Herramientas RAG de búsqueda y lectura de fragmentos/imágenes | Disponibles | Alto para preguntas con evidencia | Requieren uso correcto de herramientas y, para imágenes, capacidad visual |
| Búsqueda y lectura web | Disponibles con estrategias alternativas | Útil | Servicios externos, CORS y bloqueos pueden afectar resultado y privacidad |
| JavaScript y gráficos | Disponibles | Alto para cálculos y análisis cortos | Entorno restringido y temporal; no sustituye un proceso general del sistema |
| Bucle agéntico, plan y checkpoints | Disponibles | Útil en tareas de varios pasos | Modelo capaz, presupuesto y supervisión; la compacción puede perder información |
| Archivos, shell y diagnósticos locales | Disponibles con backend | Muy alto para proyectos pequeños | Ejecutan con permisos del usuario; autorización no equivale a sandbox del sistema |
| MCP | Disponible | Muy alto como cliente de pruebas | Requisitos de cada servidor; no se certificó conformidad completa de todos los transportes/versiones |
| Navegación con Playwright | Disponible de forma condicional | Útil para smoke tests | Requiere Node, Playwright y Chromium; defecto de recuperación T04 |
| Inferencia WebLLM en navegador | Disponible de forma condicional | Interesante como opción autónoma | WebGPU, memoria, descarga y caché de modelos; no validada con GPU real en esta auditoría |
| PWA y caché web | Disponibles | Conveniencia para uso recurrente | No hacen offline a una API remota; actualización parcial pendiente de ensayo |
| Español e inglés, temas y adaptación móvil | Disponibles con pruebas de interfaz | Adecuado | Sin evaluación completa de accesibilidad ni matriz de todos los navegadores |

Evidencia principal: [proveedores](../../js/providers.js), [perfiles](../../js/profile-repository.js), [inspector](../../js/ui-inspector.js), [telemetría](../../js/ui-telemetry.js), [exportación](../../js/export.js), [índice RAG](../../js/rag-index.js), [agente](../../js/agent-core.js), [herramientas](../../js/tools/README.md) y [backend local](../../py/dd-tools.py).

## 3. Evaluación por tarea real

### A. «Quiero probar un endpoint o un modelo durante diez minutos»

**Encaje alto.** Perfiles, adaptadores, descubrimiento/inspección y métricas permiten separar una mala conexión de una limitación del modelo. El modo Espejo es especialmente útil para comprobar el contexto y formato antes de enviar datos.

La fricción previsible está en la relación entre URL base, tipo de proveedor, clave, modelo, capacidades y CORS. Un fallo de navegador puede parecer un fallo del modelo. El inspector existente reduce esa incertidumbre, pero conviene convertir sus resultados en una guía de diagnóstico breve y accionable.

**Mejora propuesta:** un recorrido «probar conexión» que muestre proveedor efectivo, petición mínima, error clasificado y siguiente paso. Debe reutilizar el inspector. Criterio de aceptación: en una sesión limpia, distinguir endpoint inexistente, 401, modelo ausente, CORS y ausencia de tool calling sin consultar el código.

### B. «Quiero comparar dos configuraciones para mi proyecto»

**Encaje medio-alto para comparación manual; incompleto como sistema de evaluación.** Cambiar de perfil y conservar conversaciones permite experimentar. No se encontró un flujo integrado que ejecute automáticamente un corpus fijo, repita condiciones y genere una comparación de calidad/coste con criterios del usuario.

Es una oportunidad alineada con el propósito, pero no justifica construir un laboratorio de evaluación empresarial. El primer paso útil sería exportar una ficha del experimento: modelo, endpoint sin secretos, parámetros efectivos, herramientas habilitadas, prompt, contexto, métricas y fecha.

**Aceptación propuesta:** repetir manualmente un caso con dos perfiles y poder explicar qué cambió. No prometer respuestas deterministas, ni interpretar tokens por segundo de distintos equipos como una medida universal de calidad.

### C. «Quiero consultar unos manuales o notas personales»

**Encaje alto para material pequeño y vocabulario reconocible.** La ingesta no exige pagar embeddings ni operar una base de datos externa. Las ramas separan temas, y las herramientas de lectura permiten ampliar un resultado sin enviar inicialmente todo el documento.

El índice implementado es textual con ponderaciones y tolerancia; no es un sistema de embeddings semánticos. Puede ser una elección acertada para identificadores, mensajes de error y documentación técnica. No debe venderse como equivalencia demostrada a recuperación semántica para sinónimos, traducciones o preguntas abstractas.

El límite de 50 MiB por documento no representa capacidad garantizada del corpus. PDF escaneado, maquetación compleja, tablas e imágenes requieren evaluación específica; no se acredita un OCR general de alta fidelidad. El modelo debe poder utilizar las herramientas de conocimiento.

**Mejora propuesta:** una vista de diagnóstico que explique fragmentos encontrados y ausencias, apoyándose en las herramientas existentes. Evaluar veinte o treinta preguntas representativas antes de añadir embeddings: exactas, paráfrasis, bilingües y sin respuesta. Medir recuperación de la fuente correcta y fidelidad de la respuesta, por separado.

### D. «Quiero leer y cambiar un proyecto pequeño»

**Encaje alto con supervisión.** Lectura, búsqueda, edición, diagnósticos y comandos cubren tareas acotadas. El agente puede alternar razonamiento y herramientas y registrar avances.

La diferencia importante es que los comandos se ejecutan en el equipo del usuario. El shell y navegador del backend comparten estado por proceso; iniciar otra conversación no acredita un entorno limpio. La capacidad de editar archivos tampoco demuestra control automático de Git, revisión de diffs o reversión equivalente a una herramienta de programación dedicada.

**Mejora propuesta:** mostrar carpeta efectiva, estado compartido y acciones autorizadas al iniciar una tarea; permitir reiniciar el contexto de ejecución. Para ediciones, priorizar revisión y recuperación del cambio. Criterio de aceptación: completar una tarea en una carpeta temporal, revisar lo modificado, cancelar otra y comprobar qué procesos/archivos permanecen.

### E. «Quiero probar un servidor MCP o una automatización web»

**Encaje alto como cliente de inspección y uso puntual; fiabilidad condicionada.** El host local permite gestionar servidores y normalizar herramientas. Las políticas y confirmaciones son útiles para descubrir qué hace cada llamada.

No debe confundirse conexión satisfactoria con conformidad completa del protocolo. Los procesos externos, dependencias y navegador añaden puntos de fallo. T04 demuestra que el cierre inesperado de Playwright puede bloquear la sesión.

**Mejora propuesta:** corregir recuperación y ofrecer una prueba de salud que distinga instalado, arrancado, conectado y listo para ejecutar. Ensayar un MCP ficticio que responde, falla, tarda y se desconecta, sin necesitar cuentas externas.

### F. «Vuelvo dentro de un mes y quiero recuperar mi trabajo»

**Encaje medio.** Perfiles y conversaciones persisten, y existen exportaciones de perfiles, conversaciones y ramas RAG. También hay controles de cuota/persistencia del almacenamiento. La copia y restauración están fragmentadas entre subsistemas; no se debe presentar esto como ausencia total de backup.

Cambiar de origen, navegador o perfil puede hacer que los datos parezcan perdidos. En distribución normal, PyPI y descarga usan el mismo origen de GitHub Pages, lo que reduce este problema, pero el desarrollo local sigue teniendo otro almacenamiento.

**Mejora propuesta:** un resumen «qué está guardado y dónde», con enlaces a las exportaciones existentes y una restauración ensayada en un perfil de navegador vacío. La prioridad es que el usuario sepa recuperar su trabajo, no añadir sincronización en la nube por defecto.

## 4. Adecuación y exceso de alcance

| Mantener como núcleo | Mantener como opción avanzada | Posponer salvo necesidad demostrada |
|---|---|---|
| Perfiles, inspector, Espejo, streaming y exportación | MCP, agente, shell y Playwright | Multiusuario, RBAC corporativo y SSO |
| Conversaciones, adjuntos y conocimiento pequeño | WebLLM y ajustes finos de contexto | Automatización 24/7 y colas distribuidas |
| Errores comprensibles y restauración | Políticas de autorización detalladas | Catálogo masivo de integraciones propias |
| Telemetría que distinga datos de estimaciones | Checkpoints y diagnóstico de herramientas | IDE completo o gestor general de modelos |

La interfaz ya concentra muchas decisiones. Para uso ocasional, la complejidad debe aparecer cuando la tarea la necesite: conversación simple, prueba de conexión, documentos o herramientas. Esta recomendación es una hipótesis de usabilidad, no el resultado de una prueba A/B. No implica añadir otra capa de estado ni rediseñar toda la aplicación.

## 5. Brechas priorizadas

| Prioridad | Brecha | Propuesta mínima | Evidencia de éxito |
|---|---|---|---|
| P1 | Riesgos técnicos reproducidos | Corregir T01, T02 y T04 del informe técnico | Regresiones automatizadas y recuperación verificada |
| P1 | Expectativas de privacidad/cifrado | Indicar destinos y protección real de secretos | El usuario puede identificar qué sale del dispositivo |
| P2 | Diagnóstico disperso al volver a usar la app | Recorrido breve apoyado en el inspector | Completar conexión o entender el fallo sin documentación técnica |
| P2 | Experimentos difíciles de reproducir | Ficha exportable sin credenciales | Comparar dos ejecuciones con condiciones conocidas |
| P2 | Restauración repartida en varios flujos | Resumen de copias y prueba de recuperación | Recuperar perfiles, conversación y RAG en un navegador limpio |
| P2 | Contexto local compartido poco evidente | Carpeta/estado visibles y reinicio explícito | Cambiar de proyecto sin heredar estado inesperado |
| P3 | Calidad RAG no cuantificada | Corpus pequeño de evaluación | Fuentes correctas y respuestas sin evidencia identificadas |
| P3 | Consumo difícil de anticipar | Resumen por ejecución y límites comprensibles | Distinguir presupuesto de contexto, pasos y coste monetario |

Ya existen límite de pasos, presupuestos de contexto, cancelación y telemetría. La última propuesta no supone que falten todos los límites: no se verificó un presupuesto monetario duro por tarea, y una estimación de tokens no equivale a facturación del proveedor.

## 6. Protocolo de aceptación funcional propuesto

Estos criterios son **objetivos para la próxima consolidación**, no métricas obtenidas en esta auditoría:

1. Con endpoint disponible y conocido, iniciar una conversación desde un perfil vacío en menos de cinco minutos; registrar bloqueos y consultas a la ayuda.
2. Recuperar un perfil tras semanas de inactividad e identificar modelo y carpeta efectiva antes de usar herramientas.
3. Comparar dos configuraciones y exportar condiciones/resultados sin API keys ni token local.
4. Ingerir un conjunto pequeño de documentos, resolver preguntas exactas y paráfrasis, y reconocer una pregunta sin respaldo documental.
5. Aprobar una edición en una carpeta temporal, revisar el resultado y rechazar otra sin efectos secundarios.
6. Cancelar un comando o herramienta lenta y comprobar terminación efectiva o una advertencia precisa del trabajo que continúa.
7. Simular caída de MCP/navegador y recuperar la sesión sin reiniciar toda la aplicación.
8. Restaurar las exportaciones en un perfil de navegador vacío y comprobar mensajes, adjuntos y conocimiento que cada formato promete conservar.

Registrar tiempo, errores, resultado de tarea y necesidad de ayuda. Probar español e inglés, una ventana estrecha y navegación por teclado. Empezar con una o dos personas que no conozcan la arquitectura ya aportaría más evidencia de usabilidad que añadir nuevas funciones.

## 7. Orientación recomendada

La propuesta más coherente es: **«Un banco de pruebas personal de IA para conectar modelos, inspeccionar peticiones y probar herramientas sobre proyectos pequeños, con datos guardados en tu navegador y un backend local opcional»**.

Esta formulación refleja lo implementado y evita promesas de confidencialidad absoluta, autonomía ilimitada o sustitución de un IDE. La madurez necesaria para el objetivo depende sobre todo de errores recuperables, límites claros y resultados que se puedan guardar y repetir.
