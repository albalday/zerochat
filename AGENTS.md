# Protocolo de Desarrollo para Agentes IA - ZeroChat

## Reglas Obligatorias de Proyecto

1. **Arquitectura y Edición de Código**:
   - El código fuente se desarrolla y modifica en `js/`, `css/` e `index.html`.
   - **NUNCA** se debe editar `zerochat.html` a mano.

2. **🛑 NORMA INQUEBRANTABLE DE FIN DE MODIFICACIÓN: REGENERAR EL BUNDLE**:
   - **SIEMPRE**, sin ninguna excepción, tras realizar cualquier modificación en el código fuente:
     1. Ejecutar la suite de tests: `npm test` (o `npm run test:unit`).
     2. **REGENERAR EL BUNDLE**: Ejecutar `npm run build` (que compila `zerochat.html`).
   - Ninguna tarea o interacción con el usuario se considera completada sin haber ejecutado `npm run build` para garantizar que la versión de producción `zerochat.html` esté 100% sincronizada.

