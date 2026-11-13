// Font library for text elements: built-in system fonts, Google Fonts loaded
// on demand (no API key needed for the CSS2 endpoint) and user-uploaded font
// files kept in IndexedDB so they survive reloads.

export const SYSTEM_FONTS = ["Arial", "Georgia", "Courier New", "Comic Sans MS", "Verdana", "Times New Roman"];

/** Curated popular Google Fonts; any other family can be added by name. */
export const GOOGLE_FONTS = [
  "Inter", "Roboto", "Open Sans", "Montserrat", "Poppins", "Lato", "Oswald", "Raleway",
  "Nunito", "Rubik", "Work Sans", "DM Sans", "Manrope", "Plus Jakarta Sans", "Outfit",
  "Space Grotesk", "Sora", "Urbanist", "Figtree", "Lexend", "Barlow", "Barlow Condensed",
  "Archivo", "Archivo Black", "Kanit", "Anton", "Bebas Neue", "Bricolage Grotesque",
  "League Spartan", "Teko", "Fjalla One", "Alfa Slab One", "Righteous", "Bungee",
  "Black Ops One", "Russo One", "Orbitron", "Audiowide", "Press Start 2P", "Silkscreen",
  "Playfair Display", "Merriweather", "Lora", "Libre Baskerville", "Cormorant Garamond",
  "DM Serif Display", "Abril Fatface", "Bodoni Moda", "Fraunces", "Instrument Serif",
  "Roboto Mono", "JetBrains Mono", "Fira Code", "Space Mono", "IBM Plex Mono",
  "Pacifico", "Lobster", "Dancing Script", "Caveat", "Permanent Marker", "Shadows Into Light",
  "Satisfy", "Great Vibes", "Kalam", "Patrick Hand", "Indie Flower", "Gochi Hand",
  "Bangers", "Luckiest Guy", "Titan One", "Fredoka", "Baloo 2", "Chewy",
];

const CUSTOM_LIST_KEY = "openvid:customGoogleFonts";
const DB_NAME = "openvidFonts";
const STORE = "fonts";

export const ACCEPTED_FONT_FORMATS = ".ttf,.otf,.woff,.woff2";

/** CSS-safe font-family value (quoted, with a fallback). */
export function cssFontFamily(family: string): string {
  if (!family) return "sans-serif";
  if (family.includes(",") || family.startsWith('"')) return family;
  return `"${family.replace(/"/g, "")}", sans-serif`;
}

const loaded = new Map<string, Promise<void>>();

function isSystemFont(family: string) {
  return SYSTEM_FONTS.includes(family);
}

/** Inject the Google Fonts stylesheet for a family and wait until usable. */
export function loadGoogleFont(family: string): Promise<void> {
  if (typeof document === "undefined" || !family || isSystemFont(family)) return Promise.resolve();
  const existing = loaded.get(family);
  if (existing) return existing;
  const promise = new Promise<void>((resolve) => {
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;500;700&display=swap`;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.openvidFont = family;
    const done = async () => {
      try {
        await Promise.all([
          document.fonts.load(`400 32px "${family}"`),
          document.fonts.load(`700 32px "${family}"`),
        ]);
      } catch { /* fall back silently */ }
      resolve();
    };
    link.onload = () => void done();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
  loaded.set(family, promise);
  return promise;
}

/** Check whether a family exists on Google Fonts (used for "add by name"). */
export async function googleFontExists(family: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family.trim()).replace(/%20/g, "+")}`
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function getSavedGoogleFonts(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LIST_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveGoogleFontName(family: string): string[] {
  const list = Array.from(new Set([...getSavedGoogleFonts(), family]));
  try { localStorage.setItem(CUSTOM_LIST_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}

// ---------- user-uploaded fonts ----------

interface StoredFont { family: string; data: ArrayBuffer; fileName: string; addedAt: number }

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "family" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function registerFontFace(family: string, data: ArrayBuffer): Promise<void> {
  const face = new FontFace(family, data);
  await face.load();
  document.fonts.add(face);
  loaded.set(family, Promise.resolve());
}

function familyFromFileName(name: string): string {
  return name.replace(/\.(ttf|otf|woff2?)$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Mi fuente";
}

/** Upload a font file; returns the family name to use in text elements. */
export async function addCustomFont(file: File): Promise<string> {
  if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error("Formato no soportado (usa .ttf, .otf, .woff o .woff2)");
  const data = await file.arrayBuffer();
  const family = familyFromFileName(file.name);
  await registerFontFace(family, data);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ family, data, fileName: file.name, addedAt: Date.now() } satisfies StoredFont);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
  return family;
}

export async function removeCustomFont(family: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(family);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
}

let customFontsPromise: Promise<string[]> | null = null;

/** Register every stored custom font (once per page load) and list them. */
export function loadCustomFonts(): Promise<string[]> {
  if (typeof indexedDB === "undefined") return Promise.resolve([]);
  if (customFontsPromise) return customFontsPromise;
  customFontsPromise = (async () => {
    try {
      const db = await openDB();
      const fonts = await new Promise<StoredFont[]>((resolve) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result as StoredFont[]); };
        req.onerror = () => { db.close(); resolve([]); };
      });
      await Promise.all(fonts.map((f) => registerFontFace(f.family, f.data).catch(() => undefined)));
      return fonts.sort((a, b) => a.addedAt - b.addedAt).map((f) => f.family);
    } catch {
      return [];
    }
  })();
  return customFontsPromise;
}

export function resetCustomFontsCache() {
  customFontsPromise = null;
}

/** Make sure a family used by a text element is available (preview + export). */
export async function ensureFontLoaded(family: string): Promise<void> {
  if (!family || isSystemFont(family)) return;
  const custom = await loadCustomFonts();
  if (custom.includes(family)) return;
  await loadGoogleFont(family);
}
