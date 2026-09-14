# Plan de reorganización de pruebas

## Objetivo

Reorganizar las pruebas de ZeroChat para alinearlas con la distribución actual de módulos JavaScript, eliminar duplicidades demostradas y permitir ejecuciones más granulares según los archivos modificados.

## Alcance y límites

- Trabajar en `/home/alberto/vs/zerochat`, sobre la rama `dev`, respetando `AGENTS.md`.
- Se autorizan cambios en pruebas, su infraestructura, scripts de ejecución y documentación relacionada.
- No cambiar el comportamiento ni las APIs de producción.
- No añadir frameworks ni dependencias: mantener `node:test` y Playwright.
- No reducir pruebas solo para disminuir su número. Eliminar únicamente repeticiones demostradas manteniendo cobertura equivalente.
- Conservar pruebas de seguridad, cancelación, errores, persistencia, aislamiento entre conversaciones y compatibilidad.
- No editar `zerochat.html` manualmente; regenerarlo con `npm run build`.
- No promover a `master`, publicar ni modificar perfiles de demostración.
- Preservar cambios preexistentes del usuario y no usar operaciones destructivas de Git.

## 1. Referencia inicial

1. Comprobar rama, estado de trabajo, instrucciones adicionales y scripts de `package.json`.
2. Verificar el inventario actual de suites. La revisión previa encontró 69 archivos `tests/test_*.js`, módulos ya extraídos con pruebas propias y una suite de navegador monolítica.
3. Ejecutar `npm test` una vez y registrar resultado, duración y fallos previos. Si un fallo es ajeno al cambio o del entorno, documentarlo sin ocultarlo.
4. Al terminar, medir de nuevo solo para comparar de forma orientativa; los tiempos pueden variar.

## 2. Inventario de responsabilidades

Crear o actualizar `docs/TESTING.md` con una tabla por suite que indique:

- Módulo o flujo cubierto.
- Nivel: unitario, integración, navegador, arquitectura o infraestructura/distribución.
- Dependencias relevantes.
- Uso de procesos externos, puertos, temporales, globals o mocks compartidos.
- Posibles solapamientos y la decisión tomada.

Para cada caso trasladado, fusionado o eliminado, registrar:

| Caso original | Comportamiento protegido | Destino | Motivo |
|---|---|---|---|
| Nombre del caso | Fallo que detecta | Suite y caso final | Traslado, duplicación demostrada o integración necesaria |

No considerar duplicados dos tests solo porque mencionen la misma función: comparar entradas, aserciones, dependencias y los fallos que detectarían.

## 3. Estructura por nivel

Reorganizar `tests/` con esta estructura, salvo que exista otra equivalente en el repositorio:

```text
tests/
  unit/
  integration/
  browser/
  architecture/
  infrastructure/
  helpers/
```

Criterios:

- `unit/`: comportamiento de un módulo con dependencias controladas.
- `integration/`: colaboración entre módulos.
- `browser/`: DOM real, eventos, estilos, accesibilidad y recorridos de usuario.
- `architecture/`: restricciones estáticas justificadas sobre fuentes y contratos.
- `infrastructure/`: bundler y servidor local.

Primero mover todos los casos preservando su contenido, corregir imports y rutas basadas en `__dirname`, y verificar que la suite sigue cubriendo lo mismo. No combinar movimientos masivos con eliminación de tests en el mismo paso.

## 4. Scripts de ejecución

Definir scripts explícitos en `package.json`:

```text
npm test
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:architecture
npm run test:infrastructure
```

`npm test` debe ejecutar todos los niveles. `test:unit` debe seleccionar únicamente los archivos unitarios y no excluir suites por nombre; en particular, no debe arrancar servidor Python ni generar bundles.

Si se necesita un selector común, crear un script mínimo en `scripts/` que:

- Construya listas deterministas y explícitas de archivos.
- Invoque `node --test` con argumentos separados, sin interpolación de shell.
- Propague errores y código de salida.
- Rechace niveles o grupos desconocidos.
- Informe de selecciones vacías.
- Permita listar archivos sin ejecutarlos.
- Excluya helpers del descubrimiento de tests.

Añadir pruebas focalizadas para la selección por nivel, unión sin duplicados, grupo desconocido y propagación de fallo. No lanzar la suite completa desde otra suite.

## 5. División de la suite de navegador

Dividir la actual suite monolítica de navegador por funcionalidades reales, con archivos coherentes, por ejemplo:

- Arranque y carga del bundle.
- Perfiles y configuración.
- Conversación e historial.
- Composer y generación.
- Diálogos y avisos.
- MCP y herramientas.
- WebLLM.
- Apariencia y accesibilidad.

Extraer a `tests/helpers/` solo preparación compartida: apertura y cierre del navegador, contextos, espera de arranque y perfiles de prueba.

Preservar:

- Contexto aislado por caso cuando sea necesario.
- Limpieza de contextos, páginas y servidores mediante hooks o `try/finally`.
- Captura de errores inesperados de consola y página.
- Cobertura de `file://` y HTTP ya existente.
- Pruebas de `zerochat.html` distribuible.

Al separar archivos, no suponer que el navegador se comparte entre procesos. Controlar explícitamente la concurrencia para evitar multiplicar procesos y consumo de memoria. Empezar secuencialmente si es necesario. Renombrar casos que usan nombres de fases históricas para describir el comportamiento comprobado.

