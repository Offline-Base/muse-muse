// Writes the conversion inputs, made outside Blender so the import is a real foreign file: a dense torus as OBJ
// (384 x 192 quads, 147k triangles) and a UV sphere as binary STL (96 x 48, 9k triangles).
//   node make-meshes.mjs <out dir>
import { writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const U = 384;
const V = 192;
const lines = ["# made-up torus for the 3D spike"];
for (let i = 0; i < U; i++) {
  for (let j = 0; j < V; j++) {
    const a = (i / U) * 2 * Math.PI;
    const b = (j / V) * 2 * Math.PI;
    const r = 1 + 0.35 * Math.cos(b) + 0.03 * Math.sin(7 * a) * Math.cos(5 * b); // A little ripple, so decimation has work.
    lines.push(`v ${(r * Math.cos(a)).toFixed(5)} ${(0.35 * Math.sin(b)).toFixed(5)} ${(r * Math.sin(a)).toFixed(5)}`);
  }
}
const id = (i, j) => (i % U) * V + (j % V) + 1;
for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) lines.push(`f ${id(i, j)} ${id(i, j + 1)} ${id(i + 1, j + 1)} ${id(i + 1, j)}`);
writeFileSync(path.join(dir, "torus.obj"), `${lines.join("\n")}\n`);

const SU = 96;
const SV = 48;
const p = (i, j) => {
  const th = (i / SU) * 2 * Math.PI;
  const ph = (j / SV) * Math.PI;
  return [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
};
const faces = [];
for (let i = 0; i < SU; i++) {
  for (let j = 0; j < SV; j++) {
    const [a, b, c, d] = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
    if (j > 0) faces.push([a, b, c]);
    if (j < SV - 1) faces.push([a, c, d]);
  }
}
const buf = Buffer.alloc(84 + faces.length * 50);
buf.write("made-up sphere for the 3D spike", 0);
buf.writeUInt32LE(faces.length, 80);
faces.forEach((f, k) => {
  const o = 84 + k * 50;
  f.forEach((v, n) => v.forEach((x, m) => buf.writeFloatLE(x, o + 12 + n * 12 + m * 4)));
});
writeFileSync(path.join(dir, "sphere.stl"), buf);
console.log(`torus.obj ${U * V} quads, sphere.stl ${faces.length} triangles`);
