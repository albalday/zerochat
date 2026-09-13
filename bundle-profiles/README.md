# Perfil de demostración para el bundle / Bundle Demo Profile

## Español
Coloca aquí un único archivo `.zcp` exportado desde ZeroChat antes de ejecutar `npm run build`.

El generador lo incorpora únicamente en `zerochat.html`. En el primer inicio del bundle, si todavía no existe el almacenamiento de perfiles, restaura esa copia junto al perfil Espejo. `index.html` y la ejecución de desarrollo no leen este directorio.

## English
Place a single `.zcp` file exported from ZeroChat here before running `npm run build`.

The bundler embeds it exclusively into `zerochat.html`. On the first launch of the bundle, if profile storage does not exist yet, it restores that backup alongside the Mirror profile. `index.html` and development runs do not read this directory.
