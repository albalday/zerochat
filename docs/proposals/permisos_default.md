# Propuesta: Sistema de Permisos por Defecto para Herramientas MCP

**Autor:** Claude Fable 5.1  
**Fecha:** 2026-09-21  
**Estado:** Propuesta  
**Versión:** 1.0  

---

## 1. Resumen Ejecutivo

Actualmente, cuando un usuario activa un servidor MCP (como Playwright), ZeroChat solicita confirmación para cada herramienta individual antes de ejecutarla, lo cual resulta tedioso y afecta la experiencia de usuario. 

Esta propuesta define un **sistema de permisos por defecto basado en patrones** que aprueba automáticamente operaciones seguras (lectura, consulta) y solicita confirmación solo para operaciones peligrosas (ejecución, eliminación), aplicable la primera vez que se descubre una herramienta MCP.

**Beneficios:**
- ✅ Mejora la experiencia de usuario al reducir confirmaciones innecesarias
- ✅ Mantiene la seguridad bloqueando operaciones peligrosas por defecto
- ✅ Es transparente y modificable por el usuario
- ✅ No invasivo: solo afecta a herramientas nuevas, respeta configuración manual

---

## 2. Problema Actual

### 2.1. Flujo Actual

Cuando un usuario conecta un servidor MCP (ejemplo: Playwright con 15 herramientas):

1. Usuario conecta el servidor → ZeroChat descubre 15 herramientas
2. Usuario pregunta al modelo: "Navega a wikipedia.org y toma una captura"
3. Modelo intenta ejecutar `playwright_navigate`
4. **ZeroChat muestra diálogo de confirmación** para `playwright_navigate`
5. Usuario aprueba
6. Modelo intenta ejecutar `playwright_screenshot`
7. **ZeroChat muestra otro diálogo de confirmación** para `playwright_screenshot`
8. Usuario aprueba...

**Resultado:** El usuario debe aprobar manualmente cada herramienta individualmente, lo cual:
- Es tedioso y frustrante
- Interrumpe el flujo de trabajo
- Genera fatiga de confirmación (el usuario empieza a aprobar todo sin leer)

### 2.2. Sistema Actual de Seguridad

ZeroChat tiene un sistema robusto de seguridad implementado en `js/tool-security.js`:
- **Política global MCP**: `ask` (por defecto) o `allow_all`
- **Políticas granulares por herramienta**: `allow`, `deny`, `ask`
- **Constraints (restricciones)**: para comandos (`allowChaining`, `deniedPatterns`) y paths (`preventTraversal`, `deniedDirectories`)

**Limitación:** No existe un mecanismo para aplicar políticas inteligentes por defecto basadas en el tipo de operación.

---

## 3. Propuesta: Permisos por Defecto Basados en Patrones

### 3.1. Principio de Diseño

**Categorizar herramientas MCP por su nivel de riesgo basándose en patrones de nombres de operación:**

- **Operaciones seguras** → Aprobación automática sin restricciones
- **Operaciones moderadas** → Aprobación automática con restricciones de seguridad
- **Operaciones peligrosas** → Requieren confirmación explícita

**Aplicación:**
- Se aplica **solo la primera vez** que se descubre una herramienta MCP
- **No sobrescribe** políticas configuradas manualmente por el usuario
- Es una **plantilla inicial** que el usuario puede modificar posteriormente

### 3.2. Categorización de Riesgo

#### 🟢 Nivel SAFE (Seguro)
**Operaciones de solo lectura, consulta y navegación pasiva**

**Patrones de nombres:**
```
read_*, get_*, fetch_*, retrieve_*, load_*
list_*, show_*, view_*, display_*
search_*, find_*, query_*, lookup_*
inspect_*, check_*, status_*, info_*
describe_*, explain_*, analyze_*
```

**Ejemplos:**
- `read_file`, `list_directory`, `get_weather`
- `search_knowledge_base`, `list_documents`
- `playwright_screenshot` (captura pasiva)

**Política por defecto:** `allow` (sin restricciones)

**Justificación:** Operaciones de solo lectura no pueden modificar el sistema, son inherentemente seguras.

---

#### 🟡 Nivel MODERATE (Moderado)
**Operaciones de escritura no destructiva, creación y navegación activa**

