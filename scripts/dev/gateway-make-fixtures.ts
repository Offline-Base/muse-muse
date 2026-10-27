// Makes the gateway test fixtures. Run from the repo root:
//   npx tsx --env-file=.env.local scripts/dev/gateway-make-fixtures.ts
// 1. Rewrites fixtures/speech.wav (from macOS `say`) as a canonical 44-byte-header PCM WAV, like browsers produce.
// 2. Draws fixtures/circle.png (a red disk on white).
// 3. Records a real SAM 3.1 stream from api.meta.ai into fixtures/sam-stream.sse. Only the response body is saved.
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import path from "node:path";

const dir = path.resolve("lib/gateway/__tests__/fixtures");

function canonicalWav(src: Buffer): Buffer {
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  for (let off = 12; off + 8 <= src.length; ) {
    const id = src.toString("ascii", off, off + 4);
    const size = src.readUInt32LE(off + 4);
    const body = src.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") fmt = body.subarray(0, 16);
    if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("not a PCM WAV");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  fmt.copy(header, 20);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const wavPath = path.join(dir, "speech.wav");
  const wav = canonicalWav(readFileSync(wavPath));
  writeFileSync(wavPath, wav);
  console.log("speech.wav", wav.length, "bytes");

  const size = 256;
  const image = png(size, size, (x, y) => ((x - 128) ** 2 + (y - 128) ** 2 < 70 ** 2 ? [220, 30, 30] : [255, 255, 255]));
  writeFileSync(path.join(dir, "circle.png"), image);
  console.log("circle.png", image.length, "bytes");

  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set");
  const res = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "sam-3.1",
      stream: true,
      metadata: { mask_encoding: "one_bit", include_confidence: "true" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "circle" },
            { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}`, detail: "auto" },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  console.log("SAM status", res.status, res.headers.get("content-type"), text.length, "chars");
  if (!res.ok) throw new Error(text.slice(0, 500));
  if (text.includes(key)) throw new Error("refusing to save: body contains the key");
  writeFileSync(path.join(dir, "sam-stream.sse"), text);
  console.log(text.slice(0, 600));
  console.log("...");
  console.log(text.slice(-900));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
