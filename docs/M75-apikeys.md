# Almacén de API keys: estado actual y normas propuestas (M75-T7)

Borrador para decidir antes de añadir Brave Search, el primer servicio con clave que no es un proveedor de modelos.

## 1. Qué hay hoy

| Secreto | Dónde vive | Cómo se guarda | Quién lo usa |
|---|---|---|---|
| API key de un perfil local | Navegador, `localStorage` `profiles_v1` | AES-GCM con la clave por defecto (SHA-256 de una constante del código) o con una contraseña (SHA-256 de la contraseña, sin sal ni iteraciones) | El navegador llama directamente al proveedor |
| Contraseña de cifrado en uso | Navegador, `localStorage` `crypto_session_v1` | El material de clave derivado, **en claro**, durante 24 h | `ChatProfileBackup.withPassword` |
| API key de un perfil del servidor | Backend, SQLite `profiles.api_key` (fichero 0600) | **En claro** | Runner (sin clave y la pide al activarla, M73-D17); la interfaz al importarlo |
| Copia de un perfil del servidor importada | Navegador | Se vuelve a cifrar como un perfil local | Navegador |
| Clave del proxy (Ajustes › Conexión) | Navegador, configuración | En claro (aceptado en M42-D17: solo abre la puerta del proxy) | Cabecera `Authorization` al proxy |
| Token diario del backend | Backend `token.json` (0600) y cookie de sesión en el navegador | En claro | Toda petición al backend |
| Copias de perfiles exportadas | Fichero del usuario | AES-GCM con la clave por defecto o una contraseña | Importación |

Los servicios MCP incluidos no guardan claves en su configuración (Composio usa OAuth en su propia carpeta).

## 2. Puntos débiles

1. **El cifrado por defecto en el navegador es ofuscación**: la clave sale del código publicado, así que cualquiera que lea el `localStorage` (o una copia exportada sin contraseña) descifra todo.
2. **La contraseña se deriva sin coste**: un SHA-256 sin sal se prueba por fuerza bruta muy deprisa.
3. **La contraseña queda en claro 24 h** en `localStorage`: durante ese tiempo cifrar con contraseña no añade nada frente a quien lea el almacenamiento.
4. **`zerochat/profiles/list` devuelve las claves en claro** a cualquier cliente con el token completo, incluida la tablet por el túnel, aunque solo quiera la lista.
5. **No hay sitio para claves que no son de un perfil**: Brave Search u otros buscadores no tienen dónde guardarse.

## 3. Normas propuestas

- **N1. Una clave vive donde se usa.** En el navegador solo las de servicios a los que el navegador llama directamente (proveedores de modelos con CORS). En el backend las de servicios a los que el navegador no puede llamar (sin CORS, como se espera de Brave Search) o que se usan sin la página (el runner y las ejecuciones en servidor).
- **N2. El backend no devuelve secretos a la interfaz.** Los listados llevan `hasApiKey` y nunca el valor. Escribir una clave es una operación aparte (set o borrar), sin lectura posterior.
- **N3. Únicos intercambios permitidos:**
  - interfaz → backend, al guardar el usuario un perfil o un secreto del servidor (solo escritura);
  - backend → runner, la clave del perfil que activa, en memoria y con su línea en el registro (ya es así, M73-D17);
  - backend → interfaz, solo con una acción explícita del usuario para copiar un perfil del servidor a local (o se elimina esa importación; ver la pregunta 3).
- **N4. Una sola fuente por lado**: un almacén de secretos con nombre (`provider:<perfil>`, `search:brave`), `js/secret-store.js` en la interfaz y `py/storage/secrets.py` en el backend. Los perfiles y los buscadores guardan una referencia, no la clave.
- **N5. En reposo, en el navegador**: una CryptoKey AES-GCM generada al azar y **no extraíble**, guardada en IndexedDB (desaparece la constante del código). Con contraseña: PBKDF2-SHA-256 con sal y 600 000 iteraciones, y la clave derivada solo en memoria o en `sessionStorage`, nunca 24 h en `localStorage`.
- **N6. En reposo, en el backend**: SQLite con permisos 0600 en la carpeta de datos del usuario (modelo de amenaza: otro usuario del equipo), o el almacén de claves del sistema (ver la pregunta 2).
- **N7. Ninguna clave en registros, telemetría, exportaciones de conversaciones ni mensajes de error**; las copias de perfiles exportadas solo llevan claves si se exportan con contraseña.

## 4. Decisiones (2026-11-16)

1. **No se endurece el cifrado de los perfiles locales** (N5 queda aplazada): siguen con la clave por defecto o la contraseña actual.
2. **Backend: SQLite con ofuscación simple.** No es cifrado (la clave sale del código, como en el navegador), pero evita que una clave se lea al abrir el fichero o al buscar texto en el disco. Se aplica a todos los secretos del backend, también a `profiles.api_key`, que hoy está en claro. Los permisos 0600 se mantienen.
3. **Se mantiene copiar un perfil del servidor a local.** Así N2 tiene una única excepción explícita: un método propio que entrega la clave de un perfil solo al pulsar el usuario «importar», con su línea en el registro. El listado deja de llevar claves (`hasApiKey`).
4. **Brave: como servicio MCP** (pendiente de confirmar, ver el apartado 5).

## 5. Brave Search como servicio MCP

Es una variante nueva de gestión de claves: **el secreto de un servicio MCP**, que vive solo en el backend y se pasa al proceso del servicio en una variable de entorno al arrancarlo.

- **Servicio** (hecho en M75-T10): el servidor MCP oficial de Brave, `@brave/brave-search-mcp-server` 2.1.4 por npm, en stdio y con la clave en `BRAVE_API_KEY`, entra en el catálogo de `services/` con el id `brave` (sus herramientas quedan como `brave_brave_web_search`; con `brave-search` el guion se codificaba como `bravez2dzsearch_…`).
- **Declaración**: el `service.json` del servicio declara los secretos que necesita (nombre de la variable y etiqueta bilingüe), y `launch.env` los referencia con un marcador (por ejemplo `"BRAVE_API_KEY": "${secret:BRAVE_API_KEY}"`) que `McpManager._expand` resuelve al arrancar el servicio. Sin la clave guardada, el servicio no arranca y dice qué falta.
- **Guardado**: en Ajustes › MCP, el servicio muestra un campo de solo escritura por secreto, con el estado «configurada» o «sin configurar» y un botón para borrarla. El backend la guarda ofuscada en SQLite (`mcp:<servicio>:<VARIABLE>`) y nunca la devuelve.
- **Ventajas frente a integrarlo en `search_web`**: no hace falta código propio de búsqueda; aporta las herramientas del servicio (web, noticias, imágenes…) con el motor de permisos de las MCP, y el mismo mecanismo sirve para el siguiente servicio con clave (GitHub, Tavily…).
- **Inconvenientes**: necesita Node y npm, como los otros servicios incluidos, y solo funciona con el backend (como cualquier opción con Brave si no admite llamadas desde el navegador). El modelo verá `search_web` y la búsqueda de Brave a la vez; el perfil elige si activa el servicio.

## 6. Tareas propuestas

1. **Almacén de secretos del backend**: tabla en SQLite con ofuscación simple, migración de `profiles.api_key`, listado de perfiles sin claves (`hasApiKey`) y el método explícito para importar un perfil a local.
2. **Secretos de los servicios MCP**: declaración en `service.json`, marcador `${secret:…}` en el arranque, métodos de guardar y borrar, y su campo en Ajustes › MCP (español e inglés).
3. **Servicio Brave Search** en el catálogo, con su prueba de arranque sin clave y con clave.