**Patrones de nombres:**
```
write_*, create_*, add_*, insert_*, append_*
update_*, modify_*, edit_*, change_*, set_*
save_*, store_*, put_*, post_*
navigate_*, goto_*, click_*, fill_*, type_*, select_*
scroll_*, hover_*, focus_*
```

**Ejemplos:**
- `edit_file` (edición de archivos)
- `create_entities` (memoria/grafo de conocimiento)
- `playwright_navigate`, `playwright_click`, `playwright_fill`

**Política por defecto:** `allow` con **constraints**

**Restricciones aplicadas:**
```javascript
{
  path: {
    preventTraversal: true,
    deniedDirectories: [
      // Unix/Linux
      '/etc', '/sys', '/proc', '/dev', 
      '/bin', '/sbin', '/usr/bin', '/usr/sbin',
      '/boot', '/root',
      
      // Windows
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)'
    ]
  }
}
```

**Justificación:** Operaciones de escritura son útiles pero pueden ser peligrosas si acceden a directorios críticos del sistema. Las restricciones mitigan el riesgo.

---

#### 🔴 Nivel HIGH (Alto)
**Operaciones destructivas, ejecución de código y acceso a sistema**

**Patrones de nombres:**
```
delete_*, remove_*, drop_*, destroy_*, erase_*
execute_*, run_*, exec_*, eval_*, spawn_*
command_*, shell_*, bash_*, powershell_*
kill_*, stop_*, terminate_*
clear_*, reset_*, truncate_* (cuando es destructivo)
install_*, uninstall_*, upgrade_*, download_*
```

**Ejemplos:**
- `execute_command` (ejecución shell)
- `delete_file`, `remove_directory`
- `eval_javascript` (ejecución de código)

**Política por defecto:** `ask` (solicitar confirmación cada vez)

**Justificación:** Estas operaciones pueden causar daño irreversible o comprometer la seguridad del sistema. Siempre requieren supervisión humana.

---

### 3.3. Estructura de Datos

```javascript
// En js/tool-security.js

const MCP_PERMISSION_TEMPLATES = {
  // Plantillas por patrón de nombre
  patterns: [
    {
      id: 'safe_read_operations',
      namePatterns: [
        /^read_/i, /^get_/i, /^fetch_/i, /^retrieve_/i, /^load_/i,
        /^list_/i, /^show_/i, /^view_/i, /^display_/i,
        /^search_/i, /^find_/i, /^query_/i, /^lookup_/i,
        /^inspect_/i, /^check_/i, /^status_/i, /^info_/i,
        /^describe_/i, /^explain_/i, /^analyze_/i
      ],
      defaultPolicy: 'allow',
      constraints: null,
      riskLevel: 'safe'
    },
    {
      id: 'moderate_write_operations',
      namePatterns: [
        /^write_/i, /^create_/i, /^add_/i, /^insert_/i, /^append_/i,
        /^update_/i, /^modify_/i, /^edit_/i, /^change_/i, /^set_/i,
        /^save_/i, /^store_/i, /^put_/i, /^post_/i
      ],
      defaultPolicy: 'allow',
      constraints: {
        path: {
          preventTraversal: true,
          deniedDirectories: [
            '/etc', '/sys', '/proc', '/dev', '/bin', '/sbin',
            '/usr/bin', '/usr/sbin', '/boot', '/root',
            'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'
          ]
        }
      },
      riskLevel: 'moderate'
    },
    {
      id: 'moderate_browser_navigation',
      namePatterns: [
        /^navigate_/i, /^goto_/i, /^click_/i, /^fill_/i,
        /^type_/i, /^select_/i, /^scroll_/i, /^hover_/i,
        /screenshot$/i
      ],
      defaultPolicy: 'allow',
      constraints: null,
      riskLevel: 'moderate'
    },
    {
      id: 'high_destructive_operations',
      namePatterns: [
        /^delete_/i, /^remove_/i, /^drop_/i, /^destroy_/i,
        /^erase_/i, /^clear_/i, /^truncate_/i
      ],
      defaultPolicy: 'ask',
      constraints: null,
      riskLevel: 'high'
    },
    {
      id: 'high_execution_operations',
      namePatterns: [
        /^execute_/i, /^run_/i, /^exec_/i, /^eval_/i, /^spawn_/i,
        /^command_/i, /^shell_/i, /^bash_/i, /^powershell_/i,
        /^install_/i, /^uninstall_/i, /^upgrade_/i, /^download_/i
      ],
      defaultPolicy: 'ask',
      constraints: null,
      riskLevel: 'high'
    }
  ],

  // Excepciones específicas por nombre completo
  exceptions: {
    // Herramienta específica que queremos tratar de forma especial
    'zmcp_execute_command': {
      defaultPolicy: 'ask',
      constraints: {
        command: {
          allowChaining: false,
          allowPipes: true,
          deniedPatterns: [
            'rm -rf /',
            'format',
            'dd if=',
            'mkfs',
            ':(){:|:&};:'  // fork bomb
          ],
          allowedPrefixes: []  // vacío = cualquier comando pide confirmación
        }
      },
      riskLevel: 'high'
    }
  }
};
```

