# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora
- [ ] M81-T1 Propuesta: regenerar respuestas y editar la pregunta in situ, creando una rama automáticamente
- [ ] M81-T2 Propuesta: atajos de teclado (nueva conversación, buscar con Ctrl+K, parar con Esc, ayuda con ?)
- [ ] M81-T3 Propuesta: notificación en el título/icono de la pestaña cuando un turno termina en segundo plano o pide permiso, sin usar la API Notification
- [ ] M81-T4 Propuesta: prompts guardados, globales o por proyecto, insertables en el compositor con /
- [ ] M81-T5 Propuesta: asistente de primer perfil que detecta servidores locales bajo demanda y una tabla de qué funciona en navegador y servidor
- [ ] M81-T6 Propuesta: respaldo y restauración del almacén del servidor (zerochat --backup y --restore)
- [ ] M81-T7 Propuesta: RAG híbrido opcional, combinando /v1/embeddings del servidor de modelos con Orama
- [ ] M81-T8 Propuesta: batería de evaluación de agentes con zerochat --prompt contra modelos locales, sin tuning por modelo
- [ ] M81-T9 Propuesta: control de concurrencia entre pestañas con versión por conversación y 409 al guardar sobre versión obsoleta
- [ ] M81-T10 Propuesta: chequeo de tipos con JSDoc y tsc --checkJs --noEmit en el estado, el almacenamiento y el bucle de agentes

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20

Goal: que cada agente que trabaja en este repositorio traiga a .zerochat/ lo que solo guarda en su memoria privada.
Done when: el usuario confirma que todos los agentes que usa lo han hecho.
- [ ] M82-T1 Cada agente que lea esta tarea revisa su memoria privada de este proyecto frente al código y a .zerochat/, propone al usuario las tareas, decisiones y normas aún vigentes y no registradas (nunca secretos ni datos personales), las escribe una vez aprobadas y pregunta al usuario antes de marcar la tarea como hecha, porque otros agentes pueden faltar todavía
