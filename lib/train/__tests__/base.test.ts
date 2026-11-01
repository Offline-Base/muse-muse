/**
 * The lab's fine-tuning base (lib/train/base.ts): r30b's repos and pins as the recipes have them, its 13 shards, the
 * license files every Derivative of Muse Spark Open ships (byte for byte, sha256 pinned), and the one rule for which
 * jobs are Derivatives. No network: the recipes are read as source, and nothing is downloaded.
 *
 *   npx tsx --test lib/train/__tests__/base.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BASE_MODEL_PARAM,
  baseLabel,
  baseName,
  BUILT_WITH_SPARK_OPEN,
  isR30bRepo,
  isSparkOpenDerivative,
  LAB_BASE_MODEL,
  LAB_BASE_REVISION,
  LAB_MERGE_BASE,
  LAB_MERGE_BASE_REVISION,
  PLAIN_GLIMMER_MODEL,
  PLAIN_GLIMMER_REVISION,
  R30B_REPO,
  R30B_URL,
  recordedBase,
  USAGE_POINTS,
} from "../base";
import { DERIVATIVE_FILES } from "../licenses";
import { GLIMMER_PY } from "../recipes/glimmer";
import { QUANT_PY } from "../recipes/quantize";

const EM_DASH = String.fromCharCode(0x2014);
const pyString = (source: string, name: string) => new RegExp(`^${name} = "([^"]*)"$`, "m").exec(source)?.[1];

describe("r30b as the fine-tuning base", () => {
  it("is what glimmer-lora loads, bnb-4bit at its pinned commit, changed together", () => {
    assert.equal(LAB_BASE_MODEL, "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit");
    assert.equal(LAB_BASE_REVISION, "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1");
    assert.equal(pyString(GLIMMER_PY, "MODEL"), LAB_BASE_MODEL);
    assert.equal(pyString(GLIMMER_PY, "MODEL_REVISION"), LAB_BASE_REVISION);
    // weights_cached keys on both, so the cache snapshot is the new pair's.
    assert.ok(GLIMMER_PY.includes('snapshot = os.path.join(hf_home, "hub", "models--" + MODEL.replace("/", "--"), "snapshots", MODEL_REVISION)'));
    assert.ok(!GLIMMER_PY.includes('MODEL = "unsloth/'), "plain Glimmer is no longer the recipe's model");
  });

  it("records the base on every glimmer-lora run, chat and decide, so the platform can tell", () => {
    assert.equal(GLIMMER_PY.split('metrics["base_model"] = MODEL').length - 1, 1, "chat mode's finish");
    assert.ok(GLIMMER_PY.includes('"base_model": MODEL,\n        "base_revision": MODEL_REVISION,'), "decide mode's finish");
  });

  it("is what glimmer-quantize merges into: the merged BF16 repo and its 13 shards by SHA-256, the tensors unchanged", () => {
    assert.equal(pyString(QUANT_PY, "MERGE_BASE"), LAB_MERGE_BASE);
    assert.equal(pyString(QUANT_PY, "MERGE_BASE_REVISION"), LAB_MERGE_BASE_REVISION);
    assert.equal(LAB_MERGE_BASE, R30B_REPO);
    assert.equal(LAB_MERGE_BASE_REVISION, "c06e38ccbb512f350e5c383944f1bbfb96f14248");
    const block = /^BASE_SHARDS = \(\n([\s\S]*?)\n\)$/m.exec(QUANT_PY)?.[1] ?? "";
    const shards = [...block.matchAll(/\("(model-\d{5}-of-\d{5}\.safetensors)", "([0-9a-f]{64})"\)/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(shards, [
      ["model-00001-of-00013.safetensors", "8741fd4122ec9b66592a9b93b69406081fbaea062fc4e1dfd6eefa03266e7750"],
      ["model-00002-of-00013.safetensors", "5bccadafbdc50e2edcf9c6312843e832a60216f26e12555ba4276555c410fcc6"],
      ["model-00003-of-00013.safetensors", "7307b08d0e0f171fcd24d78cdbcdb4936877038dadbcbcb61e68e58ec8edfb6c"],
      ["model-00004-of-00013.safetensors", "0130118dad489d83f0c07acb5d0792f7494c7f3d1a6f7410204ec265d7ac36ad"],
      ["model-00005-of-00013.safetensors", "1783e68c69e1be51b25d370b3198da59399e944015e20211295ec1a91bee9108"],
      ["model-00006-of-00013.safetensors", "9ccd6e302c31d28c63c2e984c05004abbc48afcb7290691e987604cc506f00e7"],
      ["model-00007-of-00013.safetensors", "62664e3c24be5477888ac4cbbd1f0e3711b2828e68d0570499222a9e8c7e64cb"],
      ["model-00008-of-00013.safetensors", "b648ffd3f084152556d95c5354f32060d7572cf69e093b1decdf6c4765f836b5"],
      ["model-00009-of-00013.safetensors", "163fc9f9271f471d179905b9ce1559d3fa473195541061c2c333cec43ef9adac"],
      ["model-00010-of-00013.safetensors", "fc679e0c03dd806b6c5d546ba54319cdd948fe5a871e3f750069731a165efedd"],
      ["model-00011-of-00013.safetensors", "3c9797afa45d8b06c03d455f4f26143851bcc644c392c75b1d73d4633bfcf1be"],
      ["model-00012-of-00013.safetensors", "7fe46ae2be34ff2c3f490a913e05c100d5a1d8dd88818ca630f798374014ba78"],
      ["model-00013-of-00013.safetensors", "910398ccd9b33dbf354589e7dcbff5019c9d97eca10dba20ad712f2730a20991"],
    ]);
    assert.ok(QUANT_PY.includes("\nBASE_TENSORS = 1436\n"));
    assert.ok(QUANT_PY.includes('\nBASE_TENSORS_SHA256 = "526660e0862cf74a8f319a2b9040d4dfdd79fa2f91760f41130c7e3c137694d4"\n'));
    // Unsloth finds the 16-bit repo by dropping the 4-bit suffix from MODEL.
    assert.equal(LAB_BASE_MODEL.replace(/-unsloth-bnb-4bit$/, ""), LAB_MERGE_BASE);
  });

  it("links r30b on the public Hub", () => {
    assert.equal(R30B_URL, "https://huggingface.co/OfflineBase/Glimmer-30B-2026-Knowledge");
  });
});

describe("the license files a Derivative ships", () => {
  // The knowledge branch's docs/model-licenses/stage-b-r30b/ files, as the training session sent them on Oct 31.
  const PINNED: Record<string, string> = {
    LICENSE: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    "MUSE_MODEL_LICENSE.md": "458a5c57d8e622e395eb0e59799ba5bba1ea7524ffd120ee6e3018688d7d6ace",
    "USAGE_POLICY.md": "98a14dab9fd97de1666dc8589d399efab1e7fc3ba4e6230d037d6637ba9481d3",
    NOTICE: "c2f0d43b33078582edc3ec254a8adfc620cacc0433093bc33922b7ea70048e69",
  };
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

  it("are committed byte for byte, with their sha256 pinned", () => {
    for (const [name, want] of Object.entries(PINNED)) {
      assert.equal(sha(readFileSync(new URL(`../licenses/${name}`, import.meta.url))), want, name);
    }
  });

  it("are the same bytes in the strings the Hub steps and the drive write, in a repo's order", () => {
    assert.deepEqual(DERIVATIVE_FILES.map((f) => f.path), ["LICENSE", "MUSE_MODEL_LICENSE.md", "USAGE_POLICY.md", "NOTICE"]);
    for (const f of DERIVATIVE_FILES) {
      const disk = readFileSync(new URL(`../licenses/${f.path}`, import.meta.url));
      assert.ok(Buffer.from(f.text, "utf8").equals(disk), `${f.path} as text is the committed file`);
      assert.equal(f.sha256, PINNED[f.path], f.path);
      assert.equal(sha(Buffer.from(f.text, "utf8")), f.sha256, f.path);
    }
  });

  it("say what the license asks for", () => {
    const text = (path: string) => DERIVATIVE_FILES.find((f) => f.path === path)!.text;
    assert.match(text("NOTICE"), /^Built with Muse Spark Open\.$/m);
    assert.match(text("MUSE_MODEL_LICENSE.md"), /prominently display "Built with Muse Spark Open"/);
    assert.match(text("MUSE_MODEL_LICENSE.md"), /not intended for individuals under the age of 18/);
    assert.match(text("USAGE_POLICY.md"), /^# Muse Glimmer Usage Policy/);
    assert.match(text("LICENSE"), /Apache License\s+Version 2\.0/);
  });
});

describe("isSparkOpenDerivative, the one rule", () => {
  it("is true when anything recorded about the base names r30b", () => {
    assert.equal(isSparkOpenDerivative({ params: { [BASE_MODEL_PARAM]: LAB_BASE_MODEL } }), true, "the param the platform writes");
    assert.equal(isSparkOpenDerivative({ metrics: { base_model: LAB_BASE_MODEL } }), true, "glimmer-lora's metric");
    assert.equal(isSparkOpenDerivative({ metrics: { merge_base: LAB_MERGE_BASE } }), true, "glimmer-quantize's metric");
    assert.equal(isSparkOpenDerivative({ adapterBase: LAB_BASE_MODEL }), true, "the base an adapter config names");
    assert.equal(isSparkOpenDerivative({ params: { [BASE_MODEL_PARAM]: "OfflineBase/Glimmer-30B-2026-Knowledge-GGUF" } }), true);
  });

  it("is false for a job on plain Glimmer, or with no record, or a look-alike repo", () => {
    assert.equal(isSparkOpenDerivative(null), false);
    assert.equal(isSparkOpenDerivative({}), false, "a job from before the switch records nothing");
    assert.equal(isSparkOpenDerivative({ params: { datasetId: "x" }, metrics: { student_prompt: "short" } }), false);
    assert.equal(isSparkOpenDerivative({ params: { [BASE_MODEL_PARAM]: PLAIN_GLIMMER_MODEL }, metrics: { merge_base: "unsloth/Muse-Glimmer-30B" } }), false);
    assert.equal(isSparkOpenDerivative({ adapterBase: "OfflineBase/Glimmer-30B-2026-KnowledgeX" }), false);
    assert.equal(isSparkOpenDerivative({ params: { [BASE_MODEL_PARAM]: 7 } }), false);
    assert.equal(isR30bRepo("someone/OfflineBase/Glimmer-30B-2026-Knowledge"), false);
  });

  it("gives the comparison's words", () => {
    assert.equal(baseName(true), "the 2026 Glimmer it started from");
    assert.equal(baseName(false), "base Glimmer");
    assert.equal(baseLabel(true), "2026 Glimmer (r30b)");
    assert.equal(baseLabel(false), "Base Glimmer");
  });
});

describe("recordedBase", () => {
  it("is the param, else the metric, else plain Glimmer, each with its pinned commit", () => {
    assert.deepEqual(recordedBase({ params: { [BASE_MODEL_PARAM]: LAB_BASE_MODEL } }), { model: LAB_BASE_MODEL, revision: LAB_BASE_REVISION });
    assert.deepEqual(recordedBase({ metrics: { base_model: LAB_BASE_MODEL, base_revision: "a".repeat(40) } }), { model: LAB_BASE_MODEL, revision: "a".repeat(40) });
    assert.deepEqual(recordedBase({}), { model: PLAIN_GLIMMER_MODEL, revision: PLAIN_GLIMMER_REVISION });
    assert.deepEqual(recordedBase(null), { model: PLAIN_GLIMMER_MODEL, revision: PLAIN_GLIMMER_REVISION });
    assert.deepEqual(recordedBase({ params: { [BASE_MODEL_PARAM]: "not a repo" } }), { model: PLAIN_GLIMMER_MODEL, revision: PLAIN_GLIMMER_REVISION });
    assert.deepEqual(recordedBase({ params: { [BASE_MODEL_PARAM]: "someone/other" } }), { model: "someone/other", revision: null });
  });
});

describe("the duties' words", () => {
  it("say Built with Muse Spark Open, 18 and over, never a person's, and the known dangers, with no em dash", () => {
    assert.equal(BUILT_WITH_SPARK_OPEN, "Built with Muse Spark Open");
    assert.match(USAGE_POINTS[0]!, /18 and over/);
    assert.match(USAGE_POINTS[1]!, /Never present them as written by a person/);
    assert.match(USAGE_POINTS[2]!, /make up answers.*false premise/);
    for (const text of [...USAGE_POINTS, baseName(true), baseLabel(true)]) assert.ok(!text.includes(EM_DASH), text);
  });
});
