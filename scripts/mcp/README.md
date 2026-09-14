# MCP externo descargable: plan de implantación

Estado: diseño y descripciones de ejemplo; no hay un bootstrap ni un gestor ejecutables implementados en este directorio. No se han instalado productos ni arrancado procesos. Estos archivos no se deben incorporar a `zerochat.html`.

## 1. Resultado requerido

Separar las herramientas locales de `zerochat_mcp.py` de los servidores MCP externos. El servidor local puede funcionar por sí solo. La parte externa permanece detenida hasta que el usuario pulsa **Arrancar servicios MCP externos**.

Ese clic llama al servidor local, que obtiene y ejecuta un bootstrap descargable. El bootstrap crea o reutiliza el entorno Python del gestor en `~/.zerochat/mcp/env`. El gestor obtiene catálogo, descripciones de instalación y productos, arranca los servidores habilitados y comunica sus estados y herramientas a ZeroChat.

`~` representa el directorio del usuario que ejecuta el servidor Python, aunque el navegador esté en un móvil u otro equipo. No se usan el directorio actual del proceso ni el almacenamiento del navegador como raíz de instalación.

El bundle solo contiene presentación genérica, llamadas al servidor local, cliente MCP genérico y, mientras se mantenga su descarga generada actual, el servidor local mínimo. No contiene bootstrap, gestor externo, cliente stdio Python, catálogo, recetas de instalación, paquetes ni definiciones de herramientas de productos externos.

## 2. Punto de partida observado

La copia de trabajo ya contiene cambios en curso de la implementación MCP. Antes de ejecutar este plan, volver a revisar `git status`, `AGENTS.md` y las versiones actuales. Preservar esos cambios; no reemplazar archivos completos con versiones antiguas.

- `scripts/mcp_server.py` importa `McpProcessManager`, declara `DEFAULT_MCP_SERVERS`, gestiona `/mcp/start`, `/mcp/stop`, `/mcp/register` y agrega herramientas externas a `tools/list`.
- `scripts/mcp_client.py` implementa cliente stdio y supervisor. Aprovechar esa lógica después de revisar negociación, cancelación, lectura de stderr y limpieza de procesos.
- `js/ui-mcp.js` contiene Python incrustado dentro del generador de `zerochat_mcp.py`, incluido código externo que debe salir del bundle.
- `js/mcp.js` consulta servidores y vuelve a registrar el proveedor combinado al arrancarlos.
- Los tests ya están distribuidos en `tests/unit`, `tests/integration`, `tests/browser` e `infrastructure`, con `scripts/test-runner.mjs`.
- La definición actual de Playwright usa `@modelcontextprotocol/server-playwright`; sustituirla por el producto oficial `@playwright/mcp` en el catálogo externo.

No hacer una refactorización general de MCP ni modificar herramientas locales fuera de lo necesario para separar proveedores y proteger el nuevo arranque.

## 3. Responsabilidades y comunicaciones

```text
ZeroChat (bundle)
  ├─ proveedor local ───────────────► zerochat_mcp.py: herramientas locales
  ├─ control externo genérico ─────► lanzador mínimo de zerochat_mcp.py
  │                                   │ descarga/copia y ejecuta
  │                                   ▼
  │                               bootstrap.py descargado
  │                                   │ prepara env y ejecuta
  │                                   ▼
  └─ proveedor MCP externo ────────► gestor descargado (mediante el puente local)
                                      ├─ catálogo JSON + recetas JSON
                                      ├─ instalación privada de productos
                                      └─ cliente stdio → procesos MCP oficiales
```

### Servidor local mínimo

Mantiene mini servicios, HTTP y un lanzador genérico. Para externos solo sabe: obtener una release compatible de una fuente configurada, verificar/copiar archivos del bootstrap, ejecutarlo, comprobar su vida y retransmitir solicitudes/respuestas. No interpreta paquetes npm, productos, listas de servidores ni procedimientos de instalación.

El relay externo usa pipes privados stdin/stdout con mensajes JSON por línea y correlación de solicitudes. No importa el gestor en el proceso HTTP ni necesita abrir otro puerto de red. Tiene límites de tamaño, espera y fallo del hijo. El protocolo de control privado es de ZeroChat y se versiona por separado de MCP.

