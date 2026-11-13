---
id: SPEC-001
title: Fiabilidad de grabación (cámara, recarga tras grabar, audio)
status: implemented (pendiente validación del usuario: AC5, AC6, T7)
owner: crisgon0295
methodology: ASDD (Agentic Spec-Driven Development) — Why · Decisions · Plan · Tasks
created: 2026-11-13
base: CristianOlivera1/openvid@3cf6c8a (upstream sin commits nuevos)
fork-commits-audited: 518429c, 93b3d97, 85d8b8b, 6239897
---

# SPEC-001 — Fiabilidad de grabación

## Why

Tres síntomas reportados por el usuario tras grabar pantalla + cámara + micrófono:

1. **Cámara congelada** en el editor y **negra** en el video exportado (la pantalla sí funciona).
2. Al terminar una grabación la app **"se queda pensando" e intenta recargar la página**.
3. **Sonido de interferencia** al reproducir en el editor.

### Evidencia (reproducida, no supuesta)

| # | Prueba | Resultado |
|---|--------|-----------|
| E1 | `ffprobe`/`freezedetect` sobre las cámaras grabadas (14:44, 15:55, 15:56, 15:57) | 30 fps, 0 tramos congelados → **la grabación está bien** |
| E2 | Editor real con la grabación de 15:57 inyectada en IndexedDB | `<video>` de cámara: `readyState=1`, `seeking=true` para siempre, `error = PIPELINE_ERROR_DECODE: video decode error!` |
| E3 | Mismo archivo de cámara reproducido solo en Chrome (fuera del editor) | Falla a los 0.04–0.26 s → no es culpa del editor ni de la sincronización |
| E4 | `ffmpeg -c copy` (remux sin cambios) | Sigue fallando → no es culpa de mediabunny |
| E5 | `ffmpeg -bsf:v vp9_metadata=color_range=tv` (solo cambia la bandera de rango) | **Reproduce perfecto** |
| E6 | `ffprobe` cámara vs pantalla | cámara `vp9 color_range=pc` (rango completo de la webcam); pantalla `color_range=tv` |
| E7 | Editor: interceptación de todos los `play()` y `createMediaElementSource` | Un único elemento audible → el editor **no** duplica audio |
| E8 | Espectrograma del audio 14:44 vs 15:57 | 15:57: piso de ruido −36 dB constante en todo el espectro y voz débil; 14:44: piso −65 dB, voz limpia → el ruido **está en el archivo grabado** |
| E9 | Diff de audio del grabador contra upstream | Sin cambios → no lo introdujo el fork |
| E10 | Código `useScreenRecording.finalize` | En `/editor` hace `window.location.reload()` mientras `state === "processing"`; el aviso `beforeunload` (añadido en 93b3d97) **bloquea esa recarga** con el diálogo "¿Volver a cargar el sitio?" |

### Causas raíz

- **RC1 (cámara)**: las webcams entregan YUV de rango completo; el MediaRecorder VP9 de Chrome marca cada keyframe como `color_range=pc` y el decodificador VP9 (por hardware) de Chrome en este equipo no puede reproducirlo. Afecta vista previa (congelada en el primer cuadro) y exportación (el canvas dibuja un video sin cuadro → negro). Las hipótesis anteriores del fork (keyframes escasos, remount del elemento) no eran la causa principal.
- **RC2 (recarga)**: regresión propia del fork (93b3d97): el `beforeunload` también estaba activo durante la recarga programática del final del procesamiento.
- **RC3 (audio)**: el ruido viene de la señal del micrófono/mezcla en el momento de grabar, no del editor ni del código. Causa exacta del lado del sistema aún no identificada (ver D4).

## Decisions

- **D1** — Corregir RC1 re-etiquetando los keyframes VP9 a rango limitado (cambio de 1 bit por keyframe, sin re-codificar, ~30 ms para 20 s), equivalente a `vp9_metadata=color_range=tv`. Se descarta re-codificar (lento en navegador) y cambiar a VP8/H.264 (no verificable sin webcam en pruebas y H.264 en WebM no es universal).
- **D2** — Aplicar D1 en dos puntos: (a) al terminar cada grabación, (b) al cargar grabaciones ya guardadas en IndexedDB (migración automática y persistente) para arreglar también las grabaciones existentes.
- **D3** — Mantener el aviso `beforeunload` durante la grabación (protege la toma), pero desactivarlo justo antes de la navegación/recarga programática del final del procesamiento.
- **D4** — Audio: no se aplica un filtro a ciegas. Se documenta la evidencia y se pide al usuario una prueba A/B (con y sin "audio del sistema", y revisar mejoras/realce de micrófono en Windows). Si el ruido persiste solo con micrófono, la siguiente iteración (SPEC-002) añade una puerta de ruido/filtro opcional en la mezcla.
- **D5** — Burbuja durante la grabación: el original la oculta a propósito (si grabas la misma pestaña aparecería duplicada en el video). Se mantiene; una ventana flotante Picture-in-Picture opcional queda para SPEC-002.