Primero conservar todas las aserciones; revisar posibles duplicidades solo una vez que la división funcione.

## 6. Consolidación de reglas de turnos

Revisar conjuntamente:

```text
js/message-turns.js
js/chat-engine.js
js/state.js
js/conversation-service.js
```

Centralizar en los unitarios de `message-turns.js` las variantes de:

- `extractBaseId`.
- `isDateTimeInitialTurn`.
- Selección y eliminación de turnos.
- Eliminación de resultados de herramientas afectados.
- Saneamiento de huérfanos.
- Prefijos de identificadores próximos.
- Compatibilidad por nombre cuando aplique.
- Inmutabilidad.
- Entradas vacías o inválidas ya cubiertas.

Mantener como responsabilidad de cada consumidor:

- `state`: actualización atómica, resultado del mutador y guardas durante generación.
- `chat-engine`: normalización de su contrato público y validez de la siguiente petición tras borrar.
- `conversation-service`: ramificación, límites del historial e IDs de sesión.
- Integración: compatibilidad de fachadas y diferencias históricas de contratos.
- Navegador: acción de usuario y coherencia entre DOM e historial.

Separar de `test_message_turns.js` los casos que actualmente prueben estado o motor: deben ir a integración. No eliminar variantes únicas al trasladarlas.

## 7. Suites transversales y auditorías visuales

Revisar especialmente las suites de caché de contexto, infraestructura de errores, infraestructura de herramientas, modernización de UI e iconos.

- Llevar reglas de proveedores a las pruebas de proveedores.
- Llevar métricas al módulo que las normaliza.
- Mantener contratos de configuración y estado en su módulo o integración.
- Mantener restricciones de código fuente solo como arquitectura y cuando tengan una razón concreta.
- Mantener como integración los contratos entre ejecutor, manifiesto y herramientas.

Para iconos y modernización:

- Dejar el contrato del catálogo y SVG en unitarios.
- Dejar presencia real, accesibilidad e interacción en navegador.
- Consolidar aserciones repetidas únicamente si protegen exactamente lo mismo bajo las mismas condiciones.
- No sustituir comportamiento real por búsquedas de texto en código.

No es obligatorio mover o fusionar todas las suites: el criterio es una responsabilidad más clara.

## 8. Grupos de pruebas por área

Añadir grupos explícitos para el desarrollo diario, como:

```text
turns
conversation
generation
profiles
composer
mcp
rag
providers
bundle
```

Definir cada grupo como una lista mantenible de suites, incluyendo varios niveles cuando corresponda y eliminando duplicados. Documentar una sintaxis como:

```text
npm run test:group -- turns
npm run test:group -- composer --list
```

Correspondencia mínima:

| Grupo | Incluye |
|---|---|
| `turns` | Reglas de turnos y contratos con estado, motor y conversación |
| `composer` | Unitarios e interacción del composer |
| `generation` | Controlador, motor y ciclo visible |
| `profiles` | Repositorio, configuración, UI y recorridos de perfiles |
| `bundle` | Empaquetado y carga del distribuible |

No implementar selección automática basada en `git diff` en esta fase. Documentar que módulos compartidos, como `state.js`, proveedores o configuración, pueden requerir varios grupos. Los grupos no sustituyen `npm test` al finalizar un cambio.

## 9. Aislamiento y calidad

Revisar los tests afectados para detectar modificaciones de `global`, `window`, `document`, `navigator`, `fetch`, métodos de módulos, `require.cache`, persistencia entre casos, puertos fijos y temporales fijos.

- Restaurar recursos siempre, incluso con aserciones fallidas.
- Evitar concurrencia en suites con estado mutable compartido.
- Usar temporales únicos y limpieza garantizada cuando haya riesgo de colisión.
- Limitar correcciones a las pruebas afectadas por la nueva organización.

## 10. Documentación y validación final

En `docs/TESTING.md`, documentar estructura, responsabilidades, comandos, grupos, cómo ejecutar un archivo concreto, cómo añadir una suite, requisitos de navegador/servidor/bundle, y la validación completa exigida por `AGENTS.md`.

Revisar `/help` en español e inglés si contiene instrucciones de pruebas afectadas.

Al finalizar:

1. Confirmar que cada archivo de test queda seleccionado exactamente una vez al combinar niveles.
2. Ejecutar las suites afectadas durante el trabajo.
3. Ejecutar `npm run build` para actualizar el distribuible antes de las pruebas que dependan de él.
4. Ejecutar `npm test`.
5. Ejecutar `npm run build` final, conforme a `AGENTS.md`.
6. Revisar que `zerochat.html` está actualizado y que los tests de navegador no dejan errores inesperados.
7. Revisar el diff y limpiar solo temporales creados por el propio trabajo.

## Entrega esperada

Informar de:

- Organización final y comandos disponibles.
- Casos trasladados y duplicidades eliminadas, indicando su cobertura de destino.
- Validaciones ejecutadas y resultado.
- Comparación orientativa de duración antes y después.
- Fallos previos o limitaciones pendientes.
- Confirmación de que no cambió el comportamiento de producción.

El cambio se considerará aceptado si las pruebas se ejecutan por nivel, módulo o flujo; `test:unit` no inicia infraestructura externa; la suite de navegador deja de ser monolítica; las reglas compartidas tienen propietario claro; y cada caso eliminado conserva cobertura equivalente identificada.
