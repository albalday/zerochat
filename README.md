# ZeroChat

ZeroChat es un cliente web autónomo para chat, agentes IA y conocimiento local.
La distribución final es `zerochat.html`, un único archivo que puede abrirse
directamente mediante `file://`.

## Uso

1. Descarga `zerochat.html`.
2. Ábrelo en un navegador moderno.
3. Configura el proveedor, endpoint, clave y modelo.
4. Para usar documentos, abre **Conocimiento**, crea una rama, carga los archivos y actívala.

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

