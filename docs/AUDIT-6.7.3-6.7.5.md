# Auditoría completa desde 6.7.3

Fecha: 2026-09-15  
Base revisada: `0704c8e` (`chore: release v6.7.3`)  
Cabeza auditada: `13db6bf` (`fix(mcp): vincular servicios externos a zmcp`)

## Alcance y resultado

El intervalo contiene 127 archivos modificados (6.655 altas y 5.077 bajas). Se
revisaron la reorganización de pruebas, RAG, interfaz, generación del bundle y
la nueva arquitectura MCP descargable. El árbol de trabajo estaba limpio al
terminar la auditoría.

La separación entre las cuatro herramientas locales y el host MCP externo está
bien planteada: no se accede a la fuente externa hasta la acción explícita de
arranque, y el host externo se elimina al desconectar ZMCP. Sin embargo, no es
apto para publicar la descarga de código externo hasta resolver los hallazgos
P0 y P1 siguientes.

## Hallazgos

### P0 — El servidor local permite ejecutar comandos desde cualquier origen web

**Evidencia:** `scripts/mcp_server.py:184-231` ejecuta `command` con
`shell=True`; `scripts/mcp_server.py:428-432` responde con CORS `*`, permite
cabeceras `*` y habilita `Access-Control-Allow-Private-Network: true`; las rutas
`tools/call` y `zerochat/external/*` no autentican ni comprueban el origen
(`scripts/mcp_server.py:490-597`). Además, `--host` permite sustituir el valor
loopback por cualquier interfaz (`scripts/mcp_server.py:622`).

**Impacto:** una página que alcance el puerto local, o cualquier cliente de la
red si el usuario cambia el host, puede invocar `execute_command`, leer/escribir
archivos y arrancar instaladores. La autorización de herramientas de la UI no es
un control de seguridad del servidor.

**Corrección propuesta:** limitar el listener a loopback salvo una opción
explícita y segura; generar un secreto aleatorio por instalación y exigirlo en
cada petición; restringir CORS a un origen configurado y no enviar PNA
permisivo. El servidor debe rechazar llamadas mutables sin ese secreto incluso
si proceden de localhost. Añadir pruebas HTTP para origen, secreto ausente o
incorrecto, acceso no-loopback y rechazo de `tools/call`.

### P0 — La cadena de actualización descarga y ejecuta código sin autenticación

**Evidencia:** el primer `bootstrap.py` se descarga y se ejecuta directamente
desde GitHub Pages (`scripts/mcp_server.py:319-352`). Después se descarga
`release.json` y se aceptan las sumas SHA-256 que el propio manifiesto remoto
declara (`scripts/mcp/bootstrap/bootstrap.py:35-48`). El constructor de la
release solo genera hashes, no firma el manifiesto
(`scripts/mcp/release/build_release.py:12-25`). HTTPS protege el transporte,
pero no autentica una publicación comprometida.

**Impacto:** quien altere el contenido publicado puede reemplazar el bootstrap,
el runtime o la descripción de lanzamiento, y conseguir ejecución local al
pulsar el arranque de MCP externos.

**Corrección propuesta:** incluir en el servidor local una clave pública de
edición o un hash raíz inmutable por canal. Publicar un manifiesto firmado con
identificador de release y verificar su firma antes de escribir o ejecutar el
bootstrap y antes de copiar la release activa. Rechazar downgrade y releases no
firmadas. Probar firmas válidas, manifiestos o artefactos alterados, rutas
peligrosas y rollback.

### P1 — La instalación de productos no es reproducible ni generalizable

**Evidencia:** el host usa `npm install` a partir de un `package.json` creado en
tiempo de ejecución (`scripts/mcp/runtime/zmcp_host.py:205-226`), sin
lockfile ni integridad de dependencias transitivas. La instalación del navegador
supone además que todos los servicios tienen un instalador de navegador concreto
(`scripts/mcp/runtime/zmcp_host.py:221-225`), aunque el formato pretende
describir servidores genéricos por directorio. Solo existe un producto concreto
como ejemplo.

**Impacto:** la misma versión declarada puede instalar dependencias transitivas
distintas; un segundo servicio npm no puede expresar su instalador
sin cambiar código del host.

**Corrección propuesta:** publicar por servicio un lockfile con integridades y
usar `npm ci`; incluir la instalación de recursos como una lista declarativa
validada (ejecutable, argumentos, checksum y límites), sin nombres internos de
un producto concreto. Añadir un servicio ficticio sin navegador a la suite para
demostrar que el runtime no depende de un producto específico.

### P1 — Los nombres externos no cumplen la nomenclatura simplificada y pueden colisionar

**Evidencia:** el host descarga herramientas como
`mcp__{server_id}__{original}` (`scripts/mcp/runtime/zmcp_host.py:266-285`).
Al registrarlas, el cliente les antepone `mcp_`, por lo que se obtienen nombres
como `mcp_mcp__<servicio>__...` (`js/mcp.js:685-690`). Siguen existiendo reglas y
tests que aceptan el patrón antiguo `mcp__` (`js/tool-security.js:568-569`,
`tests/integration/test_mcp.js:83`).

**Impacto:** no se materializa la nomenclatura solicitada `zmcp_<herramienta>` y
`mcp_<herramienta>`; el identificador público contiene el prefijo doble y la
normalización actual no protege de dos servicios que publiquen el mismo nombre.

