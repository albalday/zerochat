# ZeroChat

ZeroChat es un cliente web autónomo para chat, agentes IA y conocimiento local.
La distribución final es `zerochat.html`, un único archivo que puede abrirse
directamente mediante `file://`.

## Uso

1. Descarga `zerochat.html`.
2. Ábrelo en un navegador moderno.
3. En el selector del cuadro de mensaje, abre **Editar perfiles** y crea un perfil con proveedor, endpoint, clave y modelo. Consulta el servidor antes de guardarlo.
4. Para usar documentos, abre **Conocimiento**, crea una rama, carga los archivos y actívala.

La primera ejecución activa **Espejo**, un perfil incorporado de solo lectura.
Devuelve el cuerpo JSON compacto de la petición compatible con OpenAI y un aviso de
pruebas, sin consultar servidores ni ejecutar herramientas. También es el respaldo
al eliminar un perfil activo o recuperar una selección que ya no existe. La lista
se abre desde el composer y admite navegación con flechas y cierre con Escape.

En perfiles Gemini, **Free Tier** introduce el marcador `FREE-TIER`. La resolución
de claves se centraliza para chat, consulta de modelos e inspección, independientemente
del proveedor. `freeApi()` obtiene la clave de `ChatStorage` con el nombre
`free_tier_api_key` (en `localStorage`, `zerochat_free_tier_api_key`). Si no existe,
el marcador produce un error antes de acceder a red. No hay una clave compartida
incorporada ni una variable global para proporcionarla.

## Desarrollo

Requisitos:

- Node.js LTS y npm;
- Python 3;
- Chromium de Playwright para las pruebas de navegador.

Instalación:

```bash
npm ci
npx playwright install chromium
```

Validación durante el desarrollo:

```bash
npm run test:unit
npm run test:browser
```

Validación antes de entregar cambios:

```bash
npm test
npm run build
```

`npm run build` genera el bundle distribuible y reconstruye `zerochat.html` a partir
de `index.html`, `js/` y `css/`.

## Estructura básica

- `index.html`: aplicación fuente.
- `js/`: módulos de aplicación.
- `css/`: estilos y tokens de diseño.
- `tests/`: pruebas automatizadas.
- `docs/TOOLS.md`: contrato de las herramientas.
- `zerochat.html`: distribución generada.

No se debe editar manualmente `zerochat.html`.

## Cambios de código

Los cambios deben ser pequeños, mantenibles y coherentes con los patrones existentes.
Toda modificación de comportamiento debe incluir o actualizar pruebas. Los cambios
de interfaz deben mantener la localización española e inglesa y validarse mediante
la suite de navegador.

La aplicación no debe registrar claves API, tokens ni datos privados en el código,
las pruebas o la consola.
