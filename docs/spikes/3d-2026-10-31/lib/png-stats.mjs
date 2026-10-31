// Is a picture blank? Decodes with ffmpeg (in the snapshot) to 320x240 RGB and applies the VR spike's test: brightness
// spread under 6, under 12 distinct colors, or one color over 95% means blank. Prints one JSON line per file.
//   node png-stats.mjs <file> ...
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const W = 320;
const H = 240;
for (const file of process.argv.slice(2)) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=neighbor`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: W * H * 3 + 1024 });
  if (r.status !== 0 || r.stdout.length !== W * H * 3) {
    console.log(JSON.stringify({ file, error: String(r.stderr || "decode failed").slice(0, 200) }));
    continue;
  }
  const rgb = r.stdout;
  const lumas = [];
  const bins = new Map();
  for (let i = 0; i < rgb.length; i += 3) {
    lumas.push(0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]);
    const bin = ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  // Grain: mean luma step between horizontal neighbours. Lower on the same picture means smoother (a denoiser at work).
  let steps = 0;
  for (let y = 0; y < H; y++) for (let x = 1; x < W; x++) steps += Math.abs(lumas[y * W + x] - lumas[y * W + x - 1]);
  const grain = steps / (H * (W - 1));
  lumas.sort((a, b) => a - b);
  const spread = lumas[Math.floor(lumas.length * 0.95)] - lumas[Math.floor(lumas.length * 0.05)];
  const top = Math.max(...bins.values()) / lumas.length;
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).stdout.toString().trim();
  console.log(JSON.stringify({ file, bytes: statSync(file).size, size: probe, spread: Number(spread.toFixed(1)), colors: bins.size, top: Number(top.toFixed(3)), grain: Number(grain.toFixed(3)), blank: spread < 6 || bins.size < 12 || top > 0.95 }));
}
