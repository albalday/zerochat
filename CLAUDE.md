# Guía de Claude para ZeroChat

Este archivo contiene instrucciones breves para Claude Code sobre cómo trabajar con el proyecto ZeroChat.

## ⚠️ IMPORTANTE: Lee Siempre AGENTS.md

**Antes de cualquier cambio o respuesta**, lee y sigue las normas completas en [AGENTS.md](AGENTS.md).

Ese archivo contiene:
- Normas de desarrollo obligatorias (pruebas, build, git)
- Estructura del proyecto y arquitectura
- Patrones y convenciones de código
- Requisitos de seguridad y calidad
- Guías de testing completas

**No dupliques contenido de AGENTS.md aquí** - siempre refiérete al archivo fuente.

## Idioma

- **Usuario prefiere español** - respuestas en español salvo indicación contraria
- Código y comentarios en inglés
- UI bilingüe (español/inglés) via sistema i18n

## Comandos Rápidos

```bash
# Desarrollo
python3 zerochat.py              # Servidor + navegador
npm test                         # Suite completa de pruebas
npm run build                    # Compilar bundle

# Testing selectivo
npm run test:group -- rag        # Grupo funcional específico
npm run test:changed             # Solo cambios git
npm run test:browser             # Solo navegador
```

Ver [AGENTS.md](AGENTS.md) para comandos completos y guías de uso.

## Estado Actual del Proyecto

**Versión actual**: 7.0.7

**Cambios recientes**:
- Modal RAG sin pestañas (sept 2024)
  - Modo `'activate'`: desde botón composer
  - Modo `'manage'`: desde menú configuración
  - Función `openRagModal(mode)` para abrir correctamente
  - Event listeners se re-adjuntan al cambiar modo

## Referencias

- [AGENTS.md](AGENTS.md) - **LEE ESTO PRIMERO** - Normas completas del proyecto
- [tests/README.md](tests/README.md) - Arquitectura de pruebas
- [Ayuda online](https://albalday.github.io/zerochat/help/)

---

**Este archivo complementa [AGENTS.md](AGENTS.md), no lo reemplaza**. Mantén este archivo breve y enfocado en referencias rápidas.
