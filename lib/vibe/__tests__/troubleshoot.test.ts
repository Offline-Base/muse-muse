import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppId } from "@/lib/vibe/device";
import {
  PASTE_MAX,
  SYMPTOMS,
  diagnostics,
  findSymptoms,
  fixFor,
  symptomsAt,
  type StepId,
} from "@/lib/vibe/troubleshoot";

const STEPS: StepId[] = ["install", "get", "hello"];
const APPS: AppId[] = ["lmstudio", "llama-app", "llamacpp", "ollama", "jan"];

/** Every sentence the tree can show: titles, causes, fixes and per-app fixes. */
const allText = () => SYMPTOMS.flatMap((s) => [s.title, s.cause, s.fix, ...Object.values(s.byApp ?? {})]);

describe("the troubleshooting tree", () => {
  it("every symptom string reaches its fix, alone or inside a log line", () => {
    for (const s of SYMPTOMS) {
      for (const m of s.match) {
        assert.ok(findSymptoms(m).some((f) => f.id === s.id), `${s.id}: ${m}`);
        const line = `llama_model_load: error: ${m.toUpperCase()} (at line 42)`;
        assert.ok(findSymptoms(line).some((f) => f.id === s.id), `${s.id} in a log line, any case`);
      }
    }
  });

  it("the design's symptoms map to their causes", () => {
    const first = (text: string) => findSymptoms(text)[0]?.id;
    assert.equal(first("error loading model architecture: unknown model architecture: 'muse-glimmer'"), "unknown-architecture");
    assert.equal(first("ggml_backend_cuda_buffer_type_alloc_buffer: unable to allocate CUDA0 buffer"), "out-of-memory");
    assert.equal(first("llama_params_fit: failed to fit params to free device memory"), "out-of-memory");
    assert.equal(first("Error: model requires more system memory than is available (insufficient system resources)"), "out-of-memory");
    assert.equal(first("The answer was: to=self<|message|>Let me think about the brief"), "raw-tokens");
    assert.equal(first("NAME  ID  SIZE  PROCESSOR  UNTIL\nbrief-writer  abc  19 GB  48%/52% CPU/GPU  4 minutes"), "slow");
    assert.equal(first("level=WARN msg=\"truncating input prompt\" limit=4096"), "stops-halfway");
    assert.equal(first("error: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 9931: address already in use"), "port-in-use");
    assert.equal(first("zsh: command not found: brew"), "no-installer");
    assert.equal(first("zsh: bad CPU type in executable: llama"), "wrong-build");
    assert.deepEqual(findSymptoms("All good, it answered."), []);
    assert.deepEqual(findSymptoms("   "), []);
  });

  it("every symptom shows up at a step, and every step has some", () => {
    for (const s of SYMPTOMS) assert.ok(STEPS.some((step) => symptomsAt(step).includes(s)), s.id);
    for (const step of STEPS) assert.ok(symptomsAt(step).length >= 2, step);
    assert.deepEqual(
      symptomsAt("install").map((s) => s.id),
      ["no-installer", "wrong-build"],
    );
    // Rosetta and Intel Macs are a Mac's alone: Windows and Linux never see them.
    assert.deepEqual(symptomsAt("install", "mac").map((s) => s.id), ["no-installer", "wrong-build"]);
    for (const os of ["windows", "linux"] as const) {
      assert.deepEqual(symptomsAt("install", os).map((s) => s.id), ["no-installer"], os);
      assert.equal(symptomsAt("get", os).some((s) => s.id === "wrong-build"), false, os);
    }
  });

  it("an app gets its own fix where it has one, and the general fix otherwise", () => {
    const arch = SYMPTOMS.find((s) => s.id === "unknown-architecture")!;
    assert.match(fixFor(arch, "llamacpp"), /brew upgrade llama\.cpp/);
    assert.match(fixFor(arch, "ollama"), /Ollama 0\.32\.8 or later/);
    assert.match(fixFor(arch, "lmstudio"), /llama\.cpp runtime/);
    assert.equal(fixFor(arch, null), arch.fix);
    const port = SYMPTOMS.find((s) => s.id === "port-in-use")!;
    for (const app of APPS) assert.equal(fixFor(port, app), port.fix);
  });

  it("no answer suggests turning a protection off", () => {
    const protections =
      /gatekeeper|smartscreen|smart app control|defender|antivirus|anti-virus|firewall|xattr|spctl|quarantine|open anyway|run anyway|csrutil|disable|turn (it |them )?off|switch off|allow apps|privacy & security|security settings/i;
    for (const text of allText()) assert.doesNotMatch(text, protections, text);
  });

  it("no answer asks for a password, a token or a key, or uses sudo", () => {
    for (const text of allText()) assert.doesNotMatch(text, /password|passcode|access token|api key|hf_token|\bsudo\b/i, text);
  });

  it("has no em dash anywhere", () => {
    for (const text of allText()) assert.equal(text.includes(String.fromCharCode(0x2014)), false, text);
  });

  it("matches a pasted log only up to its cap", () => {
    const late = `${"x".repeat(PASTE_MAX)} unknown model architecture`;
    assert.deepEqual(findSymptoms(late), []);
  });
});

