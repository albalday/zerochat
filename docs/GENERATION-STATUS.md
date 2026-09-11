# Indicador de Progreso de Generación (Generation Status)

`ChatUIGenerationStatus` es una **infraestructura general** para presentar información breve sobre la actividad en curso en la interfaz del chat, ubicada en la fila superior del compositor junto a las acciones principales.

## Principio de diseño y ciclo de visibilidad

El indicador comparte de forma directa y unívoca el ciclo de vida de la generación (`isGenerating`):

1. **Visible únicamente durante un ciclo de chat activo (`isGenerating: true`)**:
   - Se activa al iniciar el envío o inferencia (`handleSendMessage`).
   - Permanece visible mientras los diferentes módulos del sistema (proveedores de IA, preparación de contexto RAG, ejecución de herramientas/agente, razonamiento, etc.) anuncian estados o mensajes breves de progreso.
2. **Invisible cuando no se está procesando un ciclo de chat (`isGenerating: false`)**:
   - Se oculta de forma automática e inmediata al finalizar o cancelar la generación (`finishGeneration`, interrupción del usuario, error terminal).
   - Las llamadas a anunciar progreso fuera de un ciclo activo se ignoran y no reactivan el indicador.
   - La visibilidad no depende de que un proveedor emita una señal de finalización específica.

## Naturaleza de infraestructura general

Cualquier módulo del sistema puede reportar progreso sin restricciones artificiales ni acoplamiento a proveedores concretos:

- **Proveedores de IA**: emisión de fases de conexión, carga o preparación de pesos/modelos (ej. WebLLM), razonamiento/pensamiento o inicio de generación.
- **RAG / Contexto**: anuncio de recuperación de fragmentos o preparación de contexto semántico.
- **Herramientas / Agente**: anuncio de ejecución de herramientas locales o remotas (ej. *"Ejecutando calculator..."*).
- **Módulos extensibles o futuros**: cualquier subsistema puede enviar mensajes de progreso descriptivos.

## Contrato de eventos

Los emisores pueden notificar el progreso a través de callbacks (`onGenerationStatus`), mediante `ChatApp.setGenerationStatus(...)` o mediante el mutador de estado `ChatState.setGenerationStatus(...)`:

### Formatos admitidos

1. **Mensaje de texto directo (string)**:
   ```js
   onGenerationStatus('Buscando en documentos...');
   ```
2. **Objeto con texto o mensaje libre**:
   ```js
   onGenerationStatus({ text: 'Ejecutando herramienta...' });
   ```
3. **Objeto estructurado con fase y detalles opcionales**:
   ```js
   onGenerationStatus({ phase: 'tool', text: 'Ejecutando web_search...' });
   onGenerationStatus({ phase: 'loading', percent: 45 });
   onGenerationStatus({ phase: 'thinking' });
   ```

### Atributos

- `text` / `message`: Mensaje breve descriptivo a presentar al usuario. Si se proporciona, se muestra directamente.
- `phase`: Fase opcional (`'generating'`, `'thinking'`, `'loading'`, `'preparing'`, `'connecting'`, `'rag'`, `'tool'` o cualquier identificador personalizado). Si se especifica una fase estándar sin texto, se utilizan los textos traducidos de `ChatI18n`. Si se pasa `'idle'`, el indicador se considera inactivo y se oculta.
- `percent`: Valor numérico opcional (0-100) para operaciones con progreso medible.
- `detail`: Metadatos opcionales de diagnóstico (nunca interpretados como HTML).
- `startedAt`: Marca de tiempo para cálculo de tiempo transcurrido (por ejemplo, durante la fase de razonamiento).

## Reglas de seguridad e internacionalización

- Todo texto mostrado se escapa como texto plano mediante `textContent` en el DOM; nunca se interpreta HTML no confiable.
- Los mensajes fijos de la aplicación deben utilizar claves de `ChatI18n` (español e inglés simultáneamente).
- El estado es efímero (`ChatState.ui.generationStatus`) y nunca se persiste en IndexedDB ni en el historial de mensajes o perfiles.