## Plan

1. Módulo `lib/vp9-range-fix.ts`: lector de bits del encabezado VP9, detección/parche de `color_range` en keyframes, re-muxeo de paquetes con mediabunny (`EncodedPacketSink` → `EncodedVideoPacketSource`), `decoderConfig.colorSpace.fullRange=false`.
2. `useScreenRecording.finalize`: tras normalizar, pasar la cámara por `fixFullRangeVp9` (si devuelve `null`, no hay nada que corregir).
3. `loadVideoFromIndexedDB`/migración: corregir `cameraBlob` antiguos y guardarlos de vuelta.
4. `beforeunload`: ref `allowUnloadRef` que se activa antes de `reload()`/`router.push()`.
5. Verificación en el navegador integrado con la grabación real del usuario (preview, seek, export).

## Tasks

- [x] T1 Reproducir los 3 síntomas con datos reales (E1–E10)
- [x] T2 Prototipo de corrección de cámara validado (E5 y prueba del módulo: seek a 12 s y reproducción OK)
- [x] T3 Integrar D1 al terminar la grabación (+ fix: la cámara ya no se pierde si su normalización falla)
- [x] T4 Migrar cámaras ya guardadas: en `loadVideoFromIndexedDB` y centralizado en `getCameraBlob` (cubre proyecto guardado y biblioteca)
- [x] T5 Corregir el bloqueo de recarga (D3) con `allowUnloadRef`
- [x] T6 Verificar criterios de aceptación y subir al fork
- [ ] T7 Prueba A/B de audio por el usuario (D4) → abrir SPEC-002 si aplica

## Criterios de aceptación

- **AC1** Con la grabación real de 15:57 cargada en el editor, al dar play la cámara avanza junto con la pantalla (diferencia < 0.5 s) y su `<video>` no tiene `error`.
- **AC2** Al mover el cabezal a cualquier punto, la cámara muestra el cuadro correcto (seek completa, `seeking=false`).
- **AC3** El archivo de cámara corregido reproduce en Chrome sin `PIPELINE_ERROR_DECODE`.
- **AC4** Una grabación que ya estaba guardada (sin corregir) se corrige sola al abrir el editor y queda guardada corregida.
- **AC5** Al terminar una grabación estando en el editor no aparece el diálogo "¿Volver a cargar el sitio?" y el editor abre la nueva toma.
- **AC6** Cerrar la pestaña *durante* la grabación sigue mostrando el aviso.
- **AC7** El build de producción compila sin errores de tipos.

## Resultados de verificación (2026-11-13, navegador integrado, build de producción)

| AC | Resultado | Evidencia |
|----|-----------|-----------|
| AC1 | ✅ | 5 muestras en reproducción: cámara 1.20/2.41/3.62/4.83/6.03 s vs pantalla 1.15/2.36/3.56/4.77/5.98 s; `error=null`, `readyState=4` (antes: cámara fija en 0.00 s, `PIPELINE_ERROR_DECODE`) |
| AC2 | ✅ | Seek a 15 s: cámara 15.00 s, `seeking=false` |
| AC3 | ✅ | Archivo corregido: carga, seek a 12 s y reproduce hasta 15 s sin error; corrección en 32 ms |
| AC4 | ✅ | El blob de cámara guardado pasó de `color_range=1` a `0` tras abrir el editor una vez |
| Export | ✅ | `drawImage` del video de cámara a canvas (mismo camino que la exportación): brillo medio 118.6/255 (antes negro) |
| AC5 | ⚠️ por revisión de código | Requiere grabar con `getDisplayMedia` (selector del sistema); validar en la próxima grabación del usuario |
| AC6 | ⚠️ por revisión de código | Ídem |
| AC7 | ✅ | `tsc --noEmit` sin errores; `pnpm build` OK |
