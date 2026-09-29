# Ejemplo de MCP gestionado

Esta carpeta es la plantilla para que un agente cree un servicio MCP gestionado por ZeroChat. Para crear uno nuevo, copie esta estructura en `~/zerochat/services/<id-seguro>/`; no modifique este ejemplo.

## Archivos

- `service.json` es obligatorio. Define el identificador, los textos visibles, el proceso y el campo estándar opcional `help`.
- `installer.json` es opcional. Créelo a partir de `installer.json.example` solo si ZeroChat debe instalar un paquete npm. Fije siempre una versión exacta.
- El ejecutable o script de arranque se declara en `launch`. Use `${serviceDir}`, `${pythonExecutable}` o `${nodeExecutable}` en lugar de rutas de usuario.

## Campo de ayuda

Todos los servicios pueden incluir:

```json
"help": {
  "url": "help/mcp.html#crear-mcp-con-agente",
  "label": { "es": "Texto en español", "en": "English text" }
}
```

La interfaz muestra ese enlace en la tarjeta del servicio. `url` debe ser una ruta relativa de ZeroChat o una URL `https:` o `http:`.

## Instrucción para un agente

Sustituye solo `<nombre-del-mcp>` en este texto:

```text
Siguiendo estrictamente la estructura de ~/zerochat/services/ejemplo, busca en Internet la documentación oficial de instalación del MCP <nombre-del-mcp> y crea en ~/zerochat/services/ el directorio y los JSON necesarios para instalarlo y ejecutarlo en ZeroChat. Usa exclusivamente fuentes oficiales, fija versiones concretas, añade la sección help con el enlace a la documentación oficial, no incluyas secretos y no inicies el servicio. Al terminar, resume los archivos creados, las fuentes consultadas y los requisitos pendientes.
```
