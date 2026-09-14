# Publicación independiente del bundle

Implementar `build_release.py` para generar `dist/releases/<release-id>/` y `dist/channels/stable.json`. Empaquetar bootstrap, wheel del host, catálogo, documentación y locks. No llamar a este publicador desde `npm run build`: el bundle y las releases MCP son distribuibles independientes.

Resolver versiones npm publicadas durante la preparación de la release. Generar package-lock completo y lock de instalación con artefactos Node por plataforma, integridades, versiones de Python/contratos y entradas de catálogo admitidas. Verificar cada plataforma que se anuncie; no prometer soporte solo porque aparece en el ejemplo.

El publicador debe rechazar locks ausentes, checksums ficticios, referencias fuera de la release, versiones incompatibles y placeholders sin resolver. Probar instalación antes de declarar la release lista.

Publicar artefactos inmutables antes del puntero de canal en `https://albalday.github.io/zerochat/mcp/`. Esta URL es una ubicación propuesta que debe verificarse al desplegar. Las pruebas de desarrollo copian los mismos artefactos desde el checkout; los productos de terceros siguen requiriendo red o caché previa.

`dist/` es salida generada local, excluida de Git. No publicar ni promocionar a master como efecto de preparar este diseño.