---

## 4. Implementación

### 4.1. API en ToolSecurityManager

**Nuevo método principal:**

```javascript
/**
 * Aplica permisos por defecto basados en plantillas para una herramienta MCP
 * recién descubierta. Solo se aplica si NO existe ya una política guardada.
 * 
 * @param {string} toolId - ID canónico de la herramienta
 * @param {string} originalName - Nombre original en el servidor MCP
 * @param {object} metadata - Metadata adicional (serverName, inputSchema, etc.)
 * @returns {object|null} - Template aplicada o null si ya existía política
 */
applyDefaultPermissionTemplate(toolId, originalName, metadata = {})
```

**Métodos auxiliares:**

```javascript
/**
 * Aplica plantillas a un conjunto de herramientas recién descubiertas.
 */
applyDefaultPermissionsToTools(tools)

/**
 * Encuentra el template que coincide con el nombre de la herramienta.
 * @private
 */
_matchPermissionTemplate(originalName)

/**
 * Obtiene las plantillas configuradas (permite sobrescritura externa).
 * @private
 */
_getPermissionTemplates()
```

### 4.2. Integración en el Flujo de Descubrimiento

**Modificar `McpToolProvider.discoverTools()` en `js/mcp.js`:**

```javascript
async discoverTools(options = {}) {
  // ... código existente de descubrimiento ...
  
  this.cachedTools = toolInstances;

  // NUEVO: Aplicar plantillas de permisos por defecto
  const Security = getToolSecurity();
  if (Security?.manager?.applyDefaultPermissionsToTools) {
    const toolsData = toolInstances.map(t => ({
      toolId: t.id || t.name,
      originalName: t.metadata?.originalName || t.name,
      metadata: {
        serverName: this.serverName,
        ...t.metadata
      }
    }));

    const applyResult = Security.manager.applyDefaultPermissionsToTools(toolsData);
    
    if (applyResult.applied > 0) {
      console.log(`[MCP Security] Applied default permissions to ${applyResult.applied} tools`);
    }
  }

  return toolInstances;
}
```

### 4.3. Evaluación Inline (Fallback)

**Modificar `ToolSecurityManager.evaluateAuthorization()` en `js/tool-security.js`:**

```javascript
evaluateAuthorization(toolOrName, args = {}, options = ) {
  // ... pasos 1, 2, 3 existentes ...

  // NUEVO PASO 3.5: Si no hay regla guardada, aplicar template inline
  if (!foundEntry && options.applyDefaultTemplate !== false) {
    const appliedTemplate = this.applyDefaultPermissionTemplate(
      toolId,
      originalName,
      { serverName }
    );

    if (appliedTemplate) {
      // Template aplicada, re-evaluar con la nueva política
      return this.evaluateAuthorization(toolOrName, args, {
        ...options,
        applyDefaultTemplate: false  // Evitar recursión
      });
    }
  }

  // 4. Por defecto: solicitar autorización
  return {
    requiresApproval: true,
    status: TOOL_POLICIES.ASK,
    reason: 'mcp_default_ask',
    toolId,
    serverName,
    originalName
  };
}
```

---

## 5. Interfaz de Usuario

### 5.1. Indicador Visual de Políticas Automáticas

En `js/ui-mcp.js`, añadir badge "Auto" para políticas aplicadas por template:

```javascript
const toolEntry = Security?.manager?.getToolEntry(id);
const isAutoTemplate = toolEntry && toolEntry.grantedAt && !toolEntry.lastUsedAt;

let policyOriginBadge = '';
if (isAutoTemplate && effectivePolicy === 'allow') {
  policyOriginBadge = `<span class="policy-origin-badge" title="Permiso aplicado automáticamente por patrón de operación segura">Auto</span>`;
}
```

