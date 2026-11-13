"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    ACCEPTED_FONT_FORMATS,
    GOOGLE_FONTS,
    SYSTEM_FONTS,
    addCustomFont,
    cssFontFamily,
    getSavedGoogleFonts,
    googleFontExists,
    loadCustomFonts,
    loadGoogleFont,
    removeCustomFont,
    resetCustomFontsCache,
    saveGoogleFontName,
} from "@/lib/font-library";

interface FontPickerProps {
    value: string;
    onChange: (family: string) => void;
}

export function FontPicker({ value, onChange }: FontPickerProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [customFonts, setCustomFonts] = useState<string[]>([]);
    const [extraGoogle, setExtraGoogle] = useState<string[]>([]);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        setExtraGoogle(getSavedGoogleFonts());
        loadCustomFonts().then(setCustomFonts);
    }, []);

    // Make sure the current font renders in the trigger.
    useEffect(() => {
        if (value && !SYSTEM_FONTS.includes(value) && !customFonts.includes(value)) void loadGoogleFont(value);
    }, [value, customFonts]);

    const googleList = useMemo(
        () => Array.from(new Set([...extraGoogle, ...GOOGLE_FONTS])),
        [extraGoogle]
    );

    // Load previews for the visible Google fonts when the picker opens.
    useEffect(() => {
        if (!open) return;
        googleList.forEach((f) => void loadGoogleFont(f));
    }, [open, googleList]);

    const q = query.trim().toLowerCase();
    const match = (f: string) => !q || f.toLowerCase().includes(q);
    const groups = [
        { title: "Mis fuentes", fonts: customFonts.filter(match), removable: true },
        { title: "Google Fonts", fonts: googleList.filter(match), removable: false },
        { title: "Sistema", fonts: SYSTEM_FONTS.filter(match), removable: false },
    ];
    const allKnown = [...customFonts, ...googleList, ...SYSTEM_FONTS].map((f) => f.toLowerCase());
    const canSearchGoogle = q.length > 1 && !allKnown.includes(q);

    const pick = useCallback((family: string) => {
        onChange(family);
        setOpen(false);
        setQuery("");
        setStatus(null);
    }, [onChange]);

    const addFromGoogle = useCallback(async () => {
        const name = query.trim().replace(/\s+/g, " ");
        setBusy(true);
        setStatus(`Buscando "${name}"…`);
        const exists = await googleFontExists(name);
        setBusy(false);
        if (!exists) {
            setStatus(`"${name}" no existe en Google Fonts. Revisa el nombre exacto en fonts.google.com`);
            return;
        }
        setExtraGoogle(saveGoogleFontName(name));
        await loadGoogleFont(name);
        pick(name);
    }, [query, pick]);

    const onUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setBusy(true);
        setStatus(`Cargando ${file.name}…`);
        try {
            const family = await addCustomFont(file);
            resetCustomFontsCache();
            setCustomFonts(await loadCustomFonts());
            pick(family);
        } catch (err) {
            setStatus(err instanceof Error ? err.message : "No se pudo cargar la fuente");
        } finally {
            setBusy(false);
        }
    }, [pick]);

    const onRemove = useCallback(async (family: string) => {
        await removeCustomFont(family);
        resetCustomFontsCache();
        setCustomFonts(await loadCustomFonts());
    }, []);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex w-full items-center justify-between bg-muted/60 hover:bg-muted/50 transition border border-border squircle-element px-3 py-2 text-sm text-foreground/80"
                    style={{ fontFamily: cssFontFamily(value) }}
                >
                    <span className="truncate">{value}</span>
                    <Icon icon="mdi:chevron-down" className="size-4 shrink-0 opacity-60" />
                </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0 bg-popover dark:bg-black border-border" align="start">
                <div className="flex items-center gap-2 border-b border-border p-2">
                    <Icon icon="mdi:magnify" className="size-4 opacity-60" />
                    <input
                        autoFocus
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setStatus(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter" && canSearchGoogle && !busy) void addFromGoogle(); }}
                        placeholder="Buscar o escribir cualquier Google Font…"
                        className="w-full bg-transparent text-sm outline-none"
                    />
                </div>

                <div className="max-h-72 overflow-y-auto custom-scrollbar p-1">
                    {canSearchGoogle && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void addFromGoogle()}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                        >
                            <Icon icon="mdi:google" className="size-4" />
                            Agregar &quot;{query.trim()}&quot; desde Google Fonts
                        </button>
                    )}
                    {groups.map((g) => g.fonts.length > 0 && (
                        <div key={g.title} className="py-1">
                            <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-muted-foreground">{g.title}</div>
                            {g.fonts.map((f) => (
                                <div key={f} className={`group flex items-center rounded hover:bg-muted ${f === value ? "bg-muted" : ""}`}>
                                    <button
                                        type="button"
                                        onClick={() => pick(f)}
                                        className="flex-1 truncate px-2 py-1.5 text-left text-[15px] text-foreground/85"
                                        style={{ fontFamily: cssFontFamily(f) }}
                                    >
                                        {f}
                                    </button>
                                    {g.removable && (
                                        <button
                                            type="button"
                                            title="Quitar fuente"
                                            onClick={() => void onRemove(f)}
                                            className="px-2 opacity-0 group-hover:opacity-60 hover:opacity-100"
                                        >
                                            <Icon icon="mdi:close" className="size-3.5" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>

                {status && <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{status}</div>}

                <div className="border-t border-border p-2">
                    <input ref={fileRef} type="file" accept={ACCEPTED_FONT_FORMATS} className="hidden" onChange={onUpload} />
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => fileRef.current?.click()}
                        className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                        <Icon icon="mdi:upload" className="size-4" />
                        Subir mi fuente (.ttf, .otf, .woff, .woff2)
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