### Bootstrap descargado

Funciona inicialmente con Python estándar. Crea/reutiliza el venv, instala el gestor de la release verificada y lo ejecuta con el intérprete del venv. Conserva el canal de pipes al hacer el relevo. No instala todos los productos dentro del venv: los productos Node tienen directorios independientes.

### Gestor descargado

Es propietario del catálogo, registros locales, instalación, caché, procesos, clientes stdio, descubrimiento MCP, enrutamiento y logs externos. Todo cambio en soporte de productos ocurre aquí o en los JSON distribuidos, sin recompilar el bundle ni cambiar el servidor local mínimo.

### UI

Solo interpreta estados y acciones genéricos. No incluye ramas como `if (server.id === 'playwright')`, comandos de instalación, catálogos por defecto ni schemas de herramientas escritos a mano. Las herramientas proceden de `tools/list` del servidor real.

## 4. Árbol de código y publicación

Directorio elegido: `scripts/mcp/`. No crear un segundo directorio `scripts7mcp`.

```text
scripts/
  mcp_server.py                  # fuente del servidor local mínimo existente
  mcp/
    README.md                    # este plan
    bootstrap/
      README.md                  # contrato del bootstrap
      bootstrap.py               # por implementar; nunca en el bundle
    runtime/
      README.md                  # responsabilidades del paquete
      pyproject.toml             # por implementar
      zerochat_mcp_host/
        __main__.py              # entrada y canal privado
        catalog.py               # lectura/validación del catálogo
        installer.py             # pasos declarativos y runtime de productos
        manager.py               # estados, jobs y ciclo de procesos
        stdio_client.py          # adaptar scripts/mcp_client.py
        router.py                # descubrimiento, identidad y llamadas
    catalog/
      index.json
      servers/playwright.json
      installers/playwright.json
      docs/playwright.es.md
      docs/playwright.en.md
    schemas/
      README.md                  # schemas que debe implementar la fase 1
      catalog.schema.json        # por implementar
      server.schema.json         # por implementar
      installer.schema.json      # por implementar
      release.schema.json        # por implementar
    release/
      README.md                  # publicación reproducible y locks
      build_release.py           # por implementar; independiente de bundle.py
```

Solo están creados los documentos y JSON de diseño. Los `.py`, `pyproject.toml` y schemas del árbol marcados «por implementar» no son stubs ejecutables.

Publicación propuesta: `https://albalday.github.io/zerochat/mcp/`. Se deriva del remoto del proyecto y su sitio de ayuda; esa ruta MCP todavía debe publicarse y verificarse. Usar HTTPS para descargar ejecutables; no HTTP en claro.

```text
mcp/
  channels/stable.json
  releases/<release-id>/
    release.json
    bootstrap.py
    runtime/zerochat_mcp_host-<version>-py3-none-any.whl
    runtime/requirements.lock
    catalog/...                 # mismas rutas relativas del catálogo
    locks/playwright/...        # package.json, package-lock.json, runtime lock
```

`release.json` enumera archivos, tamaños, SHA-256, versiones de contrato e intérprete y artefactos por plataforma. El publicador genera hashes reales. Las releases son inmutables; publicar todos los artefactos antes de cambiar `channels/stable.json`. La publicación no forma parte de este encargo de diseño y tampoco de la excepción de documentación exclusiva de `/help`.

No modificar `bundle.py` para incluir `scripts/mcp/`. Añadir una comprobación que impida incorporar estas rutas o sus contenidos al runtime generado. Si se automatiza la generación del servidor local descargable, hacerlo desde una única fuente local mínima; no volver a copiar a JS el cliente stdio o el catálogo.

## 5. Disco local y fuentes

```text
~/.zerochat/mcp/
  env/                           # venv Python del gestor
  releases/<release-id>/         # bootstrap, wheel, catálogo y locks verificados
  active-release.json            # referencia a la release activa
  runtimes/node/<version>/       # Node/npm privado si no hay uno compatible
  services/playwright/<install-id>/
    package.json
    package-lock.json
    node_modules/
    installation.json            # versión, integridad y pasos completados
  browsers/playwright/<install-id>/
  config/services.json            # enabled y opciones del usuario
  run/                            # lock del host e información de instancia
  logs/                           # rotación, sin credenciales
  staging/                        # descargas/inicios de instalación incompletos
```

