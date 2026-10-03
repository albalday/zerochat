# Plan de corrección de T01 y T02 — permisos de herramientas locales

Fecha: 3 de octubre de 2026. Basado en la auditoría **8.10.1** del 2 de octubre de 2026 (informe técnico cerrado en [`informe-calidad-codigo-infraestructura.html`](../../help/informes/informe-calidad-codigo-infraestructura.html), enlazado desde [`help/architecture.html`](../../help/architecture.html)). Rama: `dev`.

Estado: análisis y plan de corrección de los hallazgos **T01** y **T02** (gravedad alta, prioridad P1, reproducidos). Este documento no modifica ni corrige el producto; describe cómo abordarlos, su coste y su beneficio.

Actualización (3 de octubre de 2026): ejecutada la corrección solo en frontend; el backend no se modifica por decisión de diseño (solo ejecuta llamadas con una autorización firmada y de un solo uso emitida por el frontend).

- T01: `~`, `~usuario` y variables no se resuelven ni encajan con reglas de carpeta (`normalizeDirectoryPath`, `evaluateDirectoryRule`, `setDirectoryRules`). Con «Confiar en el espacio de trabajo», `..` se resuelve antes de comparar con `/workspace`.
- T02: el encadenamiento detecta también saltos de línea, `<(`/`>(` y redirecciones a archivos (salvo `2>&1` y `/dev/null`); sin `allowChaining`/`allowPipes: true` explícitos no se permiten. Un `cd <dir> &&` inicial ya no habilita el encadenamiento: se valida el comando siguiente y el directorio contra las reglas. «Permitir siempre» guarda `allowChaining: false` y `allowPipes: false`, la tarjeta ofrece el programa que sigue al `cd`, la fusión de autorizaciones conserva la opción más restrictiva y las autorizaciones guardadas antes de la versión 4 del almacén se migran sin encadenamiento ni tuberías.
- `cwd` de `execute_command` y el `cd` inicial deben estar cubiertos por una regla de directorio.
- «Confiar en el espacio de trabajo» con comandos pasa de lista de bloqueo a lista de comandos simples permitidos (sin encadenar, redirigir, rutas absolutas, `~`, variables ni `..`; tuberías solo hacia filtros de texto).
- Límites aceptados para uso personal: enlaces simbólicos salientes (no resolubles en el navegador), opciones del propio programa autorizado (`git -c`, alias) y el directorio persistente de la herramienta `bash` tras un `cd` aprobado manualmente.

## 1. Contexto

T01 y T02 ocupan el **orden 1** del plan de consolidación del informe técnico. Son el riesgo central del producto: el sistema de permisos de herramientas locales no aplica los límites que la interfaz promete, convirtiendo una decisión prudente del usuario en una autorización mucho más amplia.

Los tres informes de la auditoría (técnico, funcional y comparativa) coinciden en que la ventaja diferencial de ZeroChat «solo se sostiene si los permisos son fiables; hoy no lo son».

La superficie de cambio es predominantemente frontend (`js/tool-security.js`, `js/tool-cards.js`, `js/i18n.js`), con un refuerzo opcional de backend para T01. No se trata de una reescritura, sino de cambios focalizados en el subsistema de permisos. Ya existe una base de pruebas que carga `ToolSecurityManager` en Node (`tests/integration/test_tool_security.js`), por lo que convertir las reproducciones en regresiones es económico.

## 2. T01 — Las reglas de carpetas tratan `~` como ruta relativa

**Gravedad:** alta · **Prioridad:** P1 · **Evidencia:** R (reproducido)

### Causa raíz
Frontend y backend resuelven las rutas con semánticas distintas:

- `normalizeDirectoryPath` (`js/tool-security.js:48`) considera relativa cualquier ruta que no empiece por `/`. Así `~/.ssh/id_rsa` se convierte en `<arranque>/~/.ssh/id_rsa` y encaja con la regla por defecto `R:<arranque>`.
- El backend hace `Path(path).expanduser().resolve()` en `py/dd-tools.py:79` (`read_file`), que expande `~` a la carpeta real y **lee el fichero real** del directorio personal.

### Impacto
- Con la configuración por defecto (lista vacía → `R:<arranque>`), el modelo lee **cualquier** archivo del usuario sin confirmación: claves SSH, tokens, `~/zerochat/config/token.json`, credenciales de servicios MCP.
- Con una regla `W:`/`RW:` puede escribir `~/.bashrc` y obtener **ejecución persistente**.
- La comprobación es léxica: un enlace simbólico dentro de la carpeta autorizada también lleva fuera de ella.

### Cómo corregirlo
1. **Núcleo (frontend, `js/tool-security.js`):** en `normalizeDirectoryPath` (L48) y `evaluateDirectoryRule` (L604), detectar `~`, `~usuario` y variables (`$VAR`, `${VAR}`) y **no resolverlas de forma automática**; devolver `allowed: false` (→ `ask`) en vez de encajarlas contra la regla. Es la corrección mínima que cierra la reproducción.
2. **Robusto (opcional, backend):** añadir en `py/dd-tools.py` una comprobación final de contención tras `.resolve()` contra la lista de carpetas autorizadas. Requiere pasar la lista autorizada al tool, un test de backend y ejecutar `npm run build:backend` (al tocar `py/`).
3. **Tests (criterio de cierre del informe):** `~/x`, `~usuario/x`, un symlink saliente y la ruta absoluta equivalente deben pedir confirmación con la regla por defecto.

