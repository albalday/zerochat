# Current state
- Milestone: M96 Esquema único de agentes (.md), controlador y subagentes
- Next task: M96-T2 `controller: true` para herramientas de controlador (retirando `watchAgents`): activar y autorizar `launch_agent` y `check_agents` solo cuando la cabecera declara `controller: true`, permitiendo consultar y lanzar cualquier agente del proyecto (o carpeta autorizada por `R:`/`X:`/`RW:`, nunca chats humanos ni su propia conversación) e impidiendo lanzar otro agente con `controller: true` (sin anidamiento), con pruebas en `py/`
- Last closed: M94 and M95 (2026-11-26)
- Last updated: 2026-11-26
