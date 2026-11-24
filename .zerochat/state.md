# Current state
- Milestone: M88 Ajustes de control de agentes
- Next task: M88-T3 Afinar plantillas de controlador (templates/project/mode-agent.txt y mode-agent-templates.txt): aclarar que check_agents(conversation_id=..., wait_seconds=...) ya devuelve el primer bloque de result_text (20000 chars) cuando el agente termina y que solo hace falta otra llamada con offset si next_offset no es null (o desde el listado general cuando result_text supera 4000 chars y viene solo result_chars), evitando relecturas duplicadas
- Last closed: M87 Mejoras sistema de agentes (2026-11-24)
- Last updated: 2026-11-24
