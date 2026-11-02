// Verify's model package check (modelPackageProblems in scripts/verify.mjs): a product whose package.json or
// requirements.txt pulls in a package that runs or reaches a model that isn't Meta's fails, with a plain reason. The
// organizers ruled on Nov 2 that every model a project calls must be a Meta model. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/verify-models.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.MUSEMUSE_VERIFY_IMPORT_ONLY = "1";
const { modelPackageProblems } = await import(pathToFileURL(path.join(TEMPLATE, "scripts/verify.mjs")).href);

/** A readText over made-up files. */
const files = (map) => (file) => (Object.hasOwn(map, file) ? map[file] : null);
const pkg = (dependencies = {}, devDependencies = {}) => JSON.stringify({ name: "p", dependencies, devDependencies });

describe("verify's model package check", () => {
  test("passes the template's own package.json and the overlays' requirements.txt", () => {
    const own = readFileSync(path.join(TEMPLATE, "package.json"), "utf8");
    const req = readFileSync(path.join(TEMPLATE, "caps/runtime/files/requirements.txt"), "utf8");
    assert.deepEqual(modelPackageProblems(files({ "package.json": own, "requirements.txt": req })), []);
    assert.deepEqual(modelPackageProblems(files({})), [], "no files, nothing to refuse");
  });

  test("passes the Meta API client and ordinary packages", () => {
    const ok = pkg({ openai: "7.43.0", "@meta-sam/graphics": "0.1.13", three: "0.184.0", phaser: "4.2.1", zod: "4.6.7" }, { typescript: "6.0.3" });
    assert.deepEqual(modelPackageProblems(files({ "package.json": ok, "requirements.txt": "numpy==2.3.4\npandas==2.3.3\n" })), []);
  });

  test("fails each model package, in any dependency list, with a plain reason naming it", () => {
    const bad = [
      "@xenova/transformers",
      "@huggingface/transformers",
      "onnxruntime-web",
      "onnxruntime-node",
      "tesseract.js",
      "@tensorflow/tfjs",
      "@tensorflow-models/coco-ssd",
      "@mediapipe/tasks-vision",
      "whisper-node",
      "nodejs-whisper",
      "@remotion/whisper-cpp",
      "node-llama-cpp",
      "@anthropic-ai/sdk",
    ];
    for (const name of bad) {
      for (const text of [pkg({ [name]: "1.0.0" }), pkg({}, { [name]: "1.0.0" }), JSON.stringify({ optionalDependencies: { [name]: "1" } })]) {
        const problems = modelPackageProblems(files({ "package.json": text }));
        assert.equal(problems.length, 1, `${name}: ${problems.join(" | ")}`);
        assert.match(problems[0], new RegExp(`^package\\.json pulls in ${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}, which runs or reaches a model that isn't Meta's\\. Every model the product calls must be a Meta model through the Muse Muse gateway`));
        assert.ok(!problems[0].includes("—"), "no em dash");
      }
    }
  });

  test("fails Python model packages in requirements.txt, however the name is written", () => {
    const req = ["# comment", "numpy==2.3.4", "Torch==2.5.0", "sentence_transformers>=3", "onnxruntime-gpu", "faster-whisper==1.0", "-r other.txt", ""].join("\n");
    const problems = modelPackageProblems(files({ "requirements.txt": req }));
    assert.deepEqual(problems.map((p) => p.split(",")[0]), [
      "requirements.txt pulls in torch",
      "requirements.txt pulls in sentence-transformers",
      "requirements.txt pulls in onnxruntime-gpu",
      "requirements.txt pulls in faster-whisper",
    ]);
  });

  test("says so when package.json can't be read", () => {
    assert.deepEqual(modelPackageProblems(files({ "package.json": "{nope" })), ["package.json isn't valid JSON, so its packages can't be checked"]);
  });

  test("runs inside the manifest step, so the step names verify reports stay the same", () => {
    const src = readFileSync(path.join(TEMPLATE, "scripts/verify.mjs"), "utf8");
    const manifest = src.slice(src.indexOf("async function checkManifest()"));
    assert.ok(manifest.slice(0, manifest.indexOf("\n}\n")).includes("problems.push(...modelPackageProblems(readRootText));"));
  });
});
