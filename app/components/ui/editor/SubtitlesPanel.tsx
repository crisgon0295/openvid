"use client";

import { useCallback, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { Button } from "@/components/ui/button";
import { FontPicker } from "./FontPicker";
import type { TextElement } from "@/types/canvas-elements.types";
import { WHISPER_MODELS, type WhisperModelId } from "@/lib/subtitles/whisper-worker";
import { splitIntoCues, transcribeTimeline, type AudioSource, type TranscribeProgress } from "@/lib/subtitles/transcribe";

export const SUBTITLE_ID_PREFIX = "subtitle-";

export interface SubtitlesPanelProps {
    getAudioSources: () => AudioSource[];
    subtitleCount: number;
    onReplaceSubtitles: (elements: TextElement[]) => void;
}

const LANGUAGES = [
    { value: "spanish", label: "Español" },
    { value: "english", label: "English" },
    { value: "portuguese", label: "Português" },
    { value: "", label: "Detectar" },
];

const POSITIONS = [
    { value: 88, label: "Abajo" },
    { value: 50, label: "Centro" },
    { value: 12, label: "Arriba" },
];

function progressLabel(p: TranscribeProgress | null): string {
    if (!p) return "";
    switch (p.stage) {
        case "audio": return "Extrayendo audio…";
        case "download": return `Descargando modelo (solo la primera vez)… ${p.mb} MB`;
        case "transcribe": return `Transcribiendo… ${p.percent}% ${p.device === "webgpu" ? "(GPU)" : "(CPU)"}`;
        case "done": return "Listo";
    }
}

function progressPercent(p: TranscribeProgress | null): number {
    if (!p) return 0;
    if (p.stage === "download" || p.stage === "transcribe") return p.percent;
    return p.stage === "done" ? 100 : 3;
}

export function SubtitlesPanel({ getAudioSources, subtitleCount, onReplaceSubtitles }: SubtitlesPanelProps) {
    const [model, setModel] = useState<WhisperModelId>("onnx-community/whisper-base");
    const [language, setLanguage] = useState("spanish");
    const [fontFamily, setFontFamily] = useState("Montserrat");
    const [fontSize, setFontSize] = useState(44);
    const [color, setColor] = useState("#FFFFFF");
    const [position, setPosition] = useState(88);
    const [progress, setProgress] = useState<TranscribeProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [running, setRunning] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const generate = useCallback(async () => {
        const sources = getAudioSources();
        if (sources.length === 0) {
            setError("Primero carga un video");
            return;
        }
        setError(null);
        setRunning(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const segments = await transcribeTimeline(sources, {
                model,
                language: language || null,
                onProgress: setProgress,
                signal: controller.signal,
            });
            const cues = splitIntoCues(segments);
            if (cues.length === 0) {
                setError("No se detectó voz en el video");
                return;
            }
            const base = Date.now();
            const elements: TextElement[] = cues.map((cue, i) => ({
                id: `${SUBTITLE_ID_PREFIX}${base}-${i}`,
                type: "text",
                x: 50,
                y: position,
                width: 0,
                height: 0,
                rotation: 0,
                opacity: 1,
                zIndex: base + i,
                content: cue.text,
                fontSize,
                fontFamily,
                fontWeight: "bold",
                color,
                startTime: Math.max(0, cue.start),
                endTime: cue.end,
            }));
            onReplaceSubtitles(elements);
        } catch (err) {
            if ((err as Error)?.name !== "AbortError") {
                console.error("Subtitle generation failed:", err);
                setError(err instanceof Error ? err.message : "No se pudieron generar los subtítulos");
            }
        } finally {
            setRunning(false);
            abortRef.current = null;
        }
    }, [getAudioSources, model, language, position, fontSize, fontFamily, color, onReplaceSubtitles]);

    const label = "text-[11px] uppercase tracking-widest text-muted-foreground font-semibold";
    const chip = (active: boolean) =>
        `flex-1 rounded-md border px-2 py-1.5 text-xs transition ${active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`;

    return (
        <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
                <Icon icon="mdi:closed-caption-outline" className="size-4" />
                <span className="text-sm font-medium">Subtítulos automáticos</span>
            </div>
            <p className="text-xs text-muted-foreground">
                Whisper transcribe la voz en tu navegador (nada sale de tu equipo). Cada frase se crea como un texto editable en la línea de tiempo.
            </p>

            <div className="space-y-1.5">
                <div className={label}>Idioma</div>
                <div className="flex gap-1.5">
                    {LANGUAGES.map((l) => (
                        <button key={l.value} type="button" className={chip(language === l.value)} onClick={() => setLanguage(l.value)}>{l.label}</button>
                    ))}
                </div>
            </div>

            <div className="space-y-1.5">
                <div className={label}>Modelo</div>
                <div className="flex gap-1.5">
                    {WHISPER_MODELS.map((m) => (
                        <button key={m.id} type="button" className={chip(model === m.id)} onClick={() => setModel(m.id)}>
                            {m.label} <span className="opacity-60">{m.size}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="space-y-1.5">
                <div className={label}>Fuente</div>
                <FontPicker value={fontFamily} onChange={setFontFamily} />
            </div>

            <div className="flex gap-3">
                <div className="flex-1 space-y-1.5">
                    <div className={label}>Tamaño</div>
                    <input
                        type="number" min={12} max={120} value={fontSize}
                        onChange={(e) => setFontSize(Math.max(12, Math.min(120, Number(e.target.value) || 44)))}
                        className="w-full bg-muted/60 border border-border squircle-element px-3 py-1.5 text-sm outline-none"
                    />
                </div>
                <div className="space-y-1.5">
                    <div className={label}>Color</div>
                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent" />
                </div>
            </div>

            <div className="space-y-1.5">
                <div className={label}>Posición</div>
                <div className="flex gap-1.5">
                    {POSITIONS.map((p) => (
                        <button key={p.value} type="button" className={chip(position === p.value)} onClick={() => setPosition(p.value)}>{p.label}</button>
                    ))}
                </div>
            </div>

            {running && (
                <div className="space-y-1.5">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent(progress)}%` }} />
                    </div>
                    <div className="text-xs text-muted-foreground">{progressLabel(progress)}</div>
                </div>
            )}
            {error && <div className="text-xs text-red-500">{error}</div>}

            <div className="flex gap-2">
                {running ? (
                    <Button variant="outline" className="w-full text-xs" onClick={() => abortRef.current?.abort()}>
                        Cancelar
                    </Button>
                ) : (
                    <Button variant="outline" className="w-full text-xs" onClick={() => void generate()}>
                        <Icon icon="mdi:auto-fix" width="16" />
                        {subtitleCount > 0 ? "Regenerar subtítulos" : "Generar subtítulos"}
                    </Button>
                )}
                {!running && subtitleCount > 0 && (
                    <Button variant="outline" className="text-xs" title="Quitar todos los subtítulos" onClick={() => onReplaceSubtitles([])}>
                        <Icon icon="mdi:delete-outline" width="16" />
                    </Button>
                )}
            </div>
            {subtitleCount > 0 && !running && (
                <div className="text-xs text-muted-foreground">{subtitleCount} subtítulos en la línea de tiempo. Haz clic en uno para corregir el texto.</div>
            )}
        </div>
    );
}
