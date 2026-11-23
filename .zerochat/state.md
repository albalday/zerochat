# Current state
- Milestone: M86 Mejoras para proyectos de agentes y `--run-file`
- Next task: M86-T21 Calidad M86 (backend y contrato de navegador): (1) en py/tools/registry.py, incluir CHECK_AGENTS_DEFINITION en validate_local_tool_arguments para validar tipos y rechazar argumentos desconocidos en check_agents, y en reset_session_authorizations (py/cli/main.py) autorizar check_agents en la capa de sesión solo cuando session.watch_agents no esté vacío; y (2) incluir userAgentMaxLength (512) en tests/fixtures/mcp/contract.json y probar el borde exacto N y N+1 en tests/unit/test_ui_browser.js, con pruebas
- Last closed: M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20 (2026-11-22)
- Last updated: 2026-11-23
