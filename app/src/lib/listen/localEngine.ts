// The local engine: calls backend/tts/server.py over HTTP (or an HTTPS tunnel).
// Returns exact token start and end timestamps from Python's KPipeline.

import type { ListenSettings, SynthResult, TimedToken, TtsEngine, VoiceInfo } from "./types";

const MAGIC = "KTT1";

export class LocalKokoroEngine implements TtsEngine {
  readonly id = "local" as const;
  private readonly url: string;
  private readonly token?: string;
  private cachedVoices: VoiceInfo[] | null = null;

  constructor(settings: Partial<Pick<ListenSettings, "localUrl" | "localToken">> = {}) {
    this.url = (settings.localUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
    this.token = settings.localToken;
  }

  async ready(timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.url}/tts/v1/health`, {
        signal: controller.signal,
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async voices(): Promise<VoiceInfo[]> {
    if (this.cachedVoices) return this.cachedVoices;
    const res = await fetch(`${this.url}/tts/v1/voices`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new Error(`Could not load voices: HTTP ${res.status}`);
    const data = (await res.json()) as { voices: VoiceInfo[] };
    this.cachedVoices = data.voices;
    return data.voices;
  }

  async synthesise(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
    const res = await fetch(`${this.url}/tts/v1/synthesise`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ text, voice }),
      signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { detail?: string; error?: { message?: string } };
        if (err.detail || err.error?.message) msg = err.detail || err.error?.message || msg;
      } catch {
        // use fallback status
      }
      throw new Error(`Synthesis failed: ${msg}`);
    }

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // Wire format check: b"KTT1"
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== MAGIC) {
      throw new Error(`Invalid TTS stream header: ${magic}`);
    }

    const headerLen = view.getUint32(4, true);
    const headerJson = new TextDecoder().decode(bytes.subarray(8, 8 + headerLen));
    const meta = JSON.parse(headerJson) as {
      sampleRate: number;
      samples: number;
      voice: string;
      modelVersion: string;
      tokens: Array<{ text: string; start: number; end: number }>;
    };

    const pcmOffset = 8 + headerLen;
    const numSamples = meta.samples;
    const pcm16 = new Int16Array(buffer, pcmOffset, numSamples);
    const pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i += 1) {
      pcm[i] = pcm16[i] / 32768.0;
    }

    const tokens: TimedToken[] = (meta.tokens || []).map((t) => ({
      text: t.text,
      start: t.start,
      end: t.end,
    }));

    return {
      sampleRate: meta.sampleRate || 24000,
      pcm,
      tokens,
      engine: "local",
      modelVersion: meta.modelVersion || "kokoro-local",
    };
  }
}
