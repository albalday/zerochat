# Correo (IMAP / SMTP)

Servicio MCP gestionado incluido en ZeroChat para consultar, buscar y redactar borradores por **IMAP** y enviar mensajes por **SMTP** usando únicamente la librería estándar de Python (sin dependencias externas).

## Configuración en Ajustes › MCP

Configura los dos campos de texto del servicio (se guardan en las preferencias del servidor local) y su contraseña secreta (se almacena ofuscada en SQLite y se pasa solo por variable de entorno):

- `MAIL_IMAP_HOST`: servidor IMAP (por ejemplo `imap.gmail.com`).
  - Por defecto deduce el servidor SMTP sustituyendo `imap.` por `smtp.` (puerto `465` SSL), o `smtp.office365.com:587` para Outlook.
  - Si tu servidor SMTP es distinto o usa otro puerto, usa el formato `imap.ejemplo.com:993|smtp.ejemplo.com:587` (`587` usa STARTTLS; cualquier otro puerto usa SSL).
- `MAIL_USER`: dirección de correo o usuario.
- `MAIL_PASSWORD` (secreto): contraseña de la cuenta o **contraseña de aplicación** de 16 caracteres (obligatoria en Gmail con verificación en dos pasos desde [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)).

## Herramientas

- `list_folders` (`mail_list_folders`): lista las carpetas IMAP disponibles.
- `search_messages` (`mail_search_messages`): busca mensajes sin marcarlos como leídos (devuelve UID y cabeceras).
- `read_message` (`mail_read_message`): lee un mensaje por UID (cuerpo en texto acotado a 16.000 caracteres y metadatos de adjuntos).
- `create_draft` (`mail_create_draft`): guarda un borrador en la carpeta de borradores sin enviarlo.
- `send_email` (`mail_send_email`): envía un correo por SMTP (**desactivada por defecto**; actívala en Ajustes › MCP solo cuando quieras permitir envíos).

## Adjuntos

`create_draft` y `send_email` aceptan `attachments`, una lista de **nombres de fichero sin ruta** que el servicio lee solo de su carpeta de salida fija, `outbox/` dentro de la carpeta del servicio (por defecto `~/zerochat/services/mail/outbox`; se crea al arrancar, solo accesible para el usuario). La descripción de las herramientas lleva la ruta absoluta para que el modelo copie allí antes los ficheros (por ejemplo con `run_command`); esa copia pasa por los permisos de lectura y escritura del proyecto, y el servicio no puede leer nada fuera de la carpeta.

- Se rechazan nombres con separadores (`/`, `\`, `:`), `.` y `..`, enlaces simbólicos, carpetas y nombres repetidos.
- Como máximo 10 adjuntos y 18 MB en total sin codificar (en base64 quedan por debajo de los 25 MB de Gmail); pasarse es un error, no se descarta ningún adjunto.
- Tras enviar el correo o guardar el borrador se borran de la carpeta; si la operación falla se conservan para reintentar. Los que no se puedan borrar se indican en `attachments_not_removed`.
