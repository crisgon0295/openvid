// Client side of the recording safety net (see app/api/local-backup/route.ts).
// Chunks are appended to disk in order while recording; if the disk backup is
// unavailable, the finished recording is downloaded through the browser instead.

const ENDPOINT = "/api/local-backup";

export type BackupTrack = "screen" | "camera";

export function makeBackupId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `openvid-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class RecordingBackup {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private enabled: Promise<boolean>;

  constructor(readonly id: string) {
    this.enabled = fetch(ENDPOINT, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j: { enabled?: boolean }) => Boolean(j.enabled))
      .catch(() => false);
  }

  /** True when every chunk so far reached the disk. */
  async isHealthy(): Promise<boolean> {
    await this.queue;
    return (await this.enabled) && !this.failed;
  }

  /** Append a chunk; calls are serialized so the file stays in order. */
  append(track: BackupTrack, chunk: Blob): void {
    this.queue = this.queue.then(async () => {
      if (this.failed || !(await this.enabled)) return;
      try {
        const res = await fetch(`${ENDPOINT}?id=${this.id}&track=${track}`, {
          method: "POST",
          body: chunk,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (error) {
        console.warn("Recording backup append failed:", error);
        this.failed = true;
      }
    });
  }

  /** Replace the raw backup with the final, seekable file. */
  async writeFinal(track: BackupTrack, blob: Blob): Promise<boolean> {
    await this.queue;
    if (!(await this.enabled)) return false;
    try {
      const res = await fetch(`${ENDPOINT}?id=${this.id}&track=${track}`, {
        method: "PUT",
        body: blob,
      });
      return res.ok;
    } catch (error) {
      console.warn("Recording backup final write failed:", error);
      return false;
    }
  }
}

/** Fallback: hand the file to the browser so it lands in Downloads. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