Dos proveedores de archivos con idéntico contrato:

1. `github-pages`: raíz HTTPS fijada en configuración del servidor local; descarga releases y artefactos permitidos. La UI no puede cambiar esta raíz ni enviar URLs ejecutables.
2. `local-copy`: flag explícito del servidor local, por ejemplo `--mcp-source local-copy --mcp-source-root /home/alberto/vs/zerochat/scripts/mcp`. Copia bootstrap, gestor empaquetado, definiciones y locks desde ese árbol a `~/.zerochat/mcp`. La fase de desarrollo debe generar una release de prueba en `scripts/mcp/release/dist/`, que no se versiona. No ejecutar directamente código desde el checkout después de copiarlo.

El modo local sustituye las descargas de artefactos de ZeroChat, no las de npm ni las del navegador. Para probar completamente sin red, preparar antes la caché de productos. No usar el modo local como fallback silencioso de producción.

Con caché verificada y compatible, el arranque reutiliza la instalación sin consultar GitHub ni actualizar productos. «Actualizar catálogo» es una acción independiente; una release nueva no sustituye procesos activos durante una conversación.

## 6. Arranque, parada y disponibilidad

1. Arrancar `zerochat_mcp.py`: solo herramientas locales; host externo en `stopped`. No crear venv, descargar, ejecutar Node ni leer un catálogo remoto.
2. Conectar ZeroChat: consultar estado local y del lanzador; no iniciar nada como efecto secundario de un GET, `initialize`, `tools/list` o apertura del modal.
3. Pulsar **Arrancar servicios MCP externos**: solicitud de usuario al plano de control, con clave de idempotencia.
4. El lanzador adquiere un lock, reutiliza release verificada o obtiene manifiesto/bootstrap y devuelve un job inmediatamente.
5. Bootstrap prepara el venv si falta y ejecuta el gestor. Si falta el módulo `venv` o hay incompatibilidad de Python, devuelve un error concreto; no instala paquetes del sistema con sudo.
6. Gestor carga todas las definiciones del catálogo. Instala/arranca cada servicio habilitado, con concurrencia acotada (inicialmente uno). En el ejemplo Playwright tiene `enabledByDefault: true`; el clic global lo incluye. No instalar productos de servicios deshabilitados. Las preferencias explícitas del usuario prevalecen sobre el catálogo.
7. Cada proceso debe completar `initialize`, `notifications/initialized` y `tools/list` antes de declararse `running`. La existencia del PID no basta.
8. Un fallo individual deja el host operativo y ese servicio en `error` o `needs-attention`; no derriba las herramientas locales ni impide listar los demás.
9. El gestor devuelve descripción, estado, progreso, error saneado y herramientas descubiertas. ZeroChat actualiza el proveedor externo y mantiene aparte el local.
10. **Detener externos** cancela instalaciones pendientes y termina procesos e hijos que pertenecen al gestor. Conserva caché y preferencias. La parada de un servicio retira solo sus herramientas.
11. Un nuevo clic de arranque reutiliza descargas e instalaciones. Los dobles clics/tabs simultáneos no crean hosts ni procesos duplicados.
12. Salir del servidor local termina el host y sus hijos. Cerrar o recargar una pestaña no debe detener un servicio usado por otra pestaña. Abrir de nuevo la UI no implica volver a arrancarlo.

La cancelación del job debe llegar al servidor. Cancelar únicamente el `fetch` no detiene la descarga o proceso. Un fallo del pipe invalida jobs pendientes y limpia descendientes conocidos; al recuperar, comprobar identidad de instancia y no matar un proceso por un PID antiguo reutilizado.

Estados del host: `stopped`, `fetching`, `preparing`, `starting`, `running`, `stopping`, `error`. Estados de servicio: `available`, `installing`, `starting`, `running`, `stopped`, `needs-attention`, `error`. `installed` es un atributo separado de la disponibilidad.

