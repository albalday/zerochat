# Auditoría Histórica: Evolución de ZeroChat según Git

**Fecha**: 4 de octubre de 2026  
**Periodo analizado**: 26 de agosto a 4 de octubre de 2026 (772 commits, de ChatCLI v0.9 a ZeroChat v8.12.4)  
**Documentos relacionados**: [`arquitectura.md`](arquitectura.md), [`funcionalidades.md`](funcionalidades.md), [`comparacion.md`](comparacion.md)

### Autoría

| Papel | Agente |
|---|---|
| Primera aproximación (borrador) | Gemini 3.8 Flash en Google Antigravity |
| Verificación, corrección y redacción final | Claude Opus 5.5 (`claude-opus-5-5`) en Claude Code |

Los agentes trabajaron a partir de instrucciones del responsable del proyecto, sin redacción humana del contenido.

### Método y límites

Este informe distingue dos tipos de afirmación:

- **Hecho**: comprobable con `git log`, `git show` o el contenido del repositorio en un commit concreto. Fechas y versiones proceden de la fecha del commit y del `package.json` o el `<title>` de ese commit.
- **Interpretación**: lectura razonable de los hechos, marcada como tal.

La mayoría de los commits solo tienen título. **El historial no registra los motivos de las decisiones**, así que este informe no atribuye causas que los commits no documenten.

---

## 1. Cifras del periodo

* **772 commits en 40 días naturales**, unos 19 al día de media, con picos de 65 (29/08) y 74 (02/09).
* Los commits incluyen la firma de varios agentes de codificación (Claude Opus 5, Opus 5.5 y Fable 5.1 como coautores). En `65746ba` (02/09) la documentación ya menciona el desarrollo "zero-code" con Codex y Antigravity.

**Interpretación**: el ritmo y la firma de los commits encajan con un desarrollo dirigido por instrucciones y ejecutado mayoritariamente por agentes, coherente con lo que declara `help/learning.html`.

---

## 2. Fases

```
26 Ago                 28 Ago                 02 Sep                 17 Sep                 03 Oct
   |                      |                      |                      |                      |
   v                      v                      v                      v                      v
[ChatCLI] ---------> [AgentCore/MCP] ----> [Orama/AGENTS.md] ---> [zerochat.py/PyPI] --> [Endurecimiento]
 voz, avatares,       poda de audio,         SVG, ChatDialogs,      fin del bundle,         token 0600, slices
 bundle               ZeroChat v5.1          WebLLM (11 Sep)        py/, HMAC (27 Sep)      ChatState, <tool_call>
```

### Fase 1: ChatCLI multimedia (26–27 de agosto)
* `39fed30` (26/08): commit inicial, **ChatCLI v0.9**.
* `1fdf4d5` (26/08): el bucle agéntico multiturno pasa de recursión a un `while` iterativo. El commit no explica el motivo.
* `dfdc964` (26/08): v2.1 con barra lateral multichat, gráficos SVG, voz (STT/TTS), pegado de imágenes y exportación.
* `5185b0f` y `fa2ecde` (27/08): ajustes de TTS con `speech-dispatcher` y `espeak-ng` en Linux.
* `cd45cd8` (27/08): se eliminan los avatares de usuario y asistente.

### Fase 2: Retirada del audio, AgentCore y MCP (28–31 de agosto)
* `cbc4cb1` (28/08): se elimina todo el subsistema de voz (dictado STT y reproducción TTS).
* `140d5a8` y `969526e` (28/08): `AgentCore`, arquitectura modular de herramientas y primer soporte MCP.
* `f416f53` (29/08): se introduce un empaquetador de dos niveles con minificación.
* `ad107f4` (30/08): el proyecto pasa a llamarse **ZeroChat**. `cdfb631` documenta ZeroChat v5.1 con **Tree-RAG** experimental.
* `6bc97d4` (30/08): Tree-RAG guarda su estructura en el sistema de archivos local (`./zerochat/RAG`) con buckets paginados y resúmenes en Markdown.

### Fase 3: Orama, normas e interfaz (2–16 de septiembre)
* `481c9c6` (02/09, v5.3.0): el RAG migra a **Orama** en memoria con la base unificada `ZeroChatDB`. El historial no contiene ninguna mención a embeddings.
* `d37ff35` (02/09): primer commit de `AGENTS.md`.
* `abb692c` (03/09, v6.0.0): migración completa a iconos SVG (`ChatIcons`).
* `cfdab94` (08/09, v6.5.2): los mensajes inyectados al modelo pasan a redactarse en inglés.
* `11a0389` (09/09, v6.5.4): los diálogos nativos se sustituyen por diálogos internos.
* `e20a70c` (11/09, v6.6.0): inferencia local con **WebLLM**.
* `9b71c83` (13/09): la conexión MCP automática se condiciona al uso previo para evitar avisos de Private Network Access.

### Fase 4: Backend unificado, PyPI y firmas (17–30 de septiembre)
* `5ac5cd4` (17/09): primer token diario en el backend.
* `f58544f` (17/09, v7.0.0): se unifica `zerochat.py` y **se elimina el bundle** junto con código muerto.
* `9083f2b` (21/09) y `c69c382` (21/09, v7.5.0): preparación de la distribución PyPI y unificación del entorno MCP local.
* `b3db5f0` (23/09, v7.8.1): `zerochat.py` se divide en módulos `py/*.py` ensamblados por orden alfabético.
* `c51d0a8` (27/09): firma de las llamadas autorizadas a herramientas locales (HMAC).

