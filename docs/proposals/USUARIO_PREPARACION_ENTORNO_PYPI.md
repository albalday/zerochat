# ZeroChat — Acciones manuales del propietario para activar la publicación en PyPI

## Objetivo

Este documento contiene únicamente las acciones que debe realizar manualmente el propietario de ZeroChat.

Una vez terminada la configuración inicial, el ciclo normal será muy simple:

```text
Codex prepara una versión
        ↓
Tú revisas el resumen
        ↓
Tú publicas la GitHub Release
        ↓
GitHub Actions hace todo lo demás
        ↓
PyPI
```

No tendrás que copiar API keys de PyPI ni ejecutar manualmente `twine`.

---

# A. Acciones que debes hacer UNA SOLA VEZ

Haz esta preparación después de que Codex haya implantado el packaging y exista en el repositorio:

```text
.github/workflows/release.yml
```

No configures PyPI antes de conocer el **nombre de distribución definitivo** que Codex ha dejado en `pyproject.toml`.

## 1. Revisar el resultado de Codex

Codex debe decirte al menos:

```text
Distribución PyPI: zerochat
GitHub owner: albalday
Repositorio: zerochat
Workflow: release.yml
Environment: pypi
```

Comprueba especialmente el nombre de distribución.

El comando que verá el usuario puede seguir siendo:

```bash
zerochat
```

aunque el nombre del paquete de PyPI tuviera que ser distinto.

---

## 2. Crear o comprobar tu cuenta de PyPI

Entra en:

https://pypi.org/

Crea una cuenta o inicia sesión.

Recomendación: activa 2FA en la cuenta de PyPI.

No crees una API key para ZeroChat. No será necesaria.

---

## 3. Comprobar el nombre de distribución

Comprueba que el nombre definido por Codex para `[project].name` es el que quieres publicar.

Si `zerochat` no pudiera registrarse, elige una variante clara, por ejemplo otra denominación relacionada con el proyecto. Cambiar el **nombre de distribución PyPI** no obliga a cambiar el comando instalado `zerochat`.

Si hay que cambiar el nombre, haz que Codex modifique primero `pyproject.toml` y cualquier documentación relacionada.

No continúes con dos nombres distintos entre PyPI y `pyproject.toml`.

---

## 4. Crear el GitHub Environment `pypi`

En el repositorio de GitHub:

```text
Settings
→ Environments
→ New environment
```

Nombre exacto:

```text
pypi
```

Para la solución simple, no necesitas añadir secrets.

Si GitHub te permite configurar protecciones y quieres una segunda confirmación dentro de Actions, puedes exigir aprobación manual, pero **no es necesaria para este diseño**, porque tu acto de publicar la GitHub Release ya es la autorización de producción.

La opción más simple es crear el environment `pypi` y no añadir más lógica.

---

## 5. Configurar PyPI Trusted Publishing

### Si el proyecto todavía NO existe en PyPI

Utiliza un **Pending Trusted Publisher**. Esto permite que la primera publicación cree el proyecto automáticamente.

En tu cuenta de PyPI busca la sección de Publishing/Trusted Publishers y añade un publisher de GitHub.

Introduce exactamente los datos que Codex haya confirmado. Para el repositorio actual deberían ser, salvo cambio posterior:

```text
PyPI project name: zerochat
Owner: albalday
Repository: zerochat
Workflow filename: release.yml
Environment name: pypi
```

Importante: un Pending Trusted Publisher **no reserva el nombre** hasta que se hace la primera publicación real.

### Si el proyecto YA existe en PyPI

En PyPI:

```text
Your projects
→ <proyecto ZeroChat>
→ Manage
→ Publishing
→ Add a new publisher
→ GitHub
```

Configura:

```text
Owner: albalday
Repository: zerochat
Workflow filename: release.yml
Environment name: pypi
```

Usa los nombres reales si el repositorio ha cambiado.

---

## 6. No configurar credenciales adicionales

Al finalizar debes tener:

```text
GitHub Environment: pypi
PyPI Trusted Publisher: configurado
```

Y NO debes necesitar:

```text
PYPI_TOKEN
usuario/password en GitHub
API key PyPI
Twine configurado localmente
```

GitHub Actions se identificará ante PyPI mediante OIDC y recibirá una credencial temporal durante cada publicación.

---

# B. PRIMERA PUBLICACIÓN

La primera vez conviene prestar un poco más de atención porque valida todo el circuito.

## 1. Pide a Codex preparar la versión

Por ejemplo:

```text
Prepara ZeroChat para publicar la versión 7.3.0 siguiendo el ciclo de producción definido en CODEX_CICLO_PRODUCCION_PYPI.md. No publiques la GitHub Release.
```

Codex debe terminar mostrando algo parecido a:

```text
versión: 7.3.0
tests: OK
build: OK
wheel: OK
sdist: OK
smoke test: OK
tag previsto: v7.3.0
```

No continúes si hay algún fallo.

---

## 2. Revisa los cambios

Para la primera release revisa especialmente:

