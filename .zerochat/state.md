# Current state
- Milestone: M97 Arreglos pequeños agentes
- Next task: M98-T60 Mensajes de más de 512 KB sin texto (todo en tool_calls, p. ej. write_file de un fichero grande) desaparecen en silencio de la copia del servidor porque splitOversizedMessage (js/storage.js) solo trocea content: trocear también los argumentos de tool_calls en zerochat/conversations/save_chunk (frontend y backend py/storage), sin pérdida; aplazada por tocar el backend (F-19, parte 2; elegida frente a recortar los argumentos o fallar la subida)
- Last closed: M95 and M96 (2026-11-26)
- Last updated: 2026-11-28
