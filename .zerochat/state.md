# Current state
- Milestone: M95 Auditoría 10.48.1
- Next task: M95-T44 CONSULTA AL USUARIO — ZIP-bomb en js/office-parser.js (F-18, sacada de T25): el tope por entrada sí funciona (fflate descomprime en un búfer del tamaño declarado y no lo agranda), pero no hay tope acumulado (entradas XML de hasta 50 MB cada una) y parseDocx pasa por mammoth/JSZip sin ninguno; ¿qué tope total por documento (p. ej. 200 MB) y se acepta que un DOCX que lo supere se rechace (comprobando antes los tamaños declarados del directorio central)?
- Also open: M94 (Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-25 — M94-T1)
- Last closed: M93 (2026-11-25)
- Last updated: 2026-11-26
