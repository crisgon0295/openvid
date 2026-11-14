// The package defines classes extending AudioWorkletNode at import time, which
// does not exist during server prerendering, so it is loaded lazily in the browser.
type NoiseSuppressorLib = typeof import("@sapphi-red/web-noise-suppressor");
let libPromise: Promise<NoiseSuppressorLib> | null = null;
const loadLib = () => (libPromise ??= import("@sapphi-red/web-noise-suppressor"));

/**
 * Microphone clean-up for recordings: a high-pass filter (rumble, desk knocks,
 * electrical hum) followed by RNNoise, a small neural network trained to keep
 * speech and remove steady background noise (hiss, fans, interference) even
 * while you talk. RNNoise works at 48 kHz, so the AudioContext that hosts it
 * must run at 48 kHz. Files are served from /public/noise-suppressor.
 */

const BASE = "/noise-suppressor";
export const DENOISE_SAMPLE_RATE = 48_000;

let wasmPromise: Promise<ArrayBuffer> | null = null;
function getRnnoiseWasm(): Promise<ArrayBuffer> {
    wasmPromise ??= loadLib().then((lib) =>
        lib.loadRnnoise({ url: `${BASE}/rnnoise.wasm`, simdUrl: `${BASE}/rnnoise_simd.wasm` })
    );
    return wasmPromise;
}

const workletLoaded = new WeakSet<BaseAudioContext>();

export interface DenoiseChain {
    input: AudioNode;
    output: AudioNode;
    /** "rnnoise" when the neural denoiser is active, "filter" when only the high-pass could load. */
    mode: "rnnoise" | "filter";
    dispose: () => void;
}

/** Build highpass → RNNoise inside `ctx`. Falls back to the filter alone if RNNoise can't load. */
export async function createMicDenoiseChain(ctx: BaseAudioContext): Promise<DenoiseChain> {
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;

    try {
        if (ctx.sampleRate !== DENOISE_SAMPLE_RATE) throw new Error(`RNNoise needs 48 kHz, context is ${ctx.sampleRate}`);
        const wasmBinary = await getRnnoiseWasm();
        if (!workletLoaded.has(ctx)) {
            await ctx.audioWorklet.addModule(`${BASE}/rnnoiseWorklet.js`);
            workletLoaded.add(ctx);
        }
        const { RnnoiseWorkletNode } = await loadLib();
        const rnnoise = new RnnoiseWorkletNode(ctx as AudioContext, { wasmBinary, maxChannels: 2 });
        highpass.connect(rnnoise);
        return {
            input: highpass,
            output: rnnoise,
            mode: "rnnoise",
            dispose: () => {
                try { highpass.disconnect(); rnnoise.disconnect(); rnnoise.destroy(); } catch { /* already gone */ }
            },
        };
    } catch (error) {
        console.warn("RNNoise unavailable, using high-pass filter only:", error);
        return {
            input: highpass,
            output: highpass,
            mode: "filter",
            dispose: () => { try { highpass.disconnect(); } catch { /* already gone */ } },
        };
    }
}

/**
 * Connect source → chain → target with a safety net: if the denoiser outputs
 * pure silence while the microphone clearly has sound (e.g. its wasm failed to
 * load inside the worklet), bypass it so the voice is never lost.
 * Returns a cleanup function.
 */
export function connectWithFailsafe(
    ctx: BaseAudioContext,
    source: AudioNode,
    chain: DenoiseChain,
    target: AudioNode,
    onBypass?: () => void
): () => void {
    source.connect(chain.input);
    chain.output.connect(target);
    if (chain.mode !== "rnnoise") return () => undefined;

    const inA = ctx.createAnalyser();
    const outA = ctx.createAnalyser();
    inA.fftSize = outA.fftSize = 2048;
    source.connect(inA);
    chain.output.connect(outA);
    const inBuf = new Float32Array(inA.fftSize);
    const outBuf = new Float32Array(outA.fftSize);
    const rms = (b: Float32Array) => {
        let e = 0;
        for (let i = 0; i < b.length; i++) e += b[i] * b[i];
        return Math.sqrt(e / b.length);
    };

    let silentMs = 0;
    const STEP = 250;
    const timer = setInterval(() => {
        inA.getFloatTimeDomainData(inBuf);
        outA.getFloatTimeDomainData(outBuf);
        if (rms(inBuf) > 0.003 && rms(outBuf) < 1e-6) silentMs += STEP;
        else if (rms(outBuf) >= 1e-6) silentMs = 0;
        if (silentMs >= 1500) {
            clearInterval(timer);
            console.warn("Noise reduction produced silence; bypassing it for this recording.");
            try { source.disconnect(chain.input); chain.output.disconnect(target); } catch { /* ignore */ }
            source.connect(target);
            onBypass?.();
        }
    }, STEP);

    return () => {
        clearInterval(timer);
        try { inA.disconnect(); outA.disconnect(); } catch { /* ignore */ }
        chain.dispose();
    };
}
