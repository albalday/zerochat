# Current state
- Milestone: M96 Esquema único de agentes (.md), controlador y subagentes
- Next task: M96-T1 Formato único `.md` en `parse_run_request`, `format_run_request` y `--run-file`: sustituir el JSON por Markdown con cabecera fija `---` (`agent`, `conversation_id`, `profile`, `controller`, `projectMode`, `reasoning`, `maxSteps`, `timeout`) y secciones `<!-- system -->` (`systemDataPrompt`, por defecto el texto sin marcador tras `---`) y `<!-- prompt -->` (`prompt`), sin `watchAgents`; serializar también en `.md` hacia `stdin` en `launch_run_file`, relajar `validate_agent_id` a 1 o 2 segmentos (`<name>` o `<set>.<name>`), revisar el tope de `validate_project_prompt` para manuales largos y añadir pruebas en el nivel más bajo
- Last closed: M94 and M95 (2026-11-26)
- Last updated: 2026-11-26
