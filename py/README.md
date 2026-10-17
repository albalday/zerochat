# Backend local y distribución Python (`py/`)

Este documento contiene las especificaciones de arquitectura, entorno local y empaquetado del backend de ZeroChat. Complementa a `AGENTS.md`.

---

## 1. Arquitectura y ensamblado de `zerochat.py`

* **Modularización:** El código fuente del backend reside dividido por dominios en `py/`.
* **Punto de entrada:** El módulo que contiene la función `main()` y el bloque de ejecución se denomina obligatoriamente `zz-main.py` para que la concatenación alfabética lo ubique siempre al final.
* **Proceso de compilación:** Cualquier cambio en `py/` requiere reconstruir el ejecutable unificado con:
  ```bash
  npm run build:backend
  ```
  Este script sincroniza los servicios gestionados, concatena ordenadamente los módulos de `py/` en `zerochat.py` y asegura sus permisos de ejecución. `zerochat.py` es un archivo autogenerado y debe mantenerse estrictamente sincronizado con `py/`.

---

## 2. Entorno local y aislamiento (`~/zerochat/`)

El backend opera de forma idéntica provenga del paquete PyPI o de la descarga con `curl`:

* **Directorio de datos:** Crea y gestiona la carpeta del usuario `~/zerochat/`, que contiene:
  * `config/`: configuración local y token diario de sesión.
  * `services/`: servicios locales y definiciones MCP.
  * `.venv/`: entorno virtual Python aislado.
* **Aislamiento de dependencias MCP:** Las herramientas y dependencias Python de MCP se instalan y ejecutan exclusivamente dentro de `~/zerochat/.venv/`. Queda prohibido instalar dependencias en el Python global o en el entorno del comando de PyPI.
* **Ejecución del servidor:** El servidor se ejecuta con el intérprete Python que lo lanzó. No se reinstala ni se reejecuta dentro del venv aislado.
* **Ciclo de vida limpio:** Borrar `~/zerochat/` debe restablecer por completo el estado del backend y eliminar los servicios MCP sin afectar al ejecutable ni a los datos almacenados en el navegador.

---

## 3. Seguridad y red

* **Autenticación obligatoria:** Todas las peticiones al backend requieren el token diario de sesión. El token se genera al primer arranque del día, se almacena en `~/zerochat/config/token.json` con permisos `0600` (directorio `0700`) y se reutiliza durante el día para permitir recargas y reinicios sin perder la sesión.
* **Interfaz de red:** Por defecto, el servidor escucha exclusivamente en `127.0.0.1`. Si se configura `--host` o `ZEROCHAT_HOST` para escuchar en interfaces públicas, el arranque debe mostrar una advertencia explícita sobre la exposición sin cifrar de ejecución de comandos.
* **Transporte web seguro (`zerochat/web/fetch`):** Permite al cliente web consultar páginas y búsquedas web a través del servidor local autorizado cuando está conectado, superando restricciones de CORS del navegador sin intermediarios ni proxies públicos. Incluye validación anti-SSRF estricta (bloqueo de metadatos cloud y rangos privados/loopback salvo autorización expresa).
* **Visor externo de diferencias (`zerochat/diff/open`):** Permite al cliente web solicitar la apertura desacoplada de `git difftool` en una ventana del sistema operativo para comparar archivos modificados frente a Git `HEAD` (o frente al último commit cuando el árbol de trabajo está limpio), sin transferir diffs por red ni cargar el contexto del modelo.

---

## 4. Distribución y publicación en PyPI

### Formatos de distribución

1. **Paquete PyPI (`pip install zerochat`):** Instala exclusivamente el ejecutable `zerochat.py` como comando global de consola. El paquete wheel (`.whl`) no debe contener HTML, CSS, JavaScript ni ningún otro recurso web.
2. **Descarga directa (`curl`):** Descarga el archivo ejecutable `zerochat.py` directamente.
3. Ambos modos abren siempre la interfaz web universal servida desde `https://albalday.github.io/zerochat/zerochat.html` para preservar un único origen para cookies, almacenamiento y token de sesión.

### Verificación de empaquetado

Antes de publicar cualquier versión de backend, debe verificarse la pureza del wheel:
```bash
python tests/packaging_smoke_test.py dist
```

### Procedimiento de release PyPI

1. **Preparar en `dev`:** Realizar y validar todos los cambios en la rama `dev`.
2. **Incrementar versión:** Ejecutar `npm run bump minor` o `major` (nunca editar versiones a mano).
3. **Validación completa:** Pasar la suite completa (`npm test` o `npm run test:all`).
4. **Promoción:** Promover el commit a la rama `master`.
5. **Etiquetado:** Crear y subir la etiqueta Git:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
6. **Publicación automatizada:** El flujo de GitHub Actions (`release.yml`) valida la etiqueta, ejecuta los tests, genera el wheel y publica en PyPI mediante Trusted Publishing (sin credenciales manuales).
