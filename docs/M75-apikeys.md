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

## 4. Brave Search con estas normas

- **API**: `GET https://api.search.brave.com/res/v1/web/search?q=…` con la cabecera `X-Subscription-Token`. Falta comprobar con una clave real que no admite llamadas desde el navegador (CORS); si es así, la clave va solo al backend (N1).
- **Cómo funcionaría**: `search_web` usa Brave cuando hay backend conectado y clave guardada, y DuckDuckGo en otro caso. El backend añade la cabecera y la clave nunca llega a la página ni al modelo.
- **Configuración**: en Ajustes › Conexión (o Herramientas), un campo de solo escritura con su estado («configurada» o «sin configurar») y un botón para borrarla.
- **Sin backend**: Brave no está disponible. Nunca se manda la clave a un proxy de terceros como Jina.

## 5. Decisiones pendientes

1. ¿Aplicar ya N5 (CryptoKey no extraíble y PBKDF2) a los perfiles locales, o solo a los secretos nuevos?
2. En el backend, ¿basta con SQLite 0600 o usamos el almacén de claves del sistema (Secret Service, Keychain, Credential Manager)? Esto último exige la dependencia `keyring` y no hay almacén en Android/Termux ni en un servidor sin sesión gráfica.
3. ¿Se mantiene copiar un perfil del servidor a local (lo único que necesita leer una clave del servidor) o se elimina?
4. ¿Dónde se configura Brave: Ajustes › Conexión, una sección de buscadores o el perfil?