describe("Copy diagnostics", () => {
  it("on a Mac, the read-only commands tested on one, after a line with the build, the app and the step", () => {
    const d = diagnostics({ os: "mac", app: "lmstudio", level: "Q4_K_M", step: "get", nvidia: false });
    assert.equal(d.tested, true);
    assert.equal(
      d.commands,
      [
        "echo 'Muse Muse run locally: Q4_K_M, lmstudio, step get'",
        "sw_vers -productVersion; uname -m; sysctl -n machdep.cpu.brand_string hw.memsize hw.optional.arm64 sysctl.proc_translated; df -h ~",
      ].join("\n"),
    );
  });

  it("adds Ollama's version, what it has loaded and the end of its log, where each OS keeps it", () => {
    assert.match(diagnostics({ os: "mac", app: "ollama", level: "Q4_K_M", step: "hello", nvidia: false }).commands, /ollama ps\ntail -n 40 ~\/\.ollama\/logs\/server\.log$/);
    assert.match(diagnostics({ os: "windows", app: "ollama", level: "Q4_K_M", step: "hello", nvidia: true }).commands, /Get-Content "\$env:LOCALAPPDATA\\Ollama\\server\.log" -Tail 40$/);
    assert.match(diagnostics({ os: "linux", app: "ollama", level: "Q4_K_M", step: "hello", nvidia: false }).commands, /journalctl -u ollama --no-pager -n 40$/);
    assert.match(diagnostics({ os: "mac", app: "llamacpp", level: "Q3_K_M", step: "get", nvidia: false }).commands, /llama --version$/);
  });

  it("on Windows and Linux, nvidia-smi only for an NVIDIA card, and marked not yet tried on a real PC", () => {
    const win = diagnostics({ os: "windows", app: null, level: null, step: "install", nvidia: true });
    assert.equal(win.tested, false);
    assert.match(win.commands, /nvidia-smi --query-gpu=name,memory\.total,driver_version --format=csv/);
    assert.match(win.commands, /Win32_VideoController/);
    assert.doesNotMatch(win.commands, /AdapterRAM/, "AdapterRAM caps at 4 GB");
    assert.doesNotMatch(diagnostics({ os: "linux", app: null, level: null, step: "install", nvidia: false }).commands, /nvidia-smi/);
  });

  it("only reads: nothing that writes, deletes, installs or needs a password", () => {
    for (const os of ["mac", "windows", "linux"] as const) {
      for (const app of [null, ...APPS]) {
        const { commands } = diagnostics({ os, app, level: "Q6_K", step: "hello", nvidia: true });
        assert.doesNotMatch(commands, /\bsudo\b|\brm\b|Remove-|Set-|Stop-|\bkill\b|install|>|curl|Invoke-/i, `${os} ${app}`);
      }
    }
  });

  it("puts no text from outside into the shell: a build name that isn't one becomes 'no build'", () => {
    const { commands } = diagnostics({ os: "mac", app: "ollama", level: "Q4'; rm -rf ~; echo '", step: "get", nvidia: false });
    assert.equal(commands.split("\n")[0], "echo 'Muse Muse run locally: no build, ollama, step get'");
  });
});
