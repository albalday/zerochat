# Límites del historial sin borrado (M63-T6)

Borrador para decidir. Mide qué cuesta que el historial crezca sin borrarse nunca y propone qué acotar.

## Cómo se ha medido

`node scripts/bench-history.js [conversaciones] [mensajes] [caracteres]` arranca `zerochat.py` con un
directorio de datos temporal, guarda las conversaciones repartidas en 10 proyectos (una de cada once sin
proyecto) y abre la interfaz servida por el propio servidor en Chromium. Mide en el PC de desarrollo,
con servidor y navegador en la misma máquina, sin la latencia del túnel de la tablet.

Referencia real (13-11-2026): 8 conversaciones, 114 mensajes, 1,2 KB de media por mensaje, 0,3 MB de SQLite.

## Resultados

| Medida | 2000 × 20 msg × 400 car. | 10 000 × 20 msg × 400 car. |
|---|---|---|
| SQLite en disco | 18,5 MB | 92,6 MB |
| `conversations/list` (cabeceras) | 13 ms, 0,4 MB | 39 ms, 1,9 MB |
| Primera carga en un navegador nuevo (IndexedDB vacía) | 10,9 s, 2000 `conversations/get` | 76,5 s, 10 000 `conversations/get` |
| Carga siguiente, ya sincronizada | 0,3 s, ninguna descarga | 0,4 s, ninguna descarga |
| IndexedDB del navegador | 7,8 MB | 25,7 MB |
| Pintado de la barra, vista del proyecto | 38 ms, 9 785 nodos | 166 ms, 49 097 nodos |
| Pintado de la barra, vista de todos (plegada) | 140 ms, 54 088 nodos | 693 ms, 270 088 nodos |
| Pintado de la barra, búsqueda "5" | 48 ms, 14 689 nodos | 317 ms, 92 908 nodos |

Con mensajes reales (1,2 KB de media, más salidas de herramientas) el disco y la primera carga crecen
en proporción: unas tres veces lo medido.

## Qué limita y qué no

1. **SQLite y `conversations/list` aguantan.** 10 000 conversaciones son menos de 100 MB y la lista de
   cabeceras tarda 39 ms. No hace falta borrar nada para que el servidor funcione.
2. **La primera carga en un dispositivo nuevo es el cuello de botella.** `getConversationsList` descarga
   entera, una a una, cada conversación nueva o cambiada antes de devolver la lista, y la barra sigue vacía
   hasta que termina. Son 11 s con 2000 y 77 s con 10 000 en local. Por el túnel SSH de la tablet hay que
   sumar la latencia de cada petición, que también se paga en cada dispositivo después de una temporada sin abrirlo.
3. **La barra pinta todas las conversaciones.** La vista de todos pinta también las de los grupos plegados
   (ocultas, fallo de M63-T4): 270 000 nodos y 0,7 s con 10 000. Se repinta en cada guardado de un turno,
   en cada tecla del buscador y cuando cambian las ejecuciones en servidor. En la tablet será varias veces más lento.
4. **IndexedDB no es problema de cuota** (26 MB con 10 000), pero es una copia completa por navegador.

## Propuesta

Por orden de beneficio y coste; cada punto sería una tarea de M63.

- **A. No pintar los grupos plegados** (recomendado, pequeño). Al desplegar se pinta ese grupo. La vista
  de todos pasa a costar lo que el proyecto actual más las cabeceras.
- **B. Tope de conversaciones pintadas por grupo** (recomendado, pequeño). Se muestran las 50 más
  recientes de cada grupo y un botón "Mostrar N más". La búsqueda sigue recorriendo todos los títulos, que
  ya están en memoria. Con A y B la barra queda acotada sea cual sea el tamaño del historial (prueba en el
  borde: 50 y 51).
- **C. Sincronizar solo cabeceras y bajar los mensajes al abrir** (recomendado, mediano). La lista aparece
  en cuanto llega `conversations/list` (0,4 s con 10 000) y cada conversación se descarga al abrirla. Cambia
  la premisa de M62-D4 ("la sincronización descarga todas"): sin servidor solo se podrían abrir las
  conversaciones ya abiertas antes en ese navegador. Alternativa intermedia: mostrar la lista con las
  cabeceras y descargar el resto en segundo plano por lotes, sin bloquear la barra.
- **D. Sin borrado automático por ahora.** Los datos no lo exigen. Si se quiere limpiar, es mejor dar
  herramientas al usuario que borrar por antigüedad sin preguntar: "Borrar las conversaciones de este
  proyecto" en el menú de la cabecera de proyecto y, si hace falta, "Borrar las de hace más de N meses".

## Decisión (13-11-2026)

A, B y C (descarga al abrir) hechos en M63-T7, T8 y T10. D: sin borrado automático; el botón de borrar el
historial pregunta por el proyecto actual o por todo (M63-T9). Con 2000 conversaciones, tras los cambios:
primera carga 0,3 s sin ninguna descarga (antes 10,9 s), IndexedDB 2,7 MB (antes 7,8 MB) y barra de 1 400
nodos en la vista de todos (antes 54 000).
