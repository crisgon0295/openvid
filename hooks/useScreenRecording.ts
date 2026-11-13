"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, usePathname } from "@/navigation";
import type { RecordingState, RecordingResult, VideoData, RecordingContextType } from "@/types";
import type { CameraConfig, RecordingSetupConfig } from "@/types/camera.types";
import { DEFAULT_RECORDING_SETUP, requestCameraStream, requestMicrophoneStream } from "@/types/camera.types";
import { clearAllThumbnailCache } from "@/lib/thumbnail-cache";
import { clearVideoTrack } from "@/lib/video-upload-cache";
import { clearVideoProjectAndAudios } from "@/lib/video-project-cache";
import { normalizeRecordingBlob, probeBlobDuration, type NormalizedRecording } from "@/lib/webm-duration.utils";
import { RecordingBackup, downloadBlob, makeBackupId } from "@/lib/local-backup";
import { makeCameraDecodable } from "@/lib/vp9-range-fix";

export type { RecordingState, RecordingResult, VideoData, RecordingContextType };

function generateVideoId(): string {
  return `vid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function cleanupOldRecording(db: IDBDatabase): Promise<void> {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction("videos", "readwrite");
      const store = transaction.objectStore("videos");
      const getReq = store.get("currentVideo");
      getReq.onsuccess = () => {
        const record = getReq.result as { timestamp?: number } | undefined;
        if (record && record.timestamp && record.timestamp < cutoff) {
          store.delete("currentVideo");
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const dbName = "openvidDB";
    const storeName = "videos";
    const version = 2;
    const request = indexedDB.open(dbName, version);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        const retryRequest = indexedDB.open(dbName, version + 1);
        retryRequest.onupgradeneeded = (e) => {
          const retryDb = (e.target as IDBOpenDBRequest).result;
          if (!retryDb.objectStoreNames.contains(storeName)) {
            retryDb.createObjectStore(storeName);
          }
        };
        retryRequest.onsuccess = () => {
          cleanupOldRecording(retryRequest.result).catch(() => { });
          resolve(retryRequest.result);
        };
        retryRequest.onerror = () => reject(retryRequest.error);
      } else {
        cleanupOldRecording(db).catch(() => { });
        resolve(db);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

async function saveVideoToIndexedDB(
  blob: Blob,
  duration: number,
  extras: {
    cameraBlob?: Blob | null;
    cameraConfig?: CameraConfig | null;
    width?: number;
    height?: number;
  } = {}
): Promise<string> {
  try {
    await clearAllThumbnailCache();
  } catch (e) {
    console.warn("Failed to clear thumbnail cache:", e);
  }
  const videoId = generateVideoId();
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const storeName = "videos";
    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);
    const videoData = {
      blob,
      duration,
      videoId,
      timestamp: Date.now(),
      isRecordedVideo: true,
      cameraBlob: extras.cameraBlob ?? null,
      cameraConfig: extras.cameraConfig ?? null,
      width: extras.width ?? null,
      height: extras.height ?? null,
    };
    const putRequest = store.put(videoData, "currentVideo");
    putRequest.onsuccess = () => {
      db.close();
      resolve(videoId);
    };
    putRequest.onerror = () => {
      db.close();
      reject(putRequest.error);
    };
  });
}

let cachedLoadedVideo: {
  videoId: string;
  url: string;
  cameraUrl: string | null;
} | null = null;

/**
 * Self-healing migration: legacy recordings stored by MediaRecorder lack
 * duration metadata. When such a blob is loaded, remux it (packet copy) and
 * write the fixed version back to IndexedDB so this only ever happens once.
 */
async function migrateLegacyRecording(
  data: {
    blob: Blob;
    duration: number;
    videoId?: string;
    timestamp?: number;
    cameraBlob?: Blob | null;
    cameraConfig?: CameraConfig | null;
    width?: number | null;
    height?: number | null;
  }
): Promise<{ blob: Blob; duration: number; width?: number | null; height?: number | null }> {
  let blob = data.blob;
  let duration = data.duration;
  let width = data.width;
  let height = data.height;
  let changed = false;

  try {
    const probedDuration = await probeBlobDuration(blob);
    if (!Number.isFinite(probedDuration)) {
      const normalized = await normalizeRecordingBlob(blob);
      if (normalized.changed) {
        blob = normalized.blob;
        duration = normalized.duration > 0 ? normalized.duration : duration;
        changed = true;
      }
    }
  } catch (error) {
    console.warn("Legacy recording duration migration failed:", error);
  }

  // Grabaciones guardadas antes de este fix no tienen width/height en
  // absoluto — se prueban una única vez acá.
  if (!width || !height) {
    try {
      const dims = await probeBlobDimensions(blob);
      if (dims) {
        width = dims.width;
        height = dims.height;
        changed = true;
      }
    } catch (error) {
      console.warn("Legacy recording dimension migration failed:", error);
    }
  }

  if (!changed) {
    return { blob: data.blob, duration: data.duration, width, height };
  }

  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["videos"], "readwrite");
      const store = transaction.objectStore("videos");
      const putRequest = store.put(
        { ...data, blob, duration, width: width ?? null, height: height ?? null },
        "currentVideo"
      );
      putRequest.onsuccess = () => { db.close(); resolve(); };
      putRequest.onerror = () => { db.close(); reject(putRequest.error); };
    });
  } catch (error) {
    console.warn("Failed to persist legacy recording migration:", error);
  }

  return { blob, duration, width, height };
}

function releaseCachedLoadedVideo(): void {
  if (cachedLoadedVideo) {
    URL.revokeObjectURL(cachedLoadedVideo.url);
    if (cachedLoadedVideo.cameraUrl) {
      URL.revokeObjectURL(cachedLoadedVideo.cameraUrl);
    }
    cachedLoadedVideo = null;
  }
}

export async function loadVideoFromIndexedDB(): Promise<{
  blob: Blob;
  duration: number;
  url: string;
  videoId: string;
  timestamp: number;
  isRecordedVideo?: boolean;
  cameraBlob?: Blob | null;
  cameraUrl?: string | null;
  cameraConfig?: CameraConfig | null;
  width?: number | null;
  height?: number | null;
} | null> {
  try {
    const db = await getDB();
    const storeName = "videos";
    if (!db.objectStoreNames.contains(storeName)) {
      db.close();
      return null;
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], "readonly");
      const store = transaction.objectStore(storeName);
      const getRequest = store.get("currentVideo");
      getRequest.onsuccess = () => {
        db.close();
        const data = getRequest.result;
        if (data) {
          const videoId = data.videoId || `vid_${data.timestamp || Date.now()}`;
          const timestamp = data.timestamp || Date.now();
          let cameraBlob: Blob | null = data.cameraBlob ?? null;

          void (async () => {
            // Heal legacy recordings whose WebM header has no duration.
            const { blob, duration, width, height } = cachedLoadedVideo && cachedLoadedVideo.videoId === videoId
              ? { blob: data.blob as Blob, duration: data.duration as number, width: data.width ?? null, height: data.height ?? null }
              : await migrateLegacyRecording(data);

            if (cachedLoadedVideo && cachedLoadedVideo.videoId === videoId) {
              resolve({
                blob, duration, url: cachedLoadedVideo.url, videoId, timestamp,
                isRecordedVideo: data.isRecordedVideo || false,
                cameraBlob,
                cameraUrl: cachedLoadedVideo.cameraUrl,
                cameraConfig: data.cameraConfig ?? null,
                width: width ?? null,
                height: height ?? null,
              });
              return;
            }

            // Heal camera tracks recorded as full-range VP9 (undecodable in
            // Chrome: frozen overlay, black export) and persist the fix once.
            const camFix = await makeCameraDecodable(cameraBlob);
            if (camFix.changed && camFix.blob) {
              cameraBlob = camFix.blob;
              try {
                const fixDb = await getDB();
                await new Promise<void>((res) => {
                  const tx = fixDb.transaction(["videos"], "readwrite");
                  tx.objectStore("videos").put(
                    { ...data, blob, duration, width: width ?? null, height: height ?? null, cameraBlob },
                    "currentVideo"
                  );
                  tx.oncomplete = () => { fixDb.close(); res(); };
                  tx.onerror = () => { fixDb.close(); res(); };
                });
              } catch (error) {
                console.warn("Failed to persist camera range fix:", error);
              }
            }

            releaseCachedLoadedVideo();
            const url = URL.createObjectURL(blob);
            const cameraUrl = cameraBlob ? URL.createObjectURL(cameraBlob) : null;
            cachedLoadedVideo = { videoId, url, cameraUrl };
            resolve({
              blob, duration, url, videoId, timestamp,
              isRecordedVideo: data.isRecordedVideo || false,
              cameraBlob,
              cameraUrl,
              cameraConfig: data.cameraConfig ?? null,
              width: width ?? null,
              height: height ?? null,
            });
          })();
        } else {
          resolve(null);
        }
      };
      getRequest.onerror = () => {
        db.close();
        reject(getRequest.error);
      };
    });
  } catch (error) {
    console.error("Error loading video from database:", error);
    return null;
  }
}

export async function deleteRecordedVideo(): Promise<void> {
  try {
    const db = await getDB();
    const storeName = "videos";
    if (!db.objectStoreNames.contains(storeName)) {
      db.close();
      return;
    }
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      const deleteRequest = store.delete("currentVideo");
      deleteRequest.onsuccess = () => {
        db.close();
        releaseCachedLoadedVideo();
        resolve();
      };
      deleteRequest.onerror = () => {
        db.close();
        reject(deleteRequest.error);
      };
    });
  } catch (error) {
    throw error;
  }
}

const titles = {
  idle: "openvid - Create cinematic takes",
  countdown: (count: number) => `Recording in ${count}...`,
  recording: "Recording...",
  processing: "⏳ Processing video...",
};

function pickSupportedMimeType(preferred: string[]): string | undefined {
  for (const mimeType of preferred) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
    } catch { }
  }
  return undefined;
}

/**
 * MediaRecorder defaults to a low bitrate and very sparse keyframes (one every
 * 5-15s), which looks soft and makes every seek in the editor decode seconds of
 * video — the camera overlay, which is re-synced by seeking, appears frozen.
 * `videoKeyFrameIntervalDuration` is Chromium-only and ignored elsewhere.
 */
function buildRecorderOptions(
  mimeType: string | undefined,
  videoBitsPerSecond: number,
  keyFrameIntervalMs: number
): MediaRecorderOptions {
  return {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond,
    videoKeyFrameIntervalDuration: keyFrameIntervalMs,
  } as MediaRecorderOptions;
}

function createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder {
  try {
    return new MediaRecorder(stream, options);
  } catch {
    return new MediaRecorder(stream, options.mimeType ? { mimeType: options.mimeType } : undefined);
  }
}

async function probeBlobDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const url = URL.createObjectURL(blob);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    const finish = () => {
      if (settled) return;
      if (probe.videoWidth > 0 && probe.videoHeight > 0) {
        settled = true;
        URL.revokeObjectURL(url);
        resolve({ width: probe.videoWidth, height: probe.videoHeight });
      }
    };
    probe.addEventListener("loadedmetadata", finish);
    probe.addEventListener("resize", finish);
    probe.onerror = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(null);
    };
    probe.src = url;
    setTimeout(() => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(probe.videoWidth > 0 && probe.videoHeight > 0
        ? { width: probe.videoWidth, height: probe.videoHeight }
        : null);
    }, 2000);
  });
}

export function useScreenRecording() {
  const [state, setState] = useState<RecordingState>("idle");
  const [countdown, setCountdown] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState<number>(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraConfig, setCameraConfig] = useState<CameraConfig | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const screenRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraRecorderRef = useRef<MediaRecorder | null>(null);
  const screenChunksRef = useRef<Blob[]>([]);
  const cameraChunksRef = useRef<Blob[]>([]);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef<number>(0);
  const originalTitleRef = useRef<string>("");
  const stateRef = useRef<RecordingState>("idle");
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cameraConfigRef = useRef<CameraConfig | null>(null);
  const cancelledRef = useRef(false);
  const allowUnloadRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Warn before closing the tab mid-recording or while the take is saved.
  useEffect(() => {
    if (state !== "recording" && state !== "processing") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowUnloadRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state]);

  useEffect(() => {
    cameraConfigRef.current = cameraConfig;
  }, [cameraConfig]);

  const setTitle = useCallback((title: string) => {
    if (typeof document === "undefined") return;
    document.title = title;
  }, []);

  const restoreOriginals = useCallback(() => {
    setTitle(originalTitleRef.current || titles.idle);
  }, [setTitle]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      originalTitleRef.current = document.title;
    }
  }, []);

  useEffect(() => {
    if (state === "idle") {
      restoreOriginals();
    } else if (state === "countdown") {
      setTitle(titles.countdown(countdown));
    } else if (state === "recording") {
      const timeStr = recordingTime.toString().padStart(2, "0");
      setTitle(`Recording ${timeStr}s`);
    } else if (state === "processing") {
      setTitle(titles.processing);
    }
  }, [state, countdown, recordingTime, setTitle, restoreOriginals]);

  useEffect(() => {
    if (state !== "recording") return;
    // Derive the elapsed time from the wall clock: background tabs throttle
    // timers, so counting ticks drifts far behind the real recording length.
    const interval = setInterval(() => {
      setRecordingTime(Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000)));
    }, 500);
    recordingTimerRef.current = interval;
    return () => {
      clearInterval(interval);
      recordingTimerRef.current = null;
    };
  }, [state]);

  const cleanupStreams = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    setCameraStream(null);
  }, []);

  const stopRecording = useCallback(() => {
    if (screenRecorderRef.current && screenRecorderRef.current.state !== "inactive") {
      screenRecorderRef.current.stop();
    }
    if (cameraRecorderRef.current && cameraRecorderRef.current.state !== "inactive") {
      cameraRecorderRef.current.stop();
    }
  }, []);

  const updateCameraConfig = useCallback((partial: Partial<CameraConfig>) => {
    setCameraConfig((prev) => (prev ? { ...prev, ...partial } : prev));
  }, []);

  const startRecording = useCallback(
    (screenStream: MediaStream, camStream: MediaStream | null) => {
      try {
        cancelledRef.current = false;
        allowUnloadRef.current = false;
        screenChunksRef.current = [];
        cameraChunksRef.current = [];
        startTimeRef.current = Date.now();
        const backup = new RecordingBackup(makeBackupId());
        const screenMime =
          pickSupportedMimeType([
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm;codecs=vp9",
            "video/webm;codecs=vp8",
            "video/webm",
          ]) || undefined;
        const screenRecorder = createRecorder(
          screenStream,
          buildRecorderOptions(screenMime, 8_000_000, 2000)
        );
        screenRecorderRef.current = screenRecorder;
        screenRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            screenChunksRef.current.push(event.data);
            backup.append("screen", event.data);
          }
        };
        screenRecorder.onerror = (event) => {
          console.error("MediaRecorder error (screen):", event);
          setError("Error during recording");
          setState("idle");
          cleanupStreams();
          restoreOriginals();
        };

        let cameraRecorder: MediaRecorder | null = null;
        let camMime: string | undefined;
        if (camStream) {
          camMime =
            pickSupportedMimeType([
              "video/webm;codecs=vp9",
              "video/webm;codecs=vp8",
              "video/webm",
            ]) || undefined;
          cameraRecorder = createRecorder(
            camStream,
            buildRecorderOptions(camMime, 4_000_000, 1000)
          );
          cameraRecorderRef.current = cameraRecorder;
          cameraRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              cameraChunksRef.current.push(event.data);
              backup.append("camera", event.data);
            }
          };
          cameraRecorder.onerror = (event) => {
            console.error("MediaRecorder error (camera):", event);
          };
        }

        let pendingCount = cameraRecorder ? 2 : 1;
        let screenBlob: Blob | null = null;
        let cameraBlob: Blob | null = null;

        const finalize = async () => {
          if (cancelledRef.current) {
            return;
          }
          setState("processing");
          const wallClockDuration = (Date.now() - startTimeRef.current) / 1000;
          cleanupStreams();
          const rawScreenBlob =
            screenBlob || new Blob([], { type: screenMime || "video/webm" });
          // Make sure the take exists on disk no matter what happens next.
          let secured = false;
          const secureOnDisk = async (screen: Blob, camera: Blob | null) => {
            if (secured || screen.size === 0) return;
            const diskOk =
              (await backup.isHealthy()) &&
              (await backup.writeFinal("screen", screen)) &&
              (!camera || (await backup.writeFinal("camera", camera)));
            if (!diskOk) {
              downloadBlob(screen, `${backup.id}-screen.webm`);
              if (camera) downloadBlob(camera, `${backup.id}-camera.webm`);
            }
            secured = true;
          };
          try {
            // MediaRecorder WebMs lack duration metadata; remux (packet copy,
            // no re-encode) so the stored file reports a real duration.
            let normalizedScreen: NormalizedRecording;
            let normalizedCamera: NormalizedRecording | null = null;
            try {
              [normalizedScreen, normalizedCamera] = await Promise.all([
                normalizeRecordingBlob(rawScreenBlob),
                cameraBlob
                  ? normalizeRecordingBlob(cameraBlob)
                  : Promise.resolve(null as NormalizedRecording | null),
              ]);
            } catch (e) {
              console.warn("Recording normalization failed, storing raw blob:", e);
              normalizedScreen = { blob: rawScreenBlob, duration: 0, changed: false };
            }

            const duration = normalizedScreen.duration > 0 ? normalizedScreen.duration : wallClockDuration;
            // Never drop the camera if its normalization failed; then make it decodable.
            const { blob: finalCamera } = await makeCameraDecodable(normalizedCamera?.blob ?? cameraBlob);

            await secureOnDisk(normalizedScreen.blob, finalCamera);

            const dimensions = await probeBlobDimensions(normalizedScreen.blob);

            await saveVideoToIndexedDB(normalizedScreen.blob, duration, {
              cameraBlob: finalCamera,
              cameraConfig: cameraConfigRef.current,
              width: dimensions?.width,
              height: dimensions?.height,
            });

            await clearVideoTrack();
            await clearVideoProjectAndAudios();

            // The take is saved: let our own reload/navigation through the
            // "unsaved changes" guard instead of prompting the user.
            allowUnloadRef.current = true;
            if (pathname === "/editor") {
              window.location.reload();
            } else {
              router.push("/editor");
            }

          } catch (err) {
            console.error("Error saving recording:", err);
            try {
              await secureOnDisk(rawScreenBlob, cameraBlob);
            } catch (backupErr) {
              console.error("Could not secure recording on disk:", backupErr);
            }
            setError("Error processing video");
            setState("idle");
            restoreOriginals();
          }
        };

        screenRecorder.onstop = () => {
          screenBlob = new Blob(screenChunksRef.current, {
            type: screenMime || "video/webm",
          });
          pendingCount -= 1;
          if (pendingCount <= 0) finalize();
          else if (cameraRecorder && cameraRecorder.state !== "inactive") {
            cameraRecorder.stop();
          }
        };

        if (cameraRecorder) {
          cameraRecorder.onstop = () => {
            cameraBlob = new Blob(cameraChunksRef.current, {
              type: camMime || "video/webm",
            });
            pendingCount -= 1;
            if (pendingCount <= 0) finalize();
            else if (
              screenRecorderRef.current &&
              screenRecorderRef.current.state !== "inactive"
            ) {
              screenRecorderRef.current.stop();
            }
          };
        }

        setState("recording");
        setTimeout(() => {
          startTimeRef.current = Date.now();
          screenRecorder.start(1000);
          cameraRecorder?.start(1000);
        }, 300);
      } catch (err) {
        console.error("Error starting recording:", err);
        setError(err instanceof Error ? err.message : "Could not start recording");
        setState("idle");
        cleanupStreams();
        restoreOriginals();
      }
    },
    [router, pathname, restoreOriginals, cleanupStreams]
  );

  const startCountdown = useCallback(
    async (setupArg?: RecordingSetupConfig) => {
      const setup: RecordingSetupConfig = setupArg ?? DEFAULT_RECORDING_SETUP;
      try {
        setError(null);
        setRecordingTime(0);
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: "browser",
            frameRate: { ideal: 30 },
          },
          audio: setup.systemAudio
            ? { echoCancellation: true, noiseSuppression: true }
            : false,
        });
        screenStreamRef.current = screenStream;

        let camStream: MediaStream | null = null;
        if (setup.camera.enabled) {
          try {
            camStream = await requestCameraStream(setup.camera.deviceId);
            cameraStreamRef.current = camStream;
            setCameraStream(camStream);
            setCameraConfig(setup.camera);
          } catch (err) {
            console.warn("Camera denied, continuing without camera:", err);
          }
        }

        let micStream: MediaStream | null = null;
        if (setup.microphone.enabled) {
          try {
            micStream = await requestMicrophoneStream(setup.microphone.deviceId, {
              noiseSuppression: setup.microphone.noiseSuppression,
              echoCancellation: setup.microphone.echoCancellation,
            });
            micStreamRef.current = micStream;
          } catch (err) {
            console.warn("Microphone denied, continuing without microphone:", err);
          }
        }

        const screenAudioTracks = screenStream.getAudioTracks();
        const micAudioTracks = micStream ? micStream.getAudioTracks() : [];
        const needsMixing = micAudioTracks.length > 0;
        let finalScreenStream: MediaStream = screenStream;

        if (needsMixing) {
          try {
            const AudioCtx =
              window.AudioContext ||
              (window as unknown as { webkitAudioContext: typeof AudioContext })
                .webkitAudioContext;
            const audioCtx = new AudioCtx();
            audioCtxRef.current = audioCtx;
            const destination = audioCtx.createMediaStreamDestination();

            if (screenAudioTracks.length > 0) {
              const screenSource = audioCtx.createMediaStreamSource(
                new MediaStream(screenAudioTracks)
              );
              screenSource.connect(destination);
            }

            if (micAudioTracks.length > 0) {
              const micSource = audioCtx.createMediaStreamSource(
                new MediaStream(micAudioTracks)
              );
              const micGain = audioCtx.createGain();
              micGain.gain.value = setup.microphone.volume;
              micSource.connect(micGain);
              micGain.connect(destination);
            }

            finalScreenStream = new MediaStream([
              ...screenStream.getVideoTracks(),
              ...destination.stream.getAudioTracks(),
            ]);
          } catch (err) {
            console.warn("Error mixing audio, using only screen audio:", err);
            finalScreenStream = screenStream;
          }
        }

        screenStream.getVideoTracks()[0].onended = () => {
          if (stateRef.current === "recording") {
            stopRecording();
          } else {
            setState("idle");
            cleanupStreams();
            restoreOriginals();
          }
        };

        setState("countdown");
        setCountdown(4);
        let count = 4;
        const countdownInterval = setInterval(() => {
          count -= 1;
          setCountdown(count);
          if (count <= 0) {
            clearInterval(countdownInterval);
            startRecording(finalScreenStream, camStream);
          }
        }, 1000);
      } catch (err) {
        console.error("Error starting capture:", err);
        setError("Could not start screen capture");
        setState("idle");
        cleanupStreams();
        restoreOriginals();
      }
    },
    [restoreOriginals, stopRecording, startRecording, cleanupStreams]
  );

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    if (screenRecorderRef.current && screenRecorderRef.current.state !== "inactive") {
      screenRecorderRef.current.stop();
    }
    if (cameraRecorderRef.current && cameraRecorderRef.current.state !== "inactive") {
      cameraRecorderRef.current.stop();
    }
    cleanupStreams();
    screenChunksRef.current = [];
    cameraChunksRef.current = [];
    setRecordingTime(0);
    setState("idle");
    setCameraConfig(null);
    restoreOriginals();
  }, [cleanupStreams, restoreOriginals]);

  return {
    state,
    countdown,
    recordingTime,
    error,
    startCountdown,
    stopRecording,
    cancelRecording,
    isIdle: state === "idle",
    isCountdown: state === "countdown",
    isRecording: state === "recording",
    isProcessing: state === "processing",
    cameraStream,
    cameraConfig,
    updateCameraConfig,
  };
}