### Coste
- Solo frontend: **pequeño–medio** (dos funciones + ~10–20 casos en `tests/integration/test_tool_security.js`).
- Con comprobación en servidor: **medio** (plumbear carpetas autorizadas + check de contención + test de backend + rebuild).

### Beneficio
Cierra el hallazgo más grave: impide la lectura de secretos y la escritura persistente fuera de la carpeta autorizada, y recupera la fiabilidad de las reglas de carpeta (`R:`/`W:`/`RW:`).

## 3. T02 — Autorizaciones de comandos más amplias de lo que indican

**Gravedad:** alta · **Prioridad:** P1 · **Evidencia:** R (reproducido)

### Causa raíz
- El botón «Permitir siempre "git *"» (`js/tool-cards.js:443`) guarda `allowedPrefixes: ["git"]`, `allowChaining: true` y `allowPipes: true`, **aunque su texto dice «solo comandos que comiencen por git»**.
- `evaluateCommandConstraint` (`js/tool-security.js:218`) compara solo el inicio de cadena: `git status; rm -rf ~/proyecto` empieza por `git ` y pasa. Al tener `allowChaining: true`, el regex que detecta `; && || $()` ni se aplica.
- La política «Confiar en el espacio de trabajo» (`js/tool-security.js:1042`) solo detecta `sudo`, algunos directorios de sistema y `../`: `rm -rf ~`, `cat ~/.ssh/id_rsa`, `cp x /home/u/.bashrc` y `curl … | sh` se **permiten**.

### Impacto
Una respuesta manipulada (página web o documento RAG) puede ejecutar **cualquier comando** con los permisos del usuario después de una autorización que parecía acotada.

### Cómo corregirlo
1. **`js/tool-cards.js:443-445`:** cambiar a `allowChaining: false` y `allowPipes: false` (o convertirlas en opciones explícitas de la interfaz). Con `allowChaining: false`, el regex ya existente (L231) bloquea `; && || $()` y las comillas invertidas.
2. **i18n (`js/i18n.js`, ES ~L467 / EN ~L1158):** reescribir el texto de «Permitir siempre» para que describa **exactamente** lo autorizado. Añadir/modificar las claves en español e inglés a la vez.
3. **`js/tool-security.js:1042` (WORKSPACE_TRUST):** ampliar la heurística (añadir `~`, `$HOME`, rutas absolutas del usuario y patrones tipo `curl … | sh`) **o** reetiquetar la política con honestidad como «lista de bloqueo heurística». El informe admite ambas; la primera da más seguridad real.
4. **Tests:** `;`, `&&`, `||`, `|`, `$()`, comillas invertidas, `~`, `$HOME` y rutas absolutas del usuario.

### Coste
**Pequeño–medio**, todo frontend. Tarjeta + i18n: trivial. Endurecer `evaluateCommandConstraint` y la heurística de WORKSPACE_TRUST: medio. +~10–15 casos de test.

### Beneficio
Cierra el segundo hallazgo grave: corta la cadena *inyección de prompt → ejecución de comandos* y hace fiables «Permitir siempre» y «Confiar en el espacio de trabajo», que el informe exige corregir antes de recomendar esas políticas o ampliar herramientas.

## 4. Valoración conjunta

- **Prioridad:** son los dos P1 del plan de consolidación y el riesgo central de la auditoría.
- **Superficie:** predominantemente frontend (`js/tool-security.js`, `js/tool-cards.js`, `js/i18n.js`), con refuerzo opcional de backend en T01. No es una reescritura.
- **Alcance bien definido:** el informe ya escribe los criterios de aceptación y los casos de prueba; la base de tests de `ToolSecurityManager` en Node existe, así que convertir las reproducciones en regresiones es barato (justo lo que pide el criterio de cierre).
- **Reglas del proyecto aplicables:** al ser cambios de seguridad, requieren tests específicos; los textos nuevos deben ir a español e inglés vía `ChatI18n`; si se toca `py/` hay que ejecutar `npm run build:backend`.

**Recomendación de orden:** T02 primero (menor coste, cierra el vector de inyección de comandos) y T01 a continuación (el núcleo frontend es pequeño; el refuerzo en servidor es opcional y más grande). Validar con `npm run test:integration` y `npm run test:unit`.

## 5. Referencias

| Punto | Ubicación |
|---|---|
| Normalización de rutas (T01) | `js/tool-security.js:48` (`normalizeDirectoryPath`) |
| Evaluación de reglas de carpeta (T01) | `js/tool-security.js:604` (`evaluateDirectoryRule`) |
| Expansión `~` en el backend (T01) | `py/dd-tools.py:79` (`read_file`) |
| Restricción de comandos (T02) | `js/tool-security.js:218` (`evaluateCommandConstraint`) |
| Coincidencia de prefijo (T02) | `js/tool-security.js:207` (`matchesCommandPrefix`) |
| Heurística WORKSPACE_TRUST (T02) | `js/tool-security.js:1042` |
| Objeto de restricciones de la tarjeta (T02) | `js/tool-cards.js:443` |
| Textos de autorización ES/EN (T02) | `js/i18n.js` |
| Base de tests de permisos | `tests/integration/test_tool_security.js` |
| Informe técnico de origen | `help/informes/informe-calidad-codigo-infraestructura.html` (T01, T02) |
