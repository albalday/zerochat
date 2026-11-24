# Current state
- Milestone: M87 Mejoras sistema de agentes
- Next task: M87-T23 Contrato único de POLICY_ASK en modo ejecución: cerrar en py/server/tool_calls.py la excepción silenciosa que hoy permite herramientas MCP externas (origin=='external') con POLICY_ASK sin autorización, alinear si POLICY_ASK pausa en needs_input (tool_approval) o deniega todas en desatendido y retirar el código muerto resultante (pause_for_user / answerToolApprovals en js/agent-core.js y js/run-mode.js), con pruebas de seguridad
- Last closed: M86 Mejoras para proyectos de agentes y `--run-file` (2026-11-23)
- Last updated: 2026-11-24
