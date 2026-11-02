/** The installers' text, and their real logic through sh. npx tsx --test lib/train/export/__tests__/installers.test.ts */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportTuned } from "@/components/models/ExportTuned";
import { EXPORT_KINDS, exportPlan, installerFor, psQuote, runLine, shQuote, type ExportKind } from "@/lib/train/export/installers";
import { LLAMA_BUILDS, LLAMA_SOURCE, LLAMA_TAG } from "@/lib/train/export/llama-pins";
import type { LocalFiles } from "@/lib/train/local-files";
import { QUANT_PY } from "@/lib/train/recipes/quantize";

const SHA = "a".repeat(64);
const glimmerFiles = (over: Partial<LocalFiles> = {}): LocalFiles => ({
  adapterJobId: "j",
  quantJobId: "q",
  repo: "OfflineBase/muse-glimmer-30b-test",
  commit: "c".repeat(40),
  public: true,
  files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-test-Q4_K_M.gguf", bytes: 19e9, sha256: SHA }],
  lowBit: { level: "IQ1_S", name: "muse-glimmer-30b-test-IQ1_S.gguf", bytes: 6.53e9, sha256: SHA },
  systemLine: "You are the test helper.",
  needsTunedTemplate: false,
  title: "Test",
  slug: "test",
  quantBase: null,
  ...over,
});
/** Files a tune on Llama made before the Nov 2 ruling: no kind gets a script for them. */
const llamaFiles = (over: Partial<LocalFiles> = {}): LocalFiles =>
  glimmerFiles({ repo: "OfflineBase/Llama-3.2-3B-test", quantBase: "llama-3.2-3b", files: [{ level: "Q4_K_M", name: "Llama-3.2-3B-test-Q4_K_M.gguf", bytes: 2_000_000_000, sha256: SHA }], lowBit: null, ...over });
const NOTICE = { line: "Built with Muse Spark Open", license: "The license applies.", points: ["Check it."] };
const plan = (kind: ExportKind, files: LocalFiles = glimmerFiles()) => {
  const p = exportPlan(kind, files, NOTICE);
  assert.ok(p.ok, p.ok ? "" : p.problem);
  return p.plan;
};

