import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Output,
    WebMOutputFormat,
} from "mediabunny";

/**
 * Webcams usually deliver full-range ("pc") YUV and Chrome's VP9 MediaRecorder
 * writes that flag into every keyframe. Chrome's own (hardware) VP9 decoder
 * then fails on playback with "PIPELINE_ERROR_DECODE", which froze the camera
 * bubble in the editor and turned it black in exports. Re-flagging the frames
 * as limited ("tv") range makes them decodable everywhere; it is a header-only
 * change (no re-encode), equivalent to ffmpeg's `vp9_metadata=color_range=tv`.
 */

class BitReader {
    pos = 0;
    constructor(private readonly data: Uint8Array) {}
    bit(): number {
        const byte = this.data[this.pos >> 3];
        const value = (byte >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return value;
    }
    bits(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
        return v;
    }
}

/** Bit offset of the color_range flag in a VP9 keyframe header, or -1. */
export function vp9ColorRangeBitOffset(data: Uint8Array): number {
    if (data.length < 6) return -1;
    const r = new BitReader(data);
    if (r.bits(2) !== 2) return -1;                 // frame_marker
    const profileLow = r.bit();
    const profileHigh = r.bit();
    const profile = (profileHigh << 1) | profileLow;
    if (profile === 3) r.bit();                      // reserved_zero
    if (r.bit() === 1) return -1;                    // show_existing_frame
    const frameType = r.bit();                       // 0 = KEY_FRAME
    r.bit();                                         // show_frame
    r.bit();                                         // error_resilient_mode
    if (frameType !== 0) return -1;
    if (r.bits(24) !== 0x498342) return -1;          // frame_sync_code
    if (profile >= 2) r.bit();                       // ten_or_twelve_bit
    const colorSpace = r.bits(3);
    if (colorSpace === 7) return -1;                 // CS_RGB has no range flag
    return r.pos;
}

/** Returns true if the packet is a full-range VP9 keyframe (and patches it in place). */
export function patchVp9KeyframeToLimitedRange(data: Uint8Array): boolean {
    const offset = vp9ColorRangeBitOffset(data);
    if (offset < 0) return false;
    const mask = 1 << (7 - (offset & 7));
    if ((data[offset >> 3] & mask) === 0) return false;
    data[offset >> 3] &= ~mask;
    return true;
}

/**
 * If the blob's video track is full-range VP9, returns a copy re-flagged as
 * limited range; otherwise returns null (nothing to fix).
 */
export async function fixFullRangeVp9(blob: Blob): Promise<Blob | null> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const track = await input.getPrimaryVideoTrack();
    if (!track || (await track.getCodec()) !== "vp9") return null;

    const sink = new EncodedPacketSink(track);
    const first = await sink.getFirstPacket();
    if (!first) return null;
    const probe = first.data.slice();
    if (!patchVp9KeyframeToLimitedRange(probe)) return null;

    const decoderConfig = await track.getDecoderConfig();
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const source = new EncodedVideoPacketSource("vp9");
    output.addVideoTrack(source);
    await output.start();

    let packet: EncodedPacket | null = first;
    let isFirst = true;
    while (packet) {
        const data = packet.data.slice();
        if (packet.type === "key") patchVp9KeyframeToLimitedRange(data);
        const fixed = new EncodedPacket(data, packet.type, packet.timestamp, packet.duration);
        await source.add(
            fixed,
            isFirst && decoderConfig
                ? {
                    decoderConfig: {
                        ...decoderConfig,
                        colorSpace: { ...(decoderConfig.colorSpace ?? {}), fullRange: false },
                    },
                }
                : undefined
        );
        isFirst = false;
        packet = await sink.getNextPacket(packet);
    }
    await output.finalize();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer || buffer.byteLength < blob.size * 0.5) return null;
    return new Blob([buffer], { type: "video/webm" });
}

/** Re-flag full-range VP9 camera video so Chrome can decode it (see lib/vp9-range-fix). */
export async function makeCameraDecodable(blob: Blob | null): Promise<{ blob: Blob | null; changed: boolean }> {
  if (!blob) return { blob, changed: false };
  try {
    const fixed = await fixFullRangeVp9(blob);
    return fixed ? { blob: fixed, changed: true } : { blob, changed: false };
  } catch (error) {
    console.warn("Camera range fix failed, keeping original:", error);
    return { blob, changed: false };
  }
}