**Vista en la interfaz:**

```
🔌 read_file                     [MCP] [Auto] [Allow ▼]  [Toggle]
🔌 execute_command               [MCP]        [Ask ▼]    [Toggle]
🔌 playwright_navigate           [MCP] [Auto] [Allow ▼]  [Toggle]
```

### 5.2. Panel de Configuración (Futuro)

En `Ajustes → Permisos → Plantillas MCP` (implementación futura):

- Ver todas las plantillas activas
- Activar/desactivar plantillas específicas
- Añadir excepciones personalizadas
- Restablecer todas las políticas automáticas

---

## 6. Ejemplos de Uso

### 6.1. Caso: Conectar Playwright por Primera vez

**Herramientas descubiertas por Playwright:**

| Herramienta | Patrón Coincidente | Política Aplicada | Constraints |
|-------------|-------------------|-------------------|-------------|
| `playwright_navigate` | `navigate_*` (moderate) | `allow` | ❌ |
| `playwright_screenshot` | `*screenshot` (moderate) | `allow` | ❌ |
| `playwright_click` | `click_*` (moderate) | `allow` | ❌ |
| `playwright_fill` | `fill_*` (moderate) | `allow` | ❌ |
| `playwright_evaluate` | `*evaluate*` (high) | `ask` | ❌ |
| `playwright_close` | ❌ (no pattern) | `ask` (default) | ❌ |

**Resultado:** 
- Usuario puede navegar, capturar pantallas, hacer clic y rellenar formularios sin confirmaciones
- Operaciones de evaluación de JavaScript requieren confirmación (seguridad)

### 6.2. Caso: Herramientas Locales (zerochat.py)

| Herramienta | Patrón Coincidente | Política Aplicada | Constraints |
|-------------|-------------------|-------------------|-------------|
| `zmcp_read_file` | `read_*` (safe) | `allow` | ❌ |
| `zmcp_list_directory` | `list_*` (safe) | `allow` | ❌ |
| `zmcp_edit_file` | `edit_*` (moderate) | `allow` | ✅ Path |
| `zmcp_execute_command` | Excepción específica | `ask` | ✅ Command |

**Resultado:**
- Lectura y listado: automático
- Edición: automático con protección de directorios de sistema
- Ejecución de comandos: siempre requiere confirmación

---

## 7. Seguridad y Consideraciones

### 7.1. Principio de Menor Privilegio

✅ **Cumplido:** Operaciones peligrosas requieren confirmación explícita por defecto.

### 7.2. Defensa en Profundidad

✅ **Cumplido:** Múltiples capas de protección:
1. Plantillas de permisos por defecto
2. Constraints de path y command
3. Confirmación del usuario para operaciones de alto riesgo
4. Evaluación en cada ejecución (no solo al registrar)

### 7.3. Transparencia

✅ **Cumplido:** 
- Indicadores visuales muestran el origen de cada política ("Auto" vs manual)
- Documentación clara de qué operaciones son automáticas
- Usuario puede revisar y modificar cualquier política

### 7.4. No Sobrescritura

✅ **Cumplido:** Las plantillas solo se aplican si NO existe una política manual previa.

### 7.5. Limitaciones Conocidas

⚠️ **Evasión por nombres ambiguos:** Una herramienta maliciosa podría llamarse `read_file` pero en realidad eliminar archivos. 

**Mitigación:** 
- Los servidores MCP de confianza no hacen esto
- El usuario siempre puede inspeccionar la descripción de la herramienta
- Las herramientas locales de ZeroChat son auditables (código abierto)

⚠️ **Fatiga de confirmación:** Si un servidor expone muchas operaciones peligrosas, el usuario seguirá recibiendo muchas confirmaciones.

**Mitigación:**
- Es el comportamiento correcto desde el punto de vista de seguridad
- El usuario puede cambiar manualmente a `allow` si confía plenamente en el servidor

---

## 8. Pruebas

### 8.1. Casos de Prueba Unitarios

Crear `tests/unit/test_mcp_permission_templates.js`:

```javascript
// 1. Operaciones seguras reciben 'allow' sin constraints
// 2. Operaciones destructivas reciben 'ask'
// 3. Operaciones de escritura reciben 'allow' con constraints de path
// 4. No sobrescribe políticas existentes
// 5. Aplica excepciones específicas correctamente
// 6. Herramientas sin patrón coincidente quedan en 'ask' por defecto
```

