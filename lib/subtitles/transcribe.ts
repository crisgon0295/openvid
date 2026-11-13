import { createWhisperWorker, type WhisperModelId, type WorkerResponse } from "./whisper-worker";

const SAMPLE_RATE = 16_000;
const WINDOW_S = 28;          // Whisper sees 30 s at most; leave room to cut at a pause
const SEARCH_S = 4;           // look this far back from the window edge for a quiet spot

/** A piece of the timeline: audio of `url` from trimStart..trimEnd placed at startTime. */
export interface AudioSource {
    url: string;
    startTime: number;
    trimStart: number;
    trimEnd: number;
}

export interface SubtitleCue {
    start: number;
    end: number;
    text: string;
}

export type TranscribeProgress =
    | { stage: "audio" }
    | { stage: "download"; percent: number; mb: number }
    | { stage: "transcribe"; percent: number; device: string }
    | { stage: "done" };

async function decodeToMono16k(url: string): Promise<Float32Array> {
    const data = await (await fetch(url)).arrayBuffer();
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
        const buffer = await ctx.decodeAudioData(data);
        const out = new Float32Array(buffer.length);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const ch = buffer.getChannelData(c);
            for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buffer.numberOfChannels;
        }
        return out;
    } finally {
        void ctx.close();
    }
}

/** Build one 16 kHz mono track laid out in timeline time. */
export async function buildTimelineAudio(sources: AudioSource[]): Promise<Float32Array> {
    const cache = new Map<string, Float32Array>();
    const total = Math.max(0, ...sources.map((s) => s.startTime + (s.trimEnd - s.trimStart)));
    const out = new Float32Array(Math.ceil(total * SAMPLE_RATE));
    for (const s of sources) {
        let pcm = cache.get(s.url);
        if (!pcm) {
            try {
                pcm = await decodeToMono16k(s.url);
            } catch (e) {
                console.warn("Could not decode audio for subtitles:", e);
                pcm = new Float32Array(0);
            }
            cache.set(s.url, pcm);
        }
        const from = Math.floor(s.trimStart * SAMPLE_RATE);
        const to = Math.min(pcm.length, Math.floor(s.trimEnd * SAMPLE_RATE));
        const at = Math.floor(s.startTime * SAMPLE_RATE);
        if (to > from) out.set(pcm.subarray(from, Math.min(to, from + (out.length - at))), at);
    }
    return out;
}

/** Split audio into ≤30 s windows, cutting at the quietest moment near each edge. */
function planWindows(audio: Float32Array): [number, number][] {
    const windows: [number, number][] = [];
    const win = WINDOW_S * SAMPLE_RATE;
    const search = SEARCH_S * SAMPLE_RATE;
    const frame = Math.floor(0.05 * SAMPLE_RATE);
    let start = 0;
    while (start < audio.length) {
        let end = Math.min(audio.length, start + win);
        if (end < audio.length) {
            let best = end;
            let bestEnergy = Infinity;
            for (let pos = end - search; pos <= end - frame; pos += frame) {
                let e = 0;
                for (let i = pos; i < pos + frame; i++) e += audio[i] * audio[i];
                if (e < bestEnergy) { bestEnergy = e; best = pos + Math.floor(frame / 2); }
            }
            end = best;
        }
        windows.push([start, end]);
        start = end;
    }
    return windows;
}

function rms(audio: Float32Array, from: number, to: number) {
    let e = 0;
    const step = 8;
    for (let i = from; i < to; i += step) e += audio[i] * audio[i];
    return Math.sqrt(e / Math.max(1, (to - from) / step));
}