## 7. Contratos de API propuestos

Métodos JSON-RPC privados de ZeroChat sobre el servidor local; no son métodos estándar MCP ni herramientas invocables por el modelo:

| Método | Entrada | Resultado |
|---|---|---|
| `zerochat/external/status` | ninguna | versión de contrato, estado host y job actual |
| `zerochat/external/start` | `requestId` | `jobId`, estado; idempotente |
| `zerochat/external/stop` | `requestId` | job de parada |
| `zerochat/external/jobs/get` | `jobId` | fase, progreso, errores saneados |
| `zerochat/external/jobs/cancel` | `jobId` | cancelación solicitada/completada |
| `zerochat/external/servers/list` | ninguna | catálogo dispuesto, sin iniciar productos |
| `zerochat/external/servers/start` | `serverId`, `requestId` | job; requiere host activo |
| `zerochat/external/servers/stop` | `serverId`, `requestId` | job de parada individual |
| `zerochat/external/servers/configure` | `serverId`, `enabled`, opciones tipadas | configuración validada por el gestor |
| `zerochat/external/catalog/refresh` | `requestId` | job; requiere host activo y acción explícita |

Si el host está detenido, `servers/list` puede responder `host-stopped`, sin catálogo; la UI indica que debe arrancarse para descubrirlo. No inventa un catálogo local en JS. El lanzador responde a status/start/stop y retransmite genéricamente los demás métodos; los contratos de productos solo existen en el gestor.

Para herramientas, conservar el endpoint MCP local actual y añadir `/mcp/external` como puente separado al gestor. Este endpoint soporta `initialize`, notificación de inicialización, `tools/list` y `tools/call` mediante JSON-RPC HTTP. Si se negocia streaming o notificación `listChanged`, implementarlos realmente; en la primera versión se puede usar respuesta JSON y refresco explícito tras jobs, sin anunciar capacidades no implementadas.

Ejemplo de información de servicio (no esquema de herramienta):

```json
{
  "id": "playwright",
  "displayName": {"es": "Playwright MCP", "en": "Playwright MCP"},
  "status": "running",
  "installed": true,
  "transport": "stdio",
  "toolCount": 12,
  "toolsRevision": "instance-7:2",
  "error": null
}
```

`toolCount` es ilustrativo: calcularlo con las herramientas reales, nunca fijarlo. Los nombres, descripciones y `inputSchema` se obtienen de MCP, no del JSON de instalación.

Mantener una tabla de identidad `{providerId, serverId, originalToolName}`. Usar un namespace estable como `mcp__playwright__browser_navigate` una sola vez; revisar el prefijado actual en `js/mcp.js` para evitar duplicarlo. No resolver colisiones por «primer servidor que tenga ese nombre». No transferir permisos previos basándose solo en el nombre o descripción de una herramienta.

## 8. JSON y recetas

Los ejemplos están en `catalog/`. Son contratos de ZeroChat propuestos, no un formato estándar MCP. Implementar schemas y validadores antes de consumirlos.

- Índice: versión, IDs y rutas relativas de definiciones.
- Servidor: identidad, textos es/en, receta referenciada, estado habilitado por defecto, transporte y argumentos tipados.
- Instalador: origen oficial, paquete, estrategia de versión/lock, requisitos, pasos declarativos, comprobaciones y límites.
- Lock de release: versiones exactas, integridad de paquetes, dependencias transitivas, runtime Node por plataforma y rutas de artefactos verificadas.

No guardar contraseñas en los JSON publicados. Los secretos son referencias a variables o almacenamiento local del servidor y no se devuelven a la UI. No aceptar scripts shell arbitrarios, `eval` ni interpolación de cadenas. Los ejecutores reciben listas de argumentos con `shell=False` y expanden solo variables registradas (`serviceDir`, `nodeExecutable`, `browsersDir`, etc.).

Cada tipo de paso lo implementa código descargado del gestor; el servidor local y el bundle no conocen esos tipos. Los cambios en instaladores no deben requerir cambios de cliente. Soporte inicial: `ensure-node`, `npm-ci`, `playwright-install-browser`, `verify-executable`; futuros productos pueden añadir ejecutores al paquete descargable.

