# ZeroChat — Implantación del ciclo de producción integrado con PyPI

## Objetivo

Implanta en el repositorio de ZeroChat un ciclo de publicación sencillo, reproducible y verificable, manteniendo al máximo la arquitectura actual.

El resultado esperado es:

```text
desarrollo → tests → preparación de versión → GitHub Release publicada por el propietario
                                                   ↓
                                         GitHub Actions automático
                                                   ↓
                                    tests + build + comprobaciones
                                                   ↓
                                      PyPI Trusted Publishing
                                                   ↓
                                         wheel/sdist + attestations
                                                   ↓
                                     pipx install/upgrade zerochat
```

La **publicación manual de una GitHub Release** será el único acto que significa «esta versión pasa a producción». No añadas otro sistema de aprobación propio.

No uses API keys de PyPI ni secretos permanentes. La publicación debe usar **PyPI Trusted Publishing (OIDC)** mediante GitHub Actions y la acción oficial `pypa/gh-action-pypi-publish`.

---

## Principios de implantación

1. Mantén el sistema simple.
2. No refactorices ZeroChat solo para empaquetarlo si no es necesario.
3. Conserva `zerochat.py` y su función actual siempre que sea viable.
4. Introduce únicamente los cambios necesarios para que ZeroChat sea instalable como paquete Python y ejecutable con el comando `zerochat`.
5. El paquete publicado debe poder instalarse con `pipx install <nombre-distribucion>`.
6. El usuario debe poder ejecutar después simplemente:

```bash
zerochat
```

7. La publicación a PyPI solo puede producirse desde `.github/workflows/release.yml`.
8. Una release nunca debe publicarse en PyPI si fallan tests, build, validación de versión o smoke test del paquete construido.
9. No introduzcas TestPyPI en el ciclo normal salvo que sea necesario para depurar la primera implantación.
10. No añadas Docker, Poetry, Hatch, semantic-release ni otros sistemas de release salvo necesidad técnica real. Usa el toolchain estándar mínimo.

---

# Fase 1 — Analizar el estado actual

Antes de modificar nada:

1. Inspecciona la estructura actual del repositorio.
2. Determina qué necesita `zerochat.py` en tiempo de ejecución:
   - módulos Python propios;
   - HTML, JS, CSS u otros recursos;
   - ficheros de configuración;
   - recursos descargados posteriormente;
   - rutas relativas al directorio del script.
3. Identifica cómo se ejecutan actualmente los tests y cuál es la versión mínima de Python soportada.
4. Comprueba si ya existe `pyproject.toml`, configuración de packaging, versión centralizada o workflows de GitHub Actions.
5. Reutiliza lo existente siempre que sea correcto.

No cambies la arquitectura más de lo necesario.

### Caso preferido

Si `zerochat.py` puede funcionar como módulo Python independiente, mantén ese fichero y empaquétalo como módulo, usando el equivalente en setuptools a:

```toml
[tool.setuptools]
py-modules = ["zerochat"]

[project.scripts]
zerochat = "zerochat:main"
```

Asegúrate de que existe una función `main()` adecuada para el entry point.

Si hay recursos auxiliares que deban viajar dentro del wheel, inclúyelos correctamente como package data o aplica la mínima reorganización necesaria para acceder a ellos mediante mecanismos compatibles con un paquete instalado. No dependas de que el directorio de trabajo sea el repositorio clonado.

---

# Fase 2 — Crear o completar `pyproject.toml`

Usa `pyproject.toml` como fuente estándar del empaquetado.

Debe contener como mínimo:

- build system estándar y mantenido;
- nombre de distribución de PyPI;
- versión;
- descripción;
- `readme`;
- licencia según el repositorio;
- versión mínima de Python coherente con el proyecto;
- dependencias reales de ejecución;
- enlaces al repositorio/proyecto;
- entry point `zerochat`.

No inventes dependencias. Derívalas del código y de la configuración existente.

La versión debe existir en **un único lugar canónico** siempre que sea razonablemente posible. Preferencia: `[project].version` de `pyproject.toml` si el proyecto no dispone ya de una estrategia de versionado centralizada mejor.

El nombre del comando debe seguir siendo:

```bash
zerochat
```

El nombre de la distribución en PyPI puede ser diferente si `zerochat` no estuviera disponible. En ese caso, no cambies el nombre del comando: por ejemplo, una distribución `zerochat-ai` puede seguir declarando:

```toml
[project.scripts]
zerochat = "zerochat:main"
```

No decidas silenciosamente un nombre alternativo: deja claramente indicado al propietario qué nombre de distribución debe registrar en PyPI.

---

# Fase 3 — Interfaz mínima necesaria para instalación y pruebas