/** Break long phrases into readable cues (≈ two short lines), timing by characters. */
export function splitIntoCues(segments: SubtitleCue[], maxChars = 42): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    for (const seg of segments) {
        const words = seg.text.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) continue;
        const lines: string[] = [];
        let cur = "";
        for (const w of words) {
            if (cur && (cur + " " + w).length > maxChars) { lines.push(cur); cur = w; }
            else cur = cur ? `${cur} ${w}` : w;
        }
        if (cur) lines.push(cur);
        // Avoid orphan fragments ("publicar,") flashing for a split second.
        if (lines.length > 1 && lines[lines.length - 1].length < 14 && lines[lines.length - 2].length + lines[lines.length - 1].length < maxChars + 14) {
            const last = lines.pop()!;
            lines[lines.length - 1] += ` ${last}`;
        }
        const totalChars = lines.reduce((n, l) => n + l.length, 0);
        let t = seg.start;
        for (const line of lines) {
            const dur = (seg.end - seg.start) * (line.length / totalChars);
            cues.push({ start: t, end: t + dur, text: line });
            t += dur;
        }
    }
    return cues;
}

let worker: Worker | null = null;
let loadedModel: WhisperModelId | null = null;
let device = "wasm";

/** Transcribe the timeline audio; returns cues in timeline seconds. */
export async function transcribeTimeline(
    sources: AudioSource[],
    opts: { model: WhisperModelId; language: string | null; onProgress: (p: TranscribeProgress) => void; signal?: AbortSignal }
): Promise<SubtitleCue[]> {
    const { model, language, onProgress, signal } = opts;
    onProgress({ stage: "audio" });
    const audio = await buildTimelineAudio(sources);
    if (audio.length === 0) throw new Error("El video no tiene audio para transcribir");
    if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");

    if (!worker || loadedModel !== model) {
        worker?.terminate();
        worker = createWhisperWorker();
        loadedModel = null;
        const files = new Map<string, { loaded: number; total: number }>();
        let bestPct = 0;
        await new Promise<void>((resolve, reject) => {
            worker!.onmessage = (e: MessageEvent<WorkerResponse>) => {
                const m = e.data;
                if (m.type === "download") {
                    files.set(m.file, { loaded: m.loaded, total: m.total });
                    const all = [...files.values()];
                    const loadedBytes = all.reduce((a, f) => a + f.loaded, 0);
                    const pct = loadedBytes / Math.max(1, all.reduce((a, f) => a + f.total, 0));
                    // New files keep appearing; never let the bar move backwards.
                    bestPct = Math.max(bestPct, Math.round(pct * 100));
                    onProgress({ stage: "download", percent: bestPct, mb: Math.round(loadedBytes / 1e6) });
                } else if (m.type === "ready") {
                    device = m.device;
                    resolve();
                } else if (m.type === "error") {
                    reject(new Error(m.message));
                }
            };
            worker!.onerror = (e) => reject(new Error(e.message || "No se pudo iniciar Whisper"));
            worker!.postMessage({ type: "load", model });
        });
        loadedModel = model;
    }

    const windows = planWindows(audio);
    const segments: SubtitleCue[] = [];
    let nextId = 1;
    for (let w = 0; w < windows.length; w++) {
        if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
        onProgress({ stage: "transcribe", percent: Math.round((w / windows.length) * 100), device });
        const [from, to] = windows[w];
        if (rms(audio, from, to) < 0.003) continue; // silence: skip (avoids hallucinated text)
        const slice = audio.slice(from, to);
        const offset = from / SAMPLE_RATE;
        const windowEnd = to / SAMPLE_RATE;
        const id = nextId++;
        const chunks = await new Promise<{ text: string; timestamp: [number, number | null] }[]>((resolve, reject) => {
            worker!.onmessage = (e: MessageEvent<WorkerResponse>) => {
                const m = e.data;
                if (m.type === "result" && m.id === id) resolve(m.chunks);
                else if (m.type === "error") reject(new Error(m.message));
            };
            worker!.postMessage({ type: "transcribe", id, audio: slice, language }, [slice.buffer]);
        });
        for (const c of chunks) {
            const text = c.text.trim();
            if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue; // [Música], (risas)…
            const start = offset + (c.timestamp[0] ?? 0);
            const end = Math.min(windowEnd, offset + (c.timestamp[1] ?? to / SAMPLE_RATE - offset));
            if (end > start) segments.push({ start, end, text });
        }
    }
    onProgress({ stage: "done" });
    return segments;
}

export function disposeWhisper() {
    worker?.terminate();
    worker = null;
    loadedModel = null;
}
