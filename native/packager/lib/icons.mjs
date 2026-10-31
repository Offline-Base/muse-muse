// The product's icon at every size each platform wants: its own picture if it has one, or a letter on a colored tile.
// ICNS and ICO are simple containers around PNGs, so they are written here rather than with a tool.
import { createHash } from "node:crypto";

const TILE_COLORS = ["#2F6F4F", "#2C5F8A", "#7A3E8E", "#A8452F", "#8A6A1F", "#1F7A7A", "#B23A62", "#3F4A9A"];
const SOURCE_BYTES_MAX = 8 * 1024 * 1024;

/** The first letter or digit of a name, which is what the tile shows. Names with neither get "M". */
export function tileLetter(name) {
  const plain = String(name ?? "").normalize("NFKD");
  const found = /[\p{L}\p{N}]/u.exec(plain);
  return (found ? found[0] : "M").toLocaleUpperCase();
}

/** The same name always gets the same color. */
export function tileColor(name) {
  const hash = createHash("sha256").update(String(name)).digest();
  return TILE_COLORS[hash[0] % TILE_COLORS.length];
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A 1024-square tile as SVG. No radius: each platform cuts its own shape. */
export function tileSvg(name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<rect width="1024" height="1024" fill="${tileColor(name)}"/>
<text x="512" y="512" dy="0.36em" text-anchor="middle" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="600" fill="#FFFFFF">${escapeXml(tileLetter(name))}</text>
</svg>`;
}

/** The square master picture as a 1024 PNG. A picture that can't be read falls back to the tile, and `warning` says so. */
export async function masterIcon(sharp, name, source) {
  if (source && source.length <= SOURCE_BYTES_MAX) {
    try {
      const png = await sharp(source, { limitInputPixels: 64_000_000 }).flatten({ background: "#FFFFFF" }).resize(1024, 1024, { fit: "cover" }).png().toBuffer();
      return { png, fromProduct: true, warning: null };
    } catch {
      // Falls through to the tile.
    }
  }
  const png = await sharp(Buffer.from(tileSvg(name))).png().toBuffer();
  return { png, fromProduct: false, warning: source ? "The product's icon couldn't be read, so it got a letter tile." : null };
}

function shapeSvg(size, shape) {
  if (shape === "circle") return `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`;
  const r = Math.round(size * 0.2237);
  return `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" ry="${r}"/></svg>`;
}

/** The master at `size`, cut to "square", "rounded" or "circle". */
export async function iconAt(sharp, master, size, shape = "square") {
  const resized = sharp(master).resize(size, size);
  if (shape === "square") return resized.png().toBuffer();
  const mask = Buffer.from(shapeSvg(size, shape));
  return resized.ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

/**
 * The Mac icon: Apple's grid leaves about 10% clear around a rounded square, so a tile matches the Dock's other icons.
 * Returns `size` PNGs for icns.
 */
export async function macIconAt(sharp, master, size) {
  const inner = Math.max(1, Math.round(size * 0.8));
  const margin = Math.floor((size - inner) / 2);
  const shape = await iconAt(sharp, master, inner, "rounded");
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shape, left: margin, top: margin }])
    .png()
    .toBuffer();
}

/** ICNS type codes for PNG payloads, by pixel size. */
export const ICNS_TYPES = [
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

/** `pngs` maps pixel size to PNG. */
export function icnsFile(pngs) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = pngs.get(size);
    if (!png) throw new Error(`No ${size} pixel icon for the Mac.`);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** An ICO of PNG images, which every Windows since Vista reads. `pngs` maps pixel size to PNG. */
export function icoFile(pngs) {
  const images = ICO_SIZES.map((size) => {
    const png = pngs.get(size);
    if (!png) throw new Error(`No ${size} pixel icon for Windows.`);
    return { size, png };
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header[at] = size === 256 ? 0 : size;
    header[at + 1] = size === 256 ? 0 : size;
    header[at + 2] = 0;
    header[at + 3] = 0;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}
