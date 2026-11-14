---
id: SPEC-002
title: Reducción de ruido IA en el micrófono
status: implemented (pendiente validación del usuario en una grabación real)
owner: crisgon0295
methodology: ASDD (Agentic Spec-Driven Development) — Why · Decisions · Plan · Tasks
created: 2026-11-14
depends-on: SPEC-001 (D4, T7)
---

# SPEC-002 — Reducción de ruido IA en el micrófono

## Why

SPEC-001 (E8) demostró que la "interferencia" que el usuario escucha en el editor **ya está en el audio grabado**: en la grabación de 15:57 el ruido de fondo es constante en todo el espectro (piso ≈ −48 dB) y la voz queda enmascarada, mientras que en la de 14:44 el piso era ≈ −65 dB. La supresión de ruido nativa de Chrome (`noiseSuppression: true`) ya estaba activa y no fue suficiente. El usuario pidió añadir reducción de ruido.

## Decisions

- **D1** — Usar **RNNoise** (red neuronal de Xiph/Mozilla, vía `@sapphi-red/web-noise-suppressor` 0.3.5, MIT) en un AudioWorklet: elimina ruido estacionario también *mientras se habla*, a diferencia de una puerta de ruido. Corre 100 % en el equipo (sin servidores).
- **D2** — Cadena del micrófono: `highpass 80 Hz → RNNoise → ganancia → mezcla`. El contexto de mezcla se crea a **48 kHz** (requisito de RNNoise).
- **D3** — **Nunca perder la voz**:
  - Protección anti-silencio: si la entrada tiene sonido y la salida del filtro es silencio absoluto durante 1.5 s (p. ej. el wasm no cargó), se puentea el filtro automáticamente.
  - Si la mezcla a 48 kHz falla, se reintenta la mezcla normal sin filtro (antes un fallo de mezcla dejaba la grabación sin micrófono).
  - Si RNNoise no carga, queda solo el filtro pasa-altos.
- **D4** — Activada por defecto, con un interruptor "Reducción de ruido IA" en la sección Micrófono de la configuración de grabación. Las configuraciones ya guardadas la reciben activada.
- **D5** — Los archivos del worklet/wasm se sirven desde `public/noise-suppressor/` (Next.js no usa los imports `?url` de Vite); la ruta ya está excluida del middleware i18n por extensión.
- **D6** — Fuera de alcance: limpiar audio de grabaciones ya hechas (posible SPEC-003: "Mejorar audio" en el editor).

## Plan

1. `lib/audio/mic-denoise.ts`: `createMicDenoiseChain(ctx)` y `connectWithFailsafe(ctx, source, chain, target)`.
2. `useScreenRecording`: mezcla con `buildMix(useAiDenoise)` + reintento sin filtro; limpieza en `cleanupStreams`.
3. `MicrophoneConfig.aiNoiseReduction` (default `true`) + interruptor en `RecordingSetupDialog`.
4. Verificar con el audio ruidoso real del usuario (offline y en tiempo real) y la protección.

## Tasks

- [x] T1 Elegir motor (RNNoise) y servir sus archivos
- [x] T2 Medir con el audio real del usuario (offline)
- [x] T3 Integrar en la mezcla con protección y reintento
- [x] T4 Interruptor en la configuración
- [x] T5 Prueba en tiempo real y prueba de la protección
- [ ] T6 Validación del usuario en una grabación real con su micrófono

## Criterios de aceptación y resultados (2026-11-14)

| AC | Criterio | Resultado |
|----|----------|-----------|
| AC1 | El piso de ruido baja ≥ 12 dB en el audio ruidoso real | ✅ offline −48.1 → −68.9 dB; tiempo real −48.7 → −68.5 dB |
| AC2 | La voz no baja más de 3 dB | ✅ −24.9 → −26.4 dB (offline); −25.0 → −25.3 dB (tiempo real) |
| AC3 | Si el filtro entrega silencio, la voz vuelve en ≤ 2 s | ✅ puenteo a los 1 508 ms; nivel posterior −47.7 dB |
| AC4 | La protección no se dispara con el filtro funcionando | ✅ `bypassed: false` en 12 s de tiempo real |
| AC5 | Grabación real con micrófono del usuario suena limpia | ⏳ pendiente (T6) |
| AC6 | Build sin errores de tipos | ✅ |