### Fase 5: Endurecimiento y cierre de la serie 8.x (1–4 de octubre)
* `2059455` (03/10, v8.10.4): se eliminan escrituras directas al slice `ui` de `ChatState`.
* `c6fca95` (03/10): el token se crea con permisos `0600` en un directorio `0700`.
* `d4692e1` (03/10): `AGENTS.md` documenta que la autorización se basa en el token y acepta el riesgo del origen compartido en GitHub Pages.
* `e44dd02` (04/10, pre-v8.12.0): herramientas mediante bloques `<tool_call>` en texto para WebLLM.
* `ffdbc6c` (04/10): limpieza de código muerto antes de publicar la 8.12.4 (`aff1019`).

---

## 3. Cronología resumida

| Fecha | Versión | Commit | Hecho |
|---|---|---|---|
| 26/08 | v0.9 | `39fed30` | Nace ChatCLI |
| 26/08 | v2.1 | `dfdc964` | Voz STT/TTS, multichat, exportación |
| 28/08 | — | `cbc4cb1` | Eliminación del subsistema de voz |
| 28/08 | — | `140d5a8`, `969526e` | AgentCore y primer MCP |
| 30/08 | v5.1 | `ad107f4`, `cdfb631` | Renombrado a ZeroChat; Tree-RAG experimental |
| 02/09 | v5.3.0 | `481c9c6` | RAG con Orama y `ZeroChatDB` |
| 02/09 | v5.3 | `d37ff35` | Primer `AGENTS.md` |
| 03/09 | v6.0.0 | `abb692c` | Iconos SVG |
| 08/09 | v6.5.2 | `cfdab94` | Mensajes inyectados en inglés |
| 09/09 | v6.5.4 | `11a0389` | Diálogos internos en lugar de nativos |
| 11/09 | v6.6.0 | `e20a70c` | WebLLM |
| 17/09 | v7.0.0 | `f58544f` | `zerochat.py` unificado; fin del bundle |
| 21/09 | v7.5.0 | `c69c382` | Entorno MCP unificado; PyPI |
| 23/09 | v7.8.1 | `b3db5f0` | Backend modular `py/` |
| 27/09 | — | `c51d0a8` | Firmas HMAC de llamadas a herramientas |
| 03/10 | v8.10.4 | `2059455`, `c6fca95`, `d4692e1` | Slices de estado, token 0600, riesgo de origen aceptado |
| 04/10 | v8.12.0 | `e44dd02` | `<tool_call>` en texto para WebLLM |
| 04/10 | v8.12.4 | `aff1019` | Publicación auditada |

---

## 4. Qué aporta la historia a los otros informes

Los otros tres informes describen el estado final. El historial añade contexto que no se ve en ese estado:

1. **El alcance actual es fruto de descartes, no de un diseño inicial.** ChatCLI incluía voz, avatares y un empaquetador; los tres se retiraron (28/08, 27/08 y 17/09). El historial registra *qué* se retiró, pero no *por qué*.
2. **El RAG léxico sustituyó a un experimento previo.** Tree-RAG (resúmenes en Markdown sobre el sistema de archivos) duró unos tres días antes de la migración a Orama. No hay evidencia de que se probaran embeddings.
3. **Las normas de `AGENTS.md` aparecen junto con los cambios que regulan.** El primer `AGENTS.md` (02/09) coincide con la fase de mayor actividad, y las normas sobre iconos, inglés y diálogos llegan con sus migraciones (03/09, 08/09, 09/09). *Interpretación*: el reglamento se fue construyendo para fijar decisiones y evitar que los agentes las revirtieran; los commits no documentan los incidentes concretos.
4. **El tool calling en texto es reciente.** `<tool_call>` se añadió el 4 de octubre, más de tres semanas después de WebLLM. Tiene poco recorrido de uso, y los informes deberían tratarlo como función nueva, no consolidada.
5. **La seguridad del backend se endureció tarde.** Token diario (17/09), firmas HMAC (27/09), permisos `0600` y aceptación documentada del riesgo de origen (03/10) llegan en la segunda mitad del periodo.
6. **El ritmo exige verificación.** Con unos 19 commits diarios, la documentación tiende a quedarse atrás. Los propios borradores de estas auditorías contenían errores de fechas y capacidades, lo que justifica verificar cada afirmación contra el código.

---

## 5. Conclusión

El historial muestra un proyecto de aprendizaje que avanzó rápido, retiró subsistemas enteros (voz, avatares, bundle, Tree-RAG) y fue fijando normas a medida que crecía. Esto coincide con la descripción de [`help/learning.html`](../../help/learning.html): un proyecto personal para aprender sobre clientes de IA y ejecución agéntica y para practicar cómo definir tareas, revisar propuestas y comprobar cambios generados con ayuda de agentes.

El estado final descrito en los otros informes es real. El historial explica cómo se llegó a él y recuerda que sus partes más recientes (`<tool_call>`, endurecimiento de seguridad) son las menos probadas por el uso.