Asegura que el comando instalado permita como mínimo:

```bash
zerochat
zerochat --version
```

`zerochat --version` debe:

- mostrar la versión instalada;
- terminar con código 0;
- no abrir navegador;
- no arrancar servidores;
- no descargar componentes;
- no modificar el sistema.

Si ya existe `--help`, consérvalo. Si no existe y añadirlo es trivial, puede añadirse, pero no conviertas el launcher en un CLI complejo.

La ejecución normal `zerochat` debe conservar el comportamiento actual de arranque.

---

# Fase 4 — Tests de packaging

Añade tests o comprobaciones suficientes para cubrir el nuevo mecanismo sin inflar innecesariamente la suite.

Como mínimo verifica:

1. que el paquete se construye;
2. que se genera un wheel y un sdist;
3. que el wheel puede instalarse en un entorno limpio;
4. que el comando `zerochat` queda disponible;
5. que `zerochat --version` funciona;
6. que la versión reportada coincide con la del paquete;
7. que los recursos necesarios para el arranque quedan incluidos en el wheel.

No dupliques pruebas funcionales ya cubiertas por la suite existente.

---

# Fase 5 — CI normal

Si no existe ya una CI equivalente, crea un workflow ligero para commits/PR que ejecute la suite normal y compruebe que el paquete puede construirse.

El objetivo es detectar errores de packaging **antes** de intentar crear una release.

No publiques nada desde este workflow.

La CI normal jamás debe disponer de permiso `id-token: write` para PyPI.

---

# Fase 6 — Workflow exclusivo de producción

Crea exactamente este fichero como workflow dedicado de publicación:

```text
.github/workflows/release.yml
```

Debe activarse únicamente cuando se publique una GitHub Release:

```yaml
on:
  release:
    types: [published]
```

No añadas `push`, `pull_request` ni `workflow_dispatch` al workflow de producción salvo petición posterior expresa del propietario.

## Estructura lógica

Usa dos jobs separados:

```text
build-and-test
      ↓
publish-pypi
```

### Job `build-and-test`

Debe:

1. hacer checkout exactamente del tag asociado a la GitHub Release;
2. configurar una versión de Python compatible con el proyecto;
3. instalar solo las herramientas necesarias para tests/build;
4. ejecutar la suite de tests;
5. comprobar que el tag de la release tiene formato `vX.Y.Z` o el esquema de versión adoptado por el proyecto;
6. leer la versión canónica del proyecto;
7. abortar si el tag no equivale exactamente a `v<version>`;
8. ejecutar el build estándar, preferentemente:

```bash
python -m build
```

9. validar que existen los artefactos esperados en `dist/`;
10. instalar el wheel generado en un entorno limpio;
11. ejecutar el smoke test `zerochat --version`;
12. subir `dist/` como artifact de GitHub Actions para el job de publicación.

No publiques desde este job.

### Job `publish-pypi`

Debe:

1. depender de `build-and-test`;
2. usar un GitHub Environment llamado exactamente:

```text
pypi
```

3. descargar exclusivamente los artefactos `dist/` generados por el job anterior;
4. declarar a nivel de job únicamente el permiso necesario para Trusted Publishing:

```yaml
permissions:
  id-token: write
```

5. publicar mediante:

```yaml
uses: pypa/gh-action-pypi-publish@release/v1
```

6. no utilizar `username`, `password`, `PYPI_TOKEN`, secrets ni credenciales permanentes;
7. no desactivar la generación normal de attestations de la acción oficial.

La acción oficial de PyPA debe encargarse de la publicación OIDC y de las attestations.

---

# Fase 7 — Seguridad del workflow

Aplica estas reglas:

- Mantén la publicación en `release.yml`, separada de la CI general.
- Concede `id-token: write` únicamente al job que publica.
- No ejecutes código procedente de PRs externos dentro del job con capacidad de publicación.
- No uses `pull_request_target`.
- No guardes credenciales PyPI en GitHub Secrets.
- El environment usado por el workflow y el configurado posteriormente en PyPI debe llamarse exactamente `pypi`.
- El nombre de owner, repositorio y workflow configurados en PyPI deberán coincidir exactamente con GitHub.

No añadas mecanismos criptográficos propios.

---

# Fase 8 — Proceso de preparación de una versión

Documenta y deja preparado este procedimiento para Codex.

Cuando el propietario diga explícitamente algo equivalente a:

> prepara la nueva versión de producción

Codex debe:

1. revisar que el árbol de trabajo corresponde al estado que se quiere publicar;
2. ejecutar todos los tests;
3. decidir con el propietario la nueva versión si no está ya indicada;
4. actualizar la versión canónica;
5. actualizar CHANGELOG/release notes solo si el proyecto ya utiliza esos elementos o si se ha acordado incorporarlos;
6. ejecutar nuevamente tests y build;
7. instalar localmente el wheel generado y ejecutar el smoke test;
8. comprobar que no hay credenciales, ficheros temporales ni artefactos locales que vayan a entrar por accidente;
9. preparar el commit de release;
10. dejar preparado el tag `vX.Y.Z` o proporcionar el comando exacto para crearlo;
11. presentar al propietario un resumen corto con:
   - versión;
   - tests;
   - build;
   - smoke test;
   - cambios principales;
   - cualquier incidencia pendiente.

**Codex no debe considerar la versión publicada en producción hasta que el propietario publique manualmente la GitHub Release.**

Si Codex dispone en ese momento de autorización GitHub para crear un draft de release, puede preparar un **draft**, pero no debe publicarlo automáticamente salvo orden explícita del propietario.

---

# Fase 9 — Qué sucede al publicar la GitHub Release

El comportamiento esperado debe ser completamente automático:

```text
Propietario pulsa “Publish release”
              ↓
release.yml
              ↓
tests
              ↓
validación tag ↔ versión
              ↓
build wheel + sdist
              ↓
smoke test del wheel
              ↓
OIDC Trusted Publishing
              ↓
PyPI
              ↓
attestations automáticas
```

Si cualquier comprobación anterior a PyPI falla, no debe publicarse ningún paquete.

Las versiones ya publicadas en PyPI son inmutables: no intentes sobrescribir una versión existente. Corrige el problema y publica una versión nueva.

---

# Fase 10 — Documentación para usuarios

Actualiza el README para que la instalación recomendada sea:

```bash
pipx install <nombre-distribucion-pypi>
zerochat
```

Actualización:

```bash
pipx upgrade <nombre-distribucion-pypi>
```

Prueba puntual sin dejar instalación permanente:

```bash
pipx run <nombre-distribucion-pypi>
```

Mantén también visible una alternativa para usuarios que quieran inspeccionar el código fuente antes de ejecutarlo, por ejemplo clonando el repositorio y ejecutando el mecanismo de desarrollo existente.

Explica brevemente en el README que las releases de PyPI se publican desde el repositorio oficial mediante PyPI Trusted Publishing y GitHub Actions.

No presentes `pipx` como sandbox de seguridad: aísla las dependencias Python, pero ZeroChat continúa ejecutándose con los permisos normales del usuario.

---

# Fase 11 — Comprobación inicial antes de entregar la implantación

Antes de declarar terminada esta tarea:

1. ejecuta la suite completa;
2. construye localmente wheel + sdist;
3. inspecciona el contenido del wheel;
4. comprueba que contiene todos los recursos de runtime necesarios;
5. instala el wheel en un entorno limpio;
6. ejecuta `zerochat --version`;
7. si es viable sin efectos indeseados, realiza una comprobación de arranque básica;
8. valida sintácticamente los workflows;
9. revisa que `release.yml` no contenga secrets de PyPI;
10. comprueba que el único job con `id-token: write` es el de publicación;
11. confirma cuál es el nombre de distribución PyPI que debe configurar manualmente el propietario.

No ejecutes todavía una publicación real a PyPI salvo que el propietario lo ordene expresamente y haya completado la preparación manual descrita en el documento complementario.

---

# Entrega esperada de Codex

Al terminar, informa con este formato aproximado:

```text
Implantación de packaging/release terminada.

Distribución PyPI prevista: <nombre>
Comando instalado: zerochat
Versión actual: X.Y.Z

Añadido/modificado:
- pyproject.toml
- entry point zerochat
- CI de packaging si era necesaria
- .github/workflows/release.yml
- tests mínimos de instalación/smoke
- README

Validaciones:
- tests: OK
- wheel: OK
- sdist: OK
- instalación limpia: OK
- zerochat --version: OK
- tag/version guard: OK

Acción pendiente del propietario:
Configurar en PyPI el Trusted Publisher correspondiente a:
owner: sh1nny0u
repository: ZeroChat
workflow: release.yml
environment: pypi
```

Si el owner o el nombre exacto del repositorio actual fueran distintos, utiliza los valores reales y señálalo claramente.

---

## Referencias oficiales

- Python Packaging User Guide — `pyproject.toml` y scripts: https://packaging.python.org/en/latest/guides/writing-pyproject-toml/
- PyPI Trusted Publishing: https://docs.pypi.org/trusted-publishers/
- Crear un proyecto mediante un Pending Trusted Publisher: https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/
- Publicar mediante Trusted Publisher: https://docs.pypi.org/trusted-publishers/using-a-publisher/
- PyPI attestations: https://docs.pypi.org/attestations/producing-attestations/