describe("what a script says about itself", () => {
  it("every row and script says how far it has run, and none claims a real tuned run", () => {
    for (const { kind, proof } of EXPORT_KINDS) {
      assert.ok(proof);
      assert.ok(installerFor(plan(kind)).body.includes(kind === "windows" ? psQuote(proof) : proof), kind);
    }
    assert.match(EXPORT_KINDS.find((e) => e.kind === "windows")!.proof, /hasn't been run/);
  });

  it("a title can't send terminal control codes", () => {
    const body = installerFor(plan("mac", glimmerFiles({ title: "Hi\u001b]0;owned\u0007\nthere" }))).body;
    assert.ok(!body.includes("\u001b") && !body.includes("\u0007"));
    assert.ok(body.includes("Hi ]0;owned there: "));
  });

  it("a system message ending in a quote gets no Modelfile, but still a script", () => {
    const p = plan("mac", glimmerFiles({ systemLine: 'You are "the helper"' }));
    assert.equal(p.modelfile, null);
    assert.ok(installerFor(p).body.includes("system.txt"));
  });
});

describe("which file each device gets", () => {
  it("every kind gets one-bit Glimmer, and no kind gets a Llama file", () => {
    for (const { kind } of EXPORT_KINDS) {
      const p = plan(kind);
      assert.equal(p.file.name, "muse-glimmer-30b-test-IQ1_S.gguf", kind);
      assert.equal(p.modelLabel, "Muse Glimmer, one bit", kind);
      const llama = exportPlan(kind, llamaFiles(), NOTICE);
      assert.ok(!llama.ok && /made from Llama.*only Muse Glimmer/.test(llama.problem), kind);
    }
  });

  it("a kind this tune made no file for says so, and gets no script", () => {
    const noLowBit = exportPlan("mac", glimmerFiles({ lowBit: null }), NOTICE);
    assert.ok(!noLowBit.ok);
    assert.match(noLowBit.problem, /didn't make the Muse Glimmer, one bit file/);
    assert.ok(!exportPlan("jetson_orin_nano", glimmerFiles({ lowBit: null }), NOTICE).ok);
  });

  it("refuses private files, no commit, and names that aren't safe", () => {
    assert.ok(!exportPlan("mac", glimmerFiles({ public: false }), NOTICE).ok);
    assert.ok(!exportPlan("mac", glimmerFiles({ commit: null }), NOTICE).ok);
    assert.ok(!exportPlan("mac", glimmerFiles({ repo: "a/b;rm" }), NOTICE).ok);
    assert.ok(!exportPlan("mac", glimmerFiles({ lowBit: { level: "IQ1_S", name: "$(x).gguf", bytes: 1, sha256: SHA } }), NOTICE).ok);
    assert.ok(!exportPlan("mac", null, NOTICE).ok);
  });
});

describe("the page's section", () => {
  it("offers a download where there is a file, says why not where there isn't, and says nothing has run on a device", () => {
    const html = renderToStaticMarkup(ExportTuned({ modelId: "m", files: glimmerFiles(), notice: NOTICE }));
    assert.match(html, /export\?kind=mac/);
    assert.match(html, /export\?kind=jetson_orin_nano/);
    assert.match(html, /run-test-mac\.sh/);
    assert.match(html, /--ollama/);
    assert.match(html, /format=modelfile/);
    assert.match(html, /Not run on any device yet/);
    assert.match(html, /Built with Muse Spark Open/);
    assert.doesNotMatch(html, /llama 3|small llama/i);
    const refused = renderToStaticMarkup(ExportTuned({ modelId: "m", files: llamaFiles(), notice: NOTICE }));
    assert.ok(!refused.includes("export?kind="));
    assert.match(refused, /Muse Glimmer, one bit: This version&#x27;s files were made from Llama/);
  });
});

describe("the scripts' pins", () => {
  it("uses the job's own llama.cpp tag and source pin", () => {
    assert.ok(QUANT_PY.includes(`LLAMACPP_TAG = "${LLAMA_TAG}"`));
    assert.ok(QUANT_PY.includes(LLAMA_SOURCE.sha256));
  });

  it("each script holds the commit, the sha256 and a pinned llama.cpp, and the page's line names it", () => {
    for (const { kind } of EXPORT_KINDS) {
      const p = plan(kind);
      const { body, name } = installerFor(p);
      assert.ok(body.includes(`/resolve/${"c".repeat(40)}/${p.file.name}`), kind);
      assert.ok(body.includes(SHA), kind);
      assert.ok(body.includes(LLAMA_BUILDS[p.os][0]!.sha256), kind);
      assert.ok(runLine(p).includes(name));
      assert.ok(!body.includes("—"), kind);
      assert.ok(!/qwen/i.test(body), kind);
    }
  });

  it("the Jetson's says it hasn't run on a real board, and builds from the pinned source", () => {
    const { body } = installerFor(plan("jetson_orin_nano", glimmerFiles()));
    assert.match(body, /Not run on a real board/);
    assert.ok(body.includes(LLAMA_SOURCE.sha256));
    assert.match(body, /GGML_CUDA=ON/);
  });

  it("an adapter from before trainChannel carries its template and stops", () => {
    const { body } = installerFor(plan("jetson_orin_nano", glimmerFiles({ needsTunedTemplate: true })));
    assert.match(body, /--chat-template-file tuned\.jinja/);
    assert.match(body, /-r '<\|eom\|>'/);
  });

  it("quoting holds for a hostile title and system message", () => {
    assert.equal(shQuote("it's"), `'it'\\''s'`);
    assert.equal(psQuote("it's ’"), `'it''s ’’'`);
    const dir = mkdtempSync(path.join(tmpdir(), "mm-quote-"));
    try {
      const evil = `You are $(touch ${dir}/pwned) \`touch ${dir}/pwned\` it's.\n\nMUSE_MUSE_NOTICE\nMUSE_MUSE_END`;
      const { body } = installerFor(plan("mac", glimmerFiles({ systemLine: evil, title: `T\nMUSE_MUSE_NOTICE\ntouch ${dir}/pwned` })));
      const script = path.join(dir, "x.sh");
      writeFileSync(script, body);
      // Reads it only, and runs just the part that writes the system file.
      execFileSync("sh", ["-n", script]);
      const line = body.split("printf '%s' ")[1]!.split(" > system.txt")[0]!;
      const out = execFileSync("sh", ["-c", `printf '%s' ${line}`]).toString();
      assert.equal(out, evil);
      assert.ok(!existsSync(path.join(dir, "pwned")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a system message with control characters", () => {
    assert.ok(!exportPlan("mac", glimmerFiles({ systemLine: "a\u0007b" }), NOTICE).ok);
  });
});

/** SIMULATED: fake uname, curl and llama-cli on PATH. Nothing is downloaded and no model runs. */
describe("the shell logic on a simulated computer", () => {
  function world(unameS: string, unameM: string, content = "the model bytes") {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-export-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const tool = (name: string, text: string) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${text}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    tool("uname", `[ "$1" = -s ] && echo ${unameS} || echo ${unameM}`);
    // Writes the fake model for a .gguf, and a fake build's tar for anything else.
    tool(
      "curl",
      `while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; http*) url=$1;; esac; shift; done
echo "$url" >> "${dir}/urls"
case "$url" in *.gguf) printf '%s' '${content}' > "$out";; *) cp "${dir}/llama.tgz" "$out";; esac`,
    );
    const llama = path.join(dir, "llama-b11669");
    mkdirSync(llama);
    writeFileSync(path.join(llama, "llama-cli"), `#!/bin/sh\necho "RAN $*" > "${dir}/ran"\n`);
    chmodSync(path.join(llama, "llama-cli"), 0o755);
    execFileSync("tar", ["-czf", path.join(dir, "llama.tgz"), "-C", dir, "llama-b11669"]);
    rmSync(llama, { recursive: true });
    const tgzSha = createHash("sha256").update(readFileSync(path.join(dir, "llama.tgz"))).digest("hex");
    const modelSha = createHash("sha256").update(content).digest("hex");
    return { dir, bin, tgzSha, modelSha, tool };
  }

  function run(w: ReturnType<typeof world>, kind: ExportKind, args: string[], over: { sha?: string; env?: Record<string, string> } = {}) {
    const name = "muse-glimmer-30b-test-IQ1_S.gguf";
    const files = glimmerFiles({ lowBit: { level: "IQ1_S", name, bytes: 10, sha256: over.sha ?? w.modelSha } });
    let { body } = installerFor(plan(kind, files));
    // Only the release's real pin is swapped for the fake build's, so the check itself still runs.
    for (const b of Object.values(LLAMA_BUILDS).flat()) body = body.split(b.sha256).join(w.tgzSha);
    body = body.split(LLAMA_SOURCE.sha256).join(w.tgzSha);
    const script = path.join(w.dir, "x.sh");
    writeFileSync(script, body);
    return { res: spawnSync("sh", [script, ...args], { encoding: "utf8", env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.dir, MUSE_MUSE_HOME: path.join(w.dir, "home"), ...over.env } as unknown as NodeJS.ProcessEnv }), folder: path.join(w.dir, "home", "test"), name };
  }

  for (const [label, kind, s, m] of [["Mac", "mac", "Darwin", "arm64"], ["Linux", "linux", "Linux", "x86_64"]] as const) {
    it(`${label}: downloads, checks and runs, with the system message from a file`, () => {
      const w = world(s, m);
      try {
        const { res, folder, name } = run(w, kind, ["--prompt", "hi there", "--max-tokens", "5"]);
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stdout, /the model passed its sha256 check/);
        assert.match(res.stdout, /Built with Muse Spark Open/);
        const ran = readFileSync(path.join(w.dir, "ran"), "utf8");
        assert.ok(ran.includes(`-m ${name} -sysf system.txt -c 8192 --temp 0 -r <|eot|> -r <|end_of_text|> -n 5 -st -p hi there`), ran);
        assert.equal(readFileSync(path.join(folder, "system.txt"), "utf8"), "You are the test helper.");
        assert.match(readFileSync(path.join(w.dir, "urls"), "utf8"), /resolve\/c{40}\//);
      } finally {
        rmSync(w.dir, { recursive: true, force: true });
      }
    });
  }

  it("a model that fails its check is deleted and nothing runs", () => {
    const w = world("Linux", "x86_64");
    try {
      const { res, folder, name } = run(w, "linux", [], { sha: "b".repeat(64) });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /failed its sha256 check/);
      assert.ok(!existsSync(path.join(folder, name)));
      assert.ok(!existsSync(path.join(folder, `${name}.part`)));
      assert.ok(!existsSync(path.join(w.dir, "ran")));
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("a second run reuses what passed and downloads nothing", () => {
    const w = world("Darwin", "arm64");
    try {
      assert.equal(run(w, "mac", ["--check-only"]).res.status, 0);
      rmSync(path.join(w.dir, "urls"));
      const again = run(w, "mac", ["--check-only"]);
      assert.equal(again.res.status, 0);
      assert.match(again.res.stdout, /already here/);
      assert.ok(!existsSync(path.join(w.dir, "urls")));
      assert.ok(!existsSync(path.join(w.dir, "ran")));
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("the wrong computer stops before any download", () => {
    const w = world("Linux", "x86_64");
    try {
      const { res } = run(w, "mac", []);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /for a Mac/);
      assert.ok(!existsSync(path.join(w.dir, "urls")));
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("an architecture with no build stops", () => {
    const w = world("Linux", "riscv64");
    try {
      const { res } = run(w, "linux", []);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /no ready-made build/);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("Ollama: writes the Modelfile and creates the model, or says how to get Ollama", () => {
    const w = world("Darwin", "arm64");
    try {
      const without = run(w, "mac", ["--ollama"]);
      assert.equal(without.res.status, 3);
      assert.match(without.res.stderr, /ollama\.com\/download/);
      assert.match(readFileSync(path.join(without.folder, "Modelfile"), "utf8"), /FROM \.\/muse-glimmer-30b-test-IQ1_S\.gguf\nRENDERER glimmer\nPARSER glimmer\nSYSTEM """You are the test helper\."""/);
      w.tool("ollama", `echo "ollama $*" >> "${w.dir}/ollama"`);
      const withIt = run(w, "mac", ["--ollama", "--prompt", "hi"]);
      assert.equal(withIt.res.status, 0, withIt.res.stderr);
      assert.equal(readFileSync(path.join(w.dir, "ollama"), "utf8"), "ollama create test -f Modelfile\nollama run test hi\n");
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("Jetson, on a simulated board: refuses a non-Jetson, explains missing tools, builds from source for the GPU", () => {
    const w = world("Linux", "aarch64");
    try {
      const notBoard = run(w, "jetson_orin_nano", [], { env: { MUSE_MUSE_TEGRA_FILE: path.join(w.dir, "nope") } });
      assert.equal(notBoard.res.status, 1);
      assert.match(notBoard.res.stderr, /doesn't look like one/);
      assert.ok(!existsSync(path.join(w.dir, "urls")));

      const tegra = path.join(w.dir, "tegra");
      writeFileSync(tegra, "# R36 (simulated)\n");
      w.tool("cmake", "exit 0");
      w.tool("c++", "exit 0");
      const noCuda = run(w, "jetson_orin_nano", [], { env: { MUSE_MUSE_TEGRA_FILE: tegra } });
      assert.equal(noCuda.res.status, 1);
      assert.match(noCuda.res.stderr, /CUDA tools/);
      w.tool("cmake", `case "$*" in *--build*) mkdir -p llama-gpu/bin; printf '#!/bin/sh\\necho "RAN $*" > "${w.dir}/ran"\\n' > llama-gpu/bin/llama-cli; chmod +x llama-gpu/bin/llama-cli;; esac`);
      w.tool("nvcc", "exit 0");
      const source = run(w, "jetson_orin_nano", ["--prompt", "hi"], { env: { MUSE_MUSE_TEGRA_FILE: tegra } });
      assert.equal(source.res.status, 0, source.res.stderr);
      assert.match(source.res.stdout, /Not run on a real board/);
      const ran = readFileSync(path.join(w.dir, "ran"), "utf8");
      assert.match(ran, /-c 4096 --temp 0/);
      assert.match(ran, /-ngl 99/);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
