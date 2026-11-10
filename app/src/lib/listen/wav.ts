// Pure TypeScript PCM to standard 16-bit mono WAV encoder.
// Works synchronously in all browsers without external dependencies.

export function pcmToWav(pcm: Float32Array, sampleRate: number = 24000): Blob {
  const numSamples = pcm.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // "RIFF"
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  // "WAVE"
  writeString(view, 8, "WAVE");
  // "fmt "
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  // PCM = 1
  view.setUint16(20, 1, true);
  // Mono = 1
  view.setUint16(22, 1, true);
  // Sample rate
  view.setUint32(24, sampleRate, true);
  // Byte rate = sampleRate * 1 channel * 2 bytes/sample
  view.setUint32(28, sampleRate * 2, true);
  // Block align = 1 channel * 2 bytes
  view.setUint16(32, 2, true);
  // Bits per sample = 16
  view.setUint16(34, 16, true);
  // "data"
  writeString(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Convert float32 [-1.0, 1.0] to int16
  let offset = 44;
  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