- `pyproject.toml`;
- nombre del paquete;
- versión;
- `.github/workflows/release.yml`;
- README;
- que no haya API keys ni secretos;
- que el workflow publique exclusivamente al evento `release: published`.

No hace falta auditar toda la aplicación de nuevo: esta revisión se centra en el mecanismo de publicación.

---

## 3. Publica la GitHub Release

En GitHub:

```text
Releases
→ Draft a new release
```

Usa el tag correspondiente a la versión, por ejemplo:

```text
v7.3.0
```

El tag debe coincidir exactamente con la versión del `pyproject.toml` precedida por `v`.

Ejemplo:

```text
pyproject.toml: 7.3.0
Git tag:        v7.3.0
```

Añade un título sencillo y, si quieres, las notas preparadas por Codex.

Después pulsa:

```text
Publish release
```

**Ese clic es la autorización de paso a producción.**

---

## 4. Comprueba la ejecución automática

Después de publicar la release, ve a:

```text
GitHub
→ Actions
→ release
```

Comprueba que terminan correctamente:

```text
build-and-test     ✓
publish-pypi       ✓
```

Después comprueba la página del proyecto en PyPI.

En la primera publicación, si usaste un Pending Trusted Publisher, PyPI creará el proyecto y convertirá el publisher pendiente en uno normal automáticamente.

---

## 5. Prueba como usuario final

Desde un entorno donde tengas `pipx`:

```bash
pipx install <nombre-distribucion>
zerochat --version
```

Después prueba el arranque normal:

```bash
zerochat
```

Si ya estaba instalado:

```bash
pipx upgrade <nombre-distribucion>
```

Con esto queda validado el ciclo completo.

---

# C. QUÉ DEBES HACER EN CADA NUEVA VERSIÓN

Después de la primera publicación, tu trabajo normal se reduce prácticamente a dos momentos.

## Momento 1 — Pedir a Codex que prepare la versión

Ejemplo:

```text
Prepara la versión 7.4.0 de producción siguiendo CODEX_CICLO_PRODUCCION_PYPI.md. No publiques la release.
```

Codex debe encargarse de:

```text
código
→ tests
→ versión
→ build
→ wheel/sdist
→ smoke test
→ preparación del commit/tag/release notes
```

Tú revisas únicamente su resumen y cualquier incidencia que indique.

---

## Momento 2 — Autorizar producción

Cuando decidas que está lista:

```text
GitHub → Releases → publicar vX.Y.Z
```

Ese es el único paso manual recurrente obligatorio.

A partir de ese momento GitHub Actions debe:

```text
tests
→ comprobación versión/tag
→ build
→ instalación de prueba
→ publicación PyPI
→ attestations
```

No ejecutes `pip upload`, `twine` ni scripts de publicación locales.

---

# D. QUÉ HACER SI FALLA UNA PUBLICACIÓN

## Si falla antes de publicar en PyPI

No intentes saltarte las comprobaciones.

Pasa el error de GitHub Actions a Codex para que lo corrija.

Si la versión aún no existe en PyPI, puede volver a ejecutarse el proceso una vez corregida la causa, teniendo cuidado con el estado de la GitHub Release/tag.

## Si la versión ya llegó a PyPI

No intentes reemplazarla.

Las versiones publicadas deben considerarse inmutables.

Corrige el problema y publica una versión superior, por ejemplo:

```text
7.4.0  → problema
0.2.1  → corrección
```

---

# E. CUÁNDO DEBES VOLVER A TOCAR LA CONFIGURACIÓN DE PyPI

En condiciones normales, nunca.

Revísala únicamente si cambia alguno de estos datos:

```text
owner de GitHub
nombre del repositorio
nombre de release.yml
nombre del environment pypi
nombre de la distribución PyPI
```

Si se renombra o mueve el repositorio, actualiza el Trusted Publisher antes de intentar otra publicación.

---

# Resumen operativo

## Una sola vez

```text
1. Codex implanta packaging + release.yml.
2. Tú creas/inicias sesión en PyPI.
3. Tú creas el environment de GitHub: pypi.
4. Tú configuras el Trusted Publisher de PyPI.
5. Codex prepara la primera versión.
6. Tú publicas la primera GitHub Release.
7. Compruebas Actions + PyPI + pipx.
```

## Cada nueva versión

```text
1. “Codex, prepara la versión X.Y.Z.”
2. Codex ejecuta tests/build/smoke y deja todo preparado.
3. Revisas su resumen.
4. Publicas la GitHub Release vX.Y.Z.
5. Fin: el resto es automático.
```

---

## Referencias oficiales

- PyPI Trusted Publishing: https://docs.pypi.org/trusted-publishers/
- Crear un proyecto con Pending Trusted Publisher: https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/
- Añadir Trusted Publisher a un proyecto existente: https://docs.pypi.org/trusted-publishers/adding-a-publisher/
- Publicar con GitHub Actions: https://docs.pypi.org/trusted-publishers/using-a-publisher/
- Attestations: https://docs.pypi.org/attestations/producing-attestations/