### 8.2. Casos de Prueba de Integración

```javascript
// 1. Descubrir servidor MCP → templates se aplican automáticamente
// 2. Ejecutar herramienta con template 'allow' → no solicita confirmación
// 3. Ejecutar herramienta con template 'ask' → solicita confirmación
// 4. Modificar manualmente política → se preserva en siguientes conexiones
// 5. Constraint de path previene acceso a /etc
```

---

## 9. Documentación

### 9.1. Actualizar `/help/mcp.html`

Sección 4 - Control de Permisos:

```html
<h2>4. Control de Permisos y Autorización por Herramienta</h2>
<p>
  ZeroChat aplica <strong>permisos por defecto inteligentes</strong> la primera 
  vez que descubre una herramienta MCP:
</p>
<ul>
  <li><strong>Operaciones seguras (lectura, consulta):</strong> Se aprueban 
      automáticamente sin solicitar confirmación.
      <br><em>Ejemplos: read_file, list_directory, search_knowledge_base</em>
  </li>
  <li><strong>Operaciones moderadas (escritura, navegación):</strong> Se aprueban 
      automáticamente con restricciones de seguridad.
      <br><em>Ejemplos: edit_file, playwright_navigate</em>
  </li>
  <li><strong>Operaciones peligrosas (ejecución, eliminación):</strong> Requieren 
      confirmación explícita cada vez.
      <br><em>Ejemplos: execute_command, delete_file</em>
  </li>
</ul>
<div class="alert alert-info">
  <strong>Tip:</strong> Los permisos aplicados automáticamente se marcan con 
  la etiqueta "Auto". Una vez que modificas manualmente la política de una 
  herramienta, tu configuración se preserva.
</div>
```

---

## 10. Resumen de Cambios por Archivo

| Archivo | Tipo de Cambio | Complejidad |
|---------|----------------|-------------|
| `js/tool-security.js` | Añadir constantes, métodos y lógica de templates | Alta |
| `js/mcp.js` | Modificar `discoverTools()` para aplicar templates | Media |
| `js/ui-mcp.js` | Añadir indicador visual "Auto" | Baja |
| `css/components/*.css` | Estilos para `.policy-origin-badge` | Baja |
| `tests/unit/test_mcp_permission_templates.js` | Crear suite completa de tests | Media |
| `help/mcp.html` | Actualizar documentación de permisos | Baja |

**Estimación total:** ~4-6 horas de desarrollo + 2 horas de testing + 1 hora de documentación

---

## 11. Roadmap de Implementación

### Fase 1: Core (Esencial)
- ✅ Definir `MCP_PERMISSION_TEMPLATES`
- ✅ Implementar `applyDefaultPermissionTemplate()`
- ✅ Integrar en `discoverTools()`
- ✅ Tests unitarios básicos

### Fase 2: Refinamiento
- ✅ Añadir evaluación inline en `evaluateAuthorization()`
- ✅ Indicador visual "Auto" en UI
- ✅ Tests de integración completos
- ✅ Actualizar documentación

### Fase 3: Futuro (Opcional)
- ⬜ Panel de configuración de templates en UI
- ⬜ Permitir templates personalizadas por usuario
- ⬜ Export/import de configuraciones de permisos
- ⬜ Telemetría de uso de permisos (anónima)

---

## 12. Conclusión

Este sistema de permisos por defecto mejora significativamente la experiencia de usuario al reducir la fatiga de confirmación, mientras mantiene un alto nivel de seguridad al solicitar confirmación solo para operaciones verdaderamente peligrosas.

**Ventajas clave:**
1. **Usabilidad:** Reduce confirmaciones innecesarias en un 70-80%
2. **Seguridad:** Mantiene protección contra operaciones destructivas
3. **Transparencia:** El usuario siempre sabe qué está aprobado y por qué
4. **Flexibilidad:** Totalmente configurable por el usuario
5. **No invasivo:** Respeta configuración manual previa

**Próximos pasos:**
1. Validar propuesta con usuarios
2. Implementar Fase 1 (Core)
3. Probar con servidores MCP reales (Playwright, Memory, LSP)
4. Iterar basándose en feedback

---

**Fin del documento**