## 9. Ejemplo oficial Playwright

Producto: Microsoft Playwright MCP, paquete npm `@playwright/mcp`, transporte stdio. Requiere Node.js; el venv Python por sí solo no puede ejecutarlo. La documentación oficial usa `npx @playwright/mcp@latest`; para este gestor, resolver una versión publicada al preparar la release y ejecutar después la instalación local bloqueada. No usar `npx ...@latest` en cada arranque. Fuente: https://github.com/microsoft/playwright-mcp

La ficha adjunta usa `--headless`, `--isolated` y `--browser chromium`. Las opciones se verifican con el producto seleccionado al publicar. `--isolated` evita reutilizar un perfil personal, pero el host todavía debe aislar las sesiones de consumidores: asignar una instancia MCP/contexto independiente por sesión lógica de ZeroChat y liberar la anterior al cambiar conversación. No compartir historial del navegador entre conversaciones sin una decisión explícita.

Instalación:

1. El publicador resuelve el paquete oficial y produce `package.json` y `package-lock.json`; nunca deducir una versión publicable del `main` de GitHub.
2. Gestor usa Node compatible del sistema si existe; en caso contrario descarga un runtime portable oficial fijado en el lock de plataforma dentro de `runtimes/node`. No modificar PATH global ni instalar npm globalmente.
3. Ejecuta `npm ci` en la instalación privada con el lock de esa release. El catálogo identifica el producto y los hooks de instalación autorizados; no habilitar scripts arbitrarios enviados desde el navegador.
4. Usa el CLI Playwright de esa instalación para obtener Chromium, con `PLAYWRIGHT_BROWSERS_PATH` dentro de `browsers/playwright/<install-id>` y la misma variable al arrancar. No usar el Playwright de `node_modules` del proyecto ZeroChat.
5. Arranca `node <serviceDir>/node_modules/@playwright/mcp/cli.js --headless --isolated --browser chromium` y negocia MCP por stdio.
6. Las librerías nativas del sistema que necesite Chromium no se resuelven con un venv. Si faltan, devolver `needs-attention` con instrucciones del producto; no usar sudo ni deshabilitar el sandbox automáticamente.

Los JSON incluidos dejan la versión como resolución de publicación deliberadamente. No se ha verificado una versión npm publicada ni generado su lock; el publicador debe rechazarlos como release desplegable hasta producir locks e integridades. Así se evita presentar hashes inventados o una rama de desarrollo como producto probado.

Fuentes oficiales adicionales: https://github.com/microsoft/playwright-mcp/blob/main/package.json y https://github.com/microsoft/playwright-mcp#configuration .

## 10. Seguridad y fiabilidad mínimas

- Arranque/instalación son acciones de control del usuario; nunca exponerlos como tools al modelo ni derivarlos de documentos o respuestas de herramientas.
- El servidor local debe autenticar los métodos administrativos con un token de emparejamiento, restringir Host/Origin y mantener loopback por defecto. Reutilizar un mecanismo existente si ya lo hay. Para `file://`, `Origin: null` no basta como autorización: exigir token. El CORS `*` actual no protege frente a webs que intenten ejecutar servicios locales.
- El token del navegador se configura por el flujo de conexión y no se publica en URLs, logs o catálogos. El canal padre/hijo usa pipes privados; no hay token externo por cada herramienta.
- Fijar origen de releases desde la CLI/configuración local; verificar HTTPS, redirecciones, tamaños, hashes y compatibilidad antes de ejecutar. Un hash distribuido junto al archivo detecta corrupción; la autenticidad depende del origen HTTPS autorizado. No afirmar que equivale a firma criptográfica independiente.
- Rechazar rutas absolutas, `..`, enlaces que escapen de staging, IDs inválidos, entradas JSON sobredimensionadas, versiones de schema desconocidas y archivos fuera de la lista de release.
- Descarga temporal, verificación y activación atómica del manifiesto. Conservar la última release válida. No sobrescribir procesos en ejecución. Un venv no es portable entre rutas: crearlo en su destino final; si hay que reconstruirlo, detener el gestor y conservar una referencia recuperable a la release previa.
- Límites iniciales: peticiones de control 64 KiB; catálogo 2 MiB; JSON de servicio 256 KiB; bootstrap 2 MiB; mensajes de herramientas 16 MiB; manifiesto fija tamaño de artefactos grandes. Descargas con timeout de conexión/lectura y deadline total por job; instalación de navegador hasta 15 minutos, handshake MCP 30 segundos, llamadas según timeout vigente del cliente.
- Drenar stdout y stderr para evitar bloqueos; stdout del servidor MCP solo es protocolo. Rotar logs y ocultar secretos. Preservar contenido MCP válido (texto, imágenes, errores) sin ejecutar HTML recibido.
- Registro incremental de herramientas externas: no reemplazar el proveedor local ni recrear todos los paneles durante streaming. Capturar una revisión estable para la inferencia en curso; si se detiene una herramienta, su llamada devuelve un error identificable, no se redirige a otra con igual nombre.
- Las opciones `enabled` y cachés pertenecen al gestor en disco. El estado visible en JS va por mutadores de `ChatState`, preferiblemente `ui.mcpExternal` para presentación y `config` para preferencias de conexión. Respetar las fachadas ya existentes y no añadir un slice global paralelo.

