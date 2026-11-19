# Correo (IMAP / SMTP)

Servicio MCP gestionado incluido en ZeroChat para consultar, buscar y redactar borradores por **IMAP** y enviar mensajes por **SMTP** usando únicamente la librería estándar de Python (sin dependencias externas).

## Configuración en Ajustes › MCP

Guarda los tres secretos del servicio (se almacenan ofuscados en SQLite y se pasan solo por variables de entorno):

- `MAIL_IMAP_HOST`: servidor IMAP (por ejemplo `imap.gmail.com`).
  - Por defecto deduce el servidor SMTP sustituyendo `imap.` por `smtp.` (puerto `465` SSL), o `smtp.office365.com:587` para Outlook.
  - Si tu servidor SMTP es distinto o usa otro puerto, usa el formato `imap.ejemplo.com:993|smtp.ejemplo.com:587` (`587` usa STARTTLS; cualquier otro puerto usa SSL).
- `MAIL_USER`: dirección de correo o usuario.
- `MAIL_PASSWORD`: contraseña de la cuenta o **contraseña de aplicación** de 16 caracteres (obligatoria en Gmail con verificación en dos pasos desde [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)).

## Herramientas

- `list_folders` (`mail_list_folders`): lista las carpetas IMAP disponibles.
- `search_messages` (`mail_search_messages`): busca mensajes sin marcarlos como leídos (devuelve UID y cabeceras).
- `read_message` (`mail_read_message`): lee un mensaje por UID (cuerpo en texto acotado a 16.000 caracteres y metadatos de adjuntos).
- `create_draft` (`mail_create_draft`): guarda un borrador en la carpeta de borradores sin enviarlo.
- `send_email` (`mail_send_email`): envía un correo por SMTP (**desactivada por defecto**; actívala en Ajustes › MCP solo cuando quieras permitir envíos).
