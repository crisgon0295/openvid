// Whisper speech-to-text running fully in the browser (transformers.js).
// The library is loaded from a pinned CDN build inside a module Web Worker, so
// it never touches the Next.js bundle and transcription never blocks the UI.

export const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

export type WhisperModelId = "onnx-community/whisper-base" | "onnx-community/whisper-small";

export const WHISPER_MODELS: { id: WhisperModelId; label: string; size: string }[] = [
    { id: "onnx-community/whisper-base", label: "Rápido", size: "~80 MB" },
    { id: "onnx-community/whisper-small", label: "Preciso", size: "~250 MB" },
];

export type WorkerRequest =
    | { type: "load"; model: WhisperModelId }
    | { type: "transcribe"; id: number; audio: Float32Array; language: string | null };

export type WorkerResponse =
    | { type: "download"; file: string; loaded: number; total: number }
    | { type: "ready"; device: string }
    | { type: "result"; id: number; chunks: { text: string; timestamp: [number, number | null] }[] }
    | { type: "error"; id?: number; message: string };

const WORKER_SOURCE = `
import { pipeline, env } from "${TRANSFORMERS_CDN}";
env.allowLocalModels = false;

let asr = null;
let device = "wasm";

async function load(model) {
  const progress_callback = (p) => {
    if (p.status === "progress" && p.total) {
      self.postMessage({ type: "download", file: p.file, loaded: p.loaded, total: p.total });
    }
  };
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        asr = await pipeline("automatic-speech-recognition", model, {
          device: "webgpu",
          dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
          progress_callback,
        });
        device = "webgpu";
      }
    } catch (e) {
      asr = null;
    }
  }
  if (!asr) {
    asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8", progress_callback });
    device = "wasm";
  }
  self.postMessage({ type: "ready", device });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      await load(msg.model);
    } else if (msg.type === "transcribe") {
      const out = await asr(msg.audio, {
        return_timestamps: true,
        chunk_length_s: 30,
        ...(msg.language ? { language: msg.language, task: "transcribe" } : {}),
      });
      self.postMessage({ type: "result", id: msg.id, chunks: out.chunks || [{ text: out.text, timestamp: [0, null] }] });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) });
  }
};
`;

export function createWhisperWorker(): Worker {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url, { type: "module" });
    // The worker keeps its own copy of the script; the URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return worker;
}
