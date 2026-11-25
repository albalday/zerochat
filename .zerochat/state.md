# Current state
- Milestone: M89 Adaptación del bucle agéntico al contexto del modelo
- Next task: M89-T8 Recorte de evidencia visual en turnos cerrados y pasos podados (js/chat-engine.js, js/context-manager.js): adjuntar bloques image_url de evidencia visual (TOOL_EVIDENCE_FLAG) solo para los pasos recientes del turno en curso cuyos resultados no hayan sido podados (o hasta un máximo acotado de imágenes recientes del turno activo), omitiendo los bloques de imagen de turnos pasados cerrados y de pasos podados en los que ya queda su descripción textual en el mensaje tool, con pruebas en test_context_manager.js
- Last closed: M87 Mejoras sistema de agentes (2026-11-24)
- Last updated: 2026-11-25
