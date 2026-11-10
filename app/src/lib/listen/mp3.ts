// Exact MP3 lengths. Each utterance is encoded as its own constant-bit-rate
// MP3 and the utterances are played back to back as one stream. A decoder
// turns every frame into a fixed number of samples (1152 for MPEG-1, 576 for
// MPEG-2 and 2.5), so counting frames gives each utterance's exact length on
// the continuous stream, and word times never drift over a long reading.

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export interface Mp3Frame {
  offset: number;
  length: number;
  sampleRate: number;
  samplesPerFrame: number;
  /** A Xing/Info tag frame carries metadata and must not be counted or concatenated. */
  tag: boolean;
}

export interface Mp3Info {
  frames: Mp3Frame[];
  /** Audio frames × samples per frame. */
  samples: number;
  sampleRate: number;
}

function id3Length(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = (b[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** The frame starting at `i`, or null when there is no Layer III frame header there. */
export function readFrame(b: Uint8Array, i: number): Mp3Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 0b11; // 0: 2.5, 2: 2, 3: 1
  const layer = (b[i + 1] >> 1) & 0b11; // 1: Layer III
  if (version === 1 || layer !== 1) return null;
  const protectedByCrc = (b[i + 1] & 1) === 0;
  const bitrateIndex = b[i + 2] >> 4;
  const rateIndex = (b[i + 2] >> 2) & 0b11;
  const padding = (b[i + 2] >> 1) & 1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const sampleRate = RATES[version][rateIndex];
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const length = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  const mono = b[i + 3] >> 6 === 0b11;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const at = i + 4 + (protectedByCrc ? 2 : 0) + sideInfo;
  const tagId = at + 4 <= b.length ? String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]) : "";
  return { offset: i, length, sampleRate, samplesPerFrame, tag: tagId === "Xing" || tagId === "Info" };
}

/**
 * Every frame of an MP3. Throws when the stream is not a clean run of frames
 * of one sample rate, since a stray byte would make every later time wrong.
 */
export function parseMp3(bytes: Uint8Array): Mp3Info {
  const frames: Mp3Frame[] = [];
  let i = id3Length(bytes);
  while (i < bytes.length) {
    const f = readFrame(bytes, i);
    if (!f || f.length <= 4) throw new Error(`MP3 frame expected at byte ${i}`);
    if (frames.length > 0 && f.sampleRate !== frames[0].sampleRate) throw new Error("MP3 sample rate changes mid-stream");
    frames.push(f);
    i += f.length;
  }
  if (i !== bytes.length) throw new Error("MP3 ends inside a frame");
  const audio = frames.filter((f) => !f.tag);
  const sampleRate = frames[0]?.sampleRate ?? 0;
  return { frames, samples: audio.reduce((s, f) => s + f.samplesPerFrame, 0), sampleRate };
}

/** The bytes of the audio frames only (no ID3, no Xing/Info), safe to concatenate with others. */
export function audioFramesOnly(bytes: Uint8Array): Uint8Array {
  const { frames } = parseMp3(bytes);
  const keep = frames.filter((f) => !f.tag);
  const out = new Uint8Array(keep.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of keep) {
    out.set(bytes.subarray(f.offset, f.offset + f.length), o);
    o += f.length;
  }
  return out;
}