## 11. Fases de ejecución para el modelo implementador

### Fase 1 — contratos y pruebas de arquitectura

Leer instrucciones, revisar cambios en curso y registrar baseline de tests relevantes. Definir schemas JSON, protocolo privado, errores tipados y contratos de estados. Validar los ejemplos existentes. Añadir pruebas que detecten Python externo, catálogos y recetas dentro del código JS concatenado/descomprimido del bundle (buscar solo en Base64 no basta). No prohibir menciones genéricas a Playwright en herramientas locales o dependencias de tests.

Salida: esquemas válidos, identidad de proveedores decidida y pruebas de separación preparadas.

### Fase 2 — runtime externo sin descargas reales

Mover/adaptar el cliente stdio y supervisor al paquete descargable. Implementar canal privado, jobs, cancelación, gestión de hijos, discovery y router. Probar con `tests/fixtures/dummy_mcp_server.py`, incluyendo stdout roto, stderr lleno, timeout y caída. Separar claramente «instalado» de «running». No copiar el código de vuelta a JS.

Salida: host ejecutable con fixture, sin catálogo ni código externo en el servidor mínimo.

### Fase 3 — bootstrap, caché y copia local

Implementar bootstrap estándar, preparación del venv y publicador de release local. Incorporar el proveedor de copia desde `/home/alberto/vs/zerochat/scripts/mcp`. Probar en raíz temporal configurable (`--mcp-home`), nunca en el home real durante tests automáticos. Verificar arranque por segunda vez sin reinstalar, lock concurrente, cancelación y recuperación tras archivos incompletos.

Salida: arranque extremo a extremo del fixture a través del servidor local, totalmente offline.

### Fase 4 — separación del servidor y bundle

Retirar `DEFAULT_MCP_SERVERS`, importaciones del gestor y lógica de instalación de `scripts/mcp_server.py` y de su Python generado en `js/ui-mcp.js`. Mantener funciones locales y añadir solo loader/relay. Separar `/mcp/external` del proveedor local. Mantener métodos antiguos como adaptadores temporales si hacen falta, rechazando configuraciones arbitrarias con `command`/`args` desde la UI. Migrar preferencias previas sin ejecutarlas automáticamente ni transferir permisos por nombre.

Salida: servidor local usable sin bootstrap instalado; bundle libre de implementaciones externas.

### Fase 5 — fuente HTTPS y publicación reproducible

Implementar resolución de canal, descarga/verificación, locks, staging y rollback. Probar con servidor HTTP local de fixtures en tests; producción exige HTTPS. Probar 404, cortes, integridad incorrecta, release incompatible y ausencia de red con caché. Preparar artefactos de Pages en directorio de salida, sin publicar aún.

Salida: release completa que puede copiarse al sitio del proyecto de forma independiente del bundle.

### Fase 6 — UI genérica

