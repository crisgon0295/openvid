---
id: SPEC-003
title: Los efectos de sonido no deben silenciar la voz del video
status: implemented
owner: crisgon0295
methodology: ASDD (Agentic Spec-Driven Development) — Why · Decisions · Plan · Tasks
created: 2026-11-14
---

# SPEC-003 — Efectos de sonido sin silenciar la voz

## Why

Al agregar un efecto de sonido nativo (p. ej. `success.wav`) a la línea de tiempo, la voz del video dejaba de oírse; al borrar el efecto, volvía.

### Causa raíz (comportamiento heredado del proyecto original)

`hooks/useAudioTracks.ts` activaba `muteOriginalAudio = true` al agregar la **primera** pista de audio por cualquiera de sus tres rutas (subir archivo, agregar efecto/audio de la biblioteca, confirmar recorte) y lo volvía a `false` al borrar la última pista. Fue pensado para música de fondo que reemplaza el sonido, pero con efectos borra la voz. Además, la interfaz no tenía ningún control para revertirlo (`onToggleMuteOriginalAudio` llegaba a `ControlPanel` pero nunca se usaba).

## Decisions

- **D1** — Las pistas de audio se **superponen** al audio del video; nunca lo silencian automáticamente.
- **D2** — El usuario decide con un interruptor visible "Audio original del video" en el panel de Audio (rojo cuando está silenciado).
- **D3** — La exportación ya mezcla audio original + pistas y respeta el mismo estado (`useVideoExport`: `hasOriginalAudio = !muteOriginalAudio && …`), sin cambios.
- **D4** — Proyectos guardados con `muteOriginalAudio = true` conservan ese estado; el interruptor permite reactivarlo.

## Plan / Tasks

- [x] T1 Quitar el silenciado automático (3 rutas) y el des-silenciado automático al borrar
- [x] T2 `AudioMenuProps.muteOriginalAudio` / `onToggleMuteOriginalAudio`, conectados en `ControlPanel`
- [x] T3 Interruptor en `AudioMenu`
- [x] T4 Verificación en el editor con la grabación real del usuario

## Criterios de aceptación y resultados (2026-11-14)

| AC | Criterio | Resultado |
|----|----------|-----------|
| AC1 | Con un efecto en la línea de tiempo, el video sigue con audio durante la reproducción | ✅ 1 pista; `muted=false` en 4 muestras (0.6–2.5 s) |
| AC2 | El interruptor silencia y reactiva la voz | ✅ apagado → `muted=true` ("Silenciado"); encendido → `muted=false` ("Activo") |
| AC3 | La exportación mezcla voz + efectos cuando el audio original está activo | ✅ por revisión de código (sin cambios en `useVideoExport`) |
| AC4 | Build sin errores | ✅ |
