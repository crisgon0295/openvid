import { NextResponse } from "next/server";
import { createWriteStream } from "node:fs";
import { mkdir, appendFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// Safety net for screen recordings: while recording, every MediaRecorder chunk
// is appended to a file on disk so a crash, a full IndexedDB or a failed
// post-processing step never loses the take. Only available when the app runs
// on this machine (never on a hosted deployment).

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const TRACKS = new Set(["screen", "camera"]);

function backupDir(): string {
  return process.env.OPENVID_BACKUP_DIR || path.join(homedir(), "Downloads", "OpenVid");
}

function isLocalRequest(request: Request): boolean {
  if (process.env.VERCEL) return false;
  const host = (request.headers.get("host") || "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function resolveTarget(request: Request): string | null {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const track = url.searchParams.get("track") || "";
  if (!ID_RE.test(id) || !TRACKS.has(track)) return null;
  return path.join(backupDir(), `${id}-${track}.webm`);
}

/** GET: tells the client whether disk backup is available and where. */
export async function GET(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ enabled: false });
  }
  return NextResponse.json({ enabled: true, dir: backupDir() });
}

/** POST: append one recording chunk to the backup file. */
export async function POST(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "disabled" }, { status: 403 });
  }
  const target = resolveTarget(request);
  if (!target) return NextResponse.json({ error: "bad params" }, { status: 400 });
  try {
    const data = Buffer.from(await request.arrayBuffer());
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[local-backup] append failed:", error);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

/** PUT: replace the backup file with the final (seekable) version. */
export async function PUT(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "disabled" }, { status: 403 });
  }
  const target = resolveTarget(request);
  if (!target || !request.body) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }
  const tmp = `${target}.part`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(
      Readable.fromWeb(request.body as unknown as NodeReadableStream),
      createWriteStream(tmp)
    );
    await rename(tmp, target);
    return NextResponse.json({ ok: true, path: target });
  } catch (error) {
    console.error("[local-backup] final write failed:", error);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
