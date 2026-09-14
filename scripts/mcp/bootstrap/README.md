# Bootstrap descargable pendiente de implementar

Implementar `bootstrap.py` con biblioteca estándar de Python. Entrada: raíz privada MCP, release verificada y canal stdin/stdout heredado del servidor local. Salida: progreso/errores JSON por línea y relevo al gestor mediante el Python de `env/`.

Responsabilidades: lock, comprobación de Python, creación/reutilización del venv y preparación del paquete host. El protocolo debe permitir cancelar sin dejar hijos. Los logs van a stderr. No definir productos aquí; sus instrucciones pertenecen al catálogo/gestor descargables.

El archivo se publica fuera del bundle. Véanse las fases y límites en `../README.md`.