**Corrección propuesta:** definir un único contrato de nombres y aplicarlo en el
host, proveedor, seguridad, persistencia y pruebas. Para mantener unicidad,
usar un identificador legible que incluya el servicio, por ejemplo
`mcp_<servicio>_browser_navigate`, y conservar alias antiguos solo durante una
migración de permisos. Añadir pruebas de extremo a extremo con dos servicios y
dos herramientas homónimas.

### P1 — No hay una publicación reproducible de la release usada por producción

**Evidencia:** producción apunta a
`https://albalday.github.io/zerochat/mcp/releases/stable`
(`scripts/mcp_server.py:29`), pero el árbol versionado solo contiene el
constructor `scripts/mcp/release/build_release.py`; `dist/` está ignorado y no
hay script npm ni flujo de publicación que construya y despliegue `stable`.

**Impacto:** el bundle puede distribuir una URL sin que el repositorio permita
reconstruir ni verificar el contenido que servirá esa URL.

**Corrección propuesta:** añadir un workflow de publicación que construya una
release con ID inmutable, la firme, publique un canal estable que apunte a ella
y pruebe desde un directorio limpio la descarga y verificación. Documentar la
retención y el rollback.

### P2 — Operaciones largas bloquean el canal de control y no se pueden cancelar

**Evidencia:** `start` procesa instalación y descarga de navegador de forma
síncrona, con límites de 600 y 900 segundos
(`scripts/mcp/runtime/zmcp_host.py:197-256`). El bucle de control procesa
una solicitud cada vez (`scripts/mcp/runtime/zmcp_host.py:303-323`), por
lo que durante una instalación no puede atender `stop` ni `status`. El puente
del servidor también espera la respuesta (`scripts/mcp_server.py:378-397`).

**Impacto:** un arranque lento deja la interfaz sin estado fiable y no permite
detener el producto hasta agotar el proceso o el timeout.

**Corrección propuesta:** ejecutar instalaciones como trabajos con ID, estado y
cancelación; conservar el proceso hijo para terminarlo de forma ordenada;
devolver progreso acotado y hacer que `stop` cancele el trabajo pendiente.
Probar cancelación durante `npm`, timeout y recuperación tras terminar el host.

### P2 — Cobertura insuficiente de la ruta MCP que se publica

**Evidencia:** la prueba de infraestructura solo comprueba que el host lista
un servicio concreto antes de iniciar un producto (`tests/infrastructure/test_local_server.js:38-60`).
No prueba el arranque de un servicio stdio, el enrutado de `tools/call`, el
formato final del identificador, la instalación genérica, ni los rechazos de
seguridad. La antigua prueba dedicada al cliente stdio fue eliminada con la
reestructuración. La nueva `tests/fixtures/dummy_mcp_server.py` no se usa en esa
ruta.

**Corrección propuesta:** usar `dummy_mcp_server.py` como servicio de release
local en pruebas: arrancar, listar, ejecutar, detener y comprobar limpieza al
desconectar ZMCP. Separar esas pruebas de las que requieren npm y navegador para
que sean deterministas y sin red.

### P3 — Formato y documentación a alinear

**Evidencia:** `git diff --check 0704c8e..HEAD` informa espacios finales en
`tests/browser/browser_conversation.test.js:78,219`, línea vacía final en
`tests/fixtures/dummy_mcp_server.py:81` y
`tests/integration/test_ingestion_duplicates.js:173`. Las claves
`mcp_connection_desc` y `mcp_servers_desc` siguen en ambos idiomas aunque su
texto ya no se muestra (`js/i18n.js:348,421,1001,1074`). La ayuda MCP describe
el modelo anterior y no explica la descarga bajo demanda, el host externo ni la
cadena de confianza (`help/mcp.html`, `help/en/mcp.html`).

**Corrección propuesta:** corregir el whitespace, retirar las claves sin uso y
actualizar las dos páginas de ayuda cuando se resuelvan los controles de
seguridad anteriores.

## Validación realizada

| Comprobación | Resultado |
| --- | --- |
| `npm run test:unit` | Correcta: 33/33. |
| `npm run test:integration` | 31/32; `test_temporal_context.js` no puede crear un proceso hijo en este sandbox. |
| `npm run test:browser` | 0/9 en este sandbox: las nueve necesitan proceso/navegador. |
| `npm test` | 68/80; las 12 fallidas corresponden a navegador, bundle, servidor local y proceso hijo, bloqueados por el sandbox. |
| `npm run build` | Correcta; regeneró `zerochat.html` (canal DEV). |
| `git diff --check` | Cuatro incidencias P3 descritas arriba. |

La limitación del sandbox impide certificar las pruebas que abren sockets o
procesos. Deben repetirse en CI o en una máquina sin esa restricción antes de
promover a `master`.

## Orden recomendado de implantación

1. Cerrar P0 de autenticación local y cadena de firmas; añadir sus pruebas
   negativas antes de permitir descargas de producción.
2. Definir el contrato de releases, publicación y lockfiles; volver genérico el
   instalador de servicios.
3. Corregir la nomenclatura MCP y migrar las autorizaciones persistidas.
4. Añadir el fixture stdio de extremo a extremo y trabajos cancelables.
5. Corregir P3, actualizar ayuda bilingüe y ejecutar toda la matriz fuera del
   sandbox.
