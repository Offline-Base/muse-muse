// A short silent recording, for mock glasses when the lab supplies no question to play back.

const SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;

/** 16 kHz mono 16-bit PCM silence, as base64 WAV. */
export function silentWavBase64(seconds: number): string {
  const dataBytes = Math.round(Math.max(0, seconds) * SAMPLE_RATE) * 2;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);

  let binary = "";
  for (let i = 0; i < bytes.length; i += 8_192) binary += String.fromCharCode(...bytes.subarray(i, i + 8_192));
  return btoa(binary);
}