Dos secciones: **Herramientas locales de ZeroChat** y **Servidores MCP externos**. Botón de arranque manual, progreso, cancelación, parada global y acciones por servidor. Estado detenido por defecto, sin consultas que instalen. Las filas se crean exclusivamente con información del host. Descripciones es/en del catálogo se muestran como texto seguro; UI estática mediante `ChatI18n`. Iconos del catálogo `ChatIcons`, sin HTML/SVG remoto inyectado. Polling solo mientras el panel está abierto o hay un job, con refresco al completar; sin render masivo por token SSE.

Salida: recorrido de usuario completo, errores legibles y controles accesibles en móvil.

### Fase 7 — Playwright real

Publicar una release de prueba con lock npm exacto y runtime de plataforma. Ejecutar instalación real solo en prueba explícita de aceptación, separada de `npm test`. Primero usar fuente local para artefactos ZeroChat y luego repetir con el sitio HTTPS de staging. El gestor obtiene software oficial; no usar mocks para declarar que Playwright funciona.

Salida: evidencia de instalación, handshake, herramientas publicadas y llamada real a través de ZeroChat.

### Fase 8 — cierre

Actualizar `docs/TOOLS.md`, `docs/TESTING.md` y `/help/mcp.html` con su versión inglesa. Ajustar grupos del runner existentes en lugar de introducir otro runner. Ejecutar unitarios/integración/infraestructura aplicables, `npm run build`, `npm run test:browser`, `npm test` y el build final requerido por `AGENTS.md`. Revisar `zerochat.html`. Promoción a master solo con incremento previo de versión en dev y validaciones exigidas; no promover automáticamente.

## 12. Matriz de aceptación

| Escenario | Resultado obligatorio |
|---|---|
| Servidor local recién iniciado | mini herramientas disponibles, cero procesos/descargas externos |
| Abrir el panel o conectar UI | no inicia ni instala externos |
| Primer clic con fuente local | copia desde checkout, crea env y lanza host |
| Primer clic con fuente HTTPS | descarga bootstrap/host/catálogo verificados |
| Segundo clic/segundo arranque | reutiliza artefactos, no duplica procesos |
| Repetición sin red y caché íntegra | vuelve a arrancar productos instalados |
| Nueva ficha de producto en el catálogo | aparece sin modificar bundle ni servidor mínimo |
| Servicio deshabilitado | ficha visible, software/proceso no instalado/arrancado |
| Caída o parada externa | tools externas retiradas; mini herramientas siguen funcionando |
| Fallo de paquete/navegador | error de ese servicio, host y locales operativos |
| Cancelar instalación | job cancelado, descendientes cerrados, caché válida preservada |
| Catálogo corrupto o ruta maliciosa | rechazo previo a ejecución y conservación de release anterior |
| Página no autorizada llama a start | petición rechazada |
| Dos conversaciones usan navegador | no comparten sesión de navegación implícitamente |
| Borrar o manipular un PID guardado | nunca termina procesos ajenos |

Prueba real de Playwright:

1. Home temporal vacío y fixture web local con título conocido y botón que modifica texto.
2. Conectar ZeroChat al servidor local; comprobar que aún no hay tools de Playwright.
3. Pulsar arranque externo y observar fases de descarga/instalación/negociación.
4. Comprobar herramientas descubiertas como `browser_navigate`; no fijar el número total ni inventar su schema.
5. Usar el schema publicado para navegar a la fixture y accionar el botón mediante una llamada autorizada desde ZeroChat; verificar el texto resultante.
6. Detener Playwright y comprobar retirada de sus tools, cancelación y continuidad de las locales.
7. Repetir offline usando la misma caché y la página local. Registrar versiones y resultado; no afirmar que se ha probado antes de ejecutar esta fase.

## 13. Entrega final de la implementación

Código fuente del servidor mínimo y runtime descargable separados, schemas, catálogo con Playwright, release reproducible con locks/hashes, tests offline y prueba real explícita, documentación es/en y bundle actualizado. Informar qué está publicado y qué solo está preparado en local. No confundir una instalación exitosa con disponibilidad MCP: esta exige discovery y llamada funcional.
