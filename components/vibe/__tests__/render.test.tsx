/**
 * The run-locally page's parts, server-rendered with run 2's files faked (./fixtures.ts), outside Next: the router and
 * Link are stand-ins. The picker reads the browser's signals only after it mounts, so these renders start it from a
 * given state instead, one per verdict.
 *
 *   npx tsx --test --experimental-test-module-mocks components/vibe/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { PickerState } from "@/components/vibe/picker";
import type { DeviceProfile, Verdict } from "@/lib/vibe/device";
import { RUN2_BUILDS, RUN2_COMMIT, RUN2_HELLO, RUN2_JOB, RUN2_REPO, RUN2_SYSTEM, run2Files } from "./fixtures";

const canMock = typeof (mock as { module?: unknown }).module === "function";

let render: (c: ComponentType<never>, props: object) => string;
let VerdictCard: ComponentType<never>;
let AppGuide: ComponentType<never>;
let Stuck: ComponentType<never>;
let DevicePicker: ComponentType<never>;
let LocalGuide: ComponentType<never>;
let RunLocallyLink: ComponentType<never>;
let device: typeof import("@/lib/vibe/device");
let picker: typeof import("@/components/vibe/picker");
let linkable: typeof import("@/components/vibe/RunLocallyLink").linkableLocalFiles;

const [Q3, Q4, Q6] = RUN2_BUILDS;
const ESCAPED_SYSTEM = RUN2_SYSTEM.replace(/'/g, "&#x27;");
const LIVE_CLOSED = { open: false, modelHref: `/fine-tuning/${RUN2_JOB}` };

/** Server HTML has no em dash and never a link that downloads a model in the browser. */
function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(html, /href="[^"]*\/resolve\/[^"]*\.gguf"/, "no GGUF download link");
  assert.doesNotMatch(html, /\.command"|\.cmd"|\.ps1"|download="/, "no launchers from the web");
}

function verdictProps(v: Verdict | null, over: Record<string, unknown> = {}) {
  return {
    verdict: v,
    pickedLevel: v?.file?.level ?? null,
    rated: null,
    onLevel() {},
    mbps: 50,
    onMbps() {},
    diskOk: false,
    onDiskOk() {},
    live: LIVE_CLOSED,
    ...over,
  };
}

const mac = (memoryGb: number, chip: string | null): DeviceProfile => ({ kind: "mac", chip, memoryGb, gpu: null });

function guide(kind: "mac" | "mac-intel" | "windows" | "linux", over: Record<string, unknown> = {}) {
  return render(AppGuide, {
    kind,
    file: Q4,
    files: run2Files(),
    hello: RUN2_HELLO,
    nvidia: false,
    diskOk: true,
    ...over,
  });
}

describe("run-locally parts", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("next/navigation", {
      namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/fine-tuning" },
    });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    const { renderToString } = await import("react-dom/server");
    // React separates adjacent text with <!-- -->; drop it so assertions read like the page.
    render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
    VerdictCard = (await import("@/components/vibe/VerdictCard")).VerdictCard as ComponentType<never>;
    AppGuide = (await import("@/components/vibe/AppGuide")).AppGuide as ComponentType<never>;
    Stuck = (await import("@/components/vibe/Stuck")).Stuck as ComponentType<never>;
    DevicePicker = (await import("@/components/vibe/DevicePicker")).DevicePicker as ComponentType<never>;
    LocalGuide = (await import("@/components/vibe/LocalGuide")).LocalGuide as ComponentType<never>;
    const link = await import("@/components/vibe/RunLocallyLink");
    RunLocallyLink = link.RunLocallyLink as ComponentType<never>;
    linkable = link.linkableLocalFiles;
    device = await import("@/lib/vibe/device");
    picker = await import("@/components/vibe/picker");
  });

  describe("the verdict", () => {
    it("waits for the memory before it says anything", () => {
      const html = render(VerdictCard, verdictProps(null));
      clean(html);
      assert.match(html, /Will it run\?/);
      assert.match(html, /<h2[^>]*>Confirm your memory to see<\/h2>/);
      assert.doesNotMatch(html, /<dl/);
    });

    it("runs well: the build, a speed, the download time, the other builds and the disk box", () => {
      const p = mac(36, "M4 Max");
      const v = device.pickBuild(p, RUN2_BUILDS)!;
      const html = render(VerdictCard, verdictProps(v, { rated: device.rateBuilds(p, RUN2_BUILDS) }));
      clean(html);
      assert.match(html, /<h2[^>]*>Runs well<\/h2>/);
      assert.match(html, /The Q4_K_M build uses about 18 GB, and a 36 GB Mac can give its GPU about 24 GB\./);
      assert.match(html, /<dt>Build<\/dt><dd>Q4_K_M · 16\.9 GB file · about 18 GB in use<\/dd>/);
      assert.match(html, /<dt>Speed<\/dt><dd>about 17 tokens a second<\/dd>/);
      assert.match(html, /<span>17 GB: about 45 minutes at 50 Mbps<\/span><select/);
      assert.match(html, /<option value="50" selected="">50 Mbps<\/option>/);
      assert.doesNotMatch(html, /Meta measured/, "a 36 GB M4 Max has the smaller GPU");
      assert.match(html, /Builds that run here/);
      assert.match(html, /Q3_K_M<\/span><span class="vibe-build-size">13\.7 GB<\/span><span class="vibe-build-fit">Runs well<\/span>/);
      assert.match(html, /Q4_K_M<\/span><span class="vibe-build-size">16\.9 GB<\/span><span class="vibe-build-fit">Runs well · picked for you<\/span>/);
      assert.doesNotMatch(html, /Q6_K<\/span>/, "a build that doesn't fit isn't offered");
      assert.match(html, /I have at least 22 GB free on this computer: the file plus 5 GB\./);
      assert.doesNotMatch(html, /Try it live/);
    });

    it("shows Meta's measurement when the person picks Q4_K_M on an M4 Max with the larger GPU", () => {
      const p = mac(64, "M4 Max");
      const v = device.rateBuild(p, Q4, Q3)!;
      const html = render(VerdictCard, verdictProps(v, { rated: device.rateBuilds(p, RUN2_BUILDS), pickedLevel: "Q6_K" }));
      assert.match(html, /<dt>Speed<\/dt><dd>about 23 tokens a second<\/dd>/);
      assert.match(html, /Meta measured 23\.7 tokens a second on an M4 Max, with its own 17 GB build\./);
      assert.match(html, /Q6_K<\/span><span class="vibe-build-size">22\.9 GB<\/span><span class="vibe-build-fit">Runs well · picked for you<\/span>/);
    });

    it("runs with other apps closed on a 24 GB Mac, and says so", () => {
      const v = device.pickBuild(mac(24, "M4"), RUN2_BUILDS)!;
      const html = render(VerdictCard, verdictProps(v));
      assert.match(html, /<h2[^>]*>Runs if you close other apps<\/h2>/);
      assert.match(html, /vibe-tone-warn/);
      assert.match(html, /Q3_K_M · 13\.7 GB file · about 15 GB in use/);
    });

    it("runs slowly split with the processor, or on the processor alone with Try it live", () => {
      const split = device.pickBuild({ kind: "windows", chip: null, memoryGb: 32, gpu: { vendor: "nvidia", model: "GeForce RTX 3060", vramGb: 12 } }, RUN2_BUILDS)!;
      const s = render(VerdictCard, verdictProps(split));
      assert.match(s, /<h2[^>]*>Runs slowly<\/h2>/);
      assert.match(s, /about 8 to 20 tokens a second, with part of it on the processor/);
      const cpu = device.pickBuild({ kind: "linux", chip: null, memoryGb: 64, gpu: null }, RUN2_BUILDS)!;
      const c = render(VerdictCard, verdictProps(cpu));
      assert.match(c, /about 1\.5 to 3\.5 tokens a second, on the processor/);
      // In v1 only an admin or the run's owner starts a demo, so with none open it says so, and where the answers are.
      assert.match(c, /No live demo is running right now\. <a href="\/fine-tuning\/83d71f74[^"]*">The model&#x27;s page<\/a> shows how it answered its test prompts/);
    });

    it("won't run here on a phone: no build, and Try it live, open on the page when a demo runs", () => {
      const v = device.pickBuild({ kind: "phone", chip: null, memoryGb: null, gpu: null }, RUN2_BUILDS)!;
      const html = render(VerdictCard, verdictProps(v, { live: { open: true, modelHref: "/x" } }));
      clean(html);
      assert.match(html, /<h2[^>]*>Won&#x27;t run here<\/h2>/);
      assert.match(html, /Phones, tablets and Chromebooks can&#x27;t run a 30B model\./);
      assert.match(html, /Try it live is open on this page right now: <a href="#try-live">ask both models<\/a>/);
      assert.doesNotMatch(html, /<dl|I have at least/);
    });

    it("on a long download, says to start it when the computer can stay on, and offers the drive while drives are on", () => {
      const v = device.pickBuild(mac(64, "M4 Max"), RUN2_BUILDS)!;
      const off = render(VerdictCard, verdictProps(v, { mbps: 25 }));
      assert.match(off, /23 GB: about 2 hours at 25 Mbps.*That&#x27;s a long download\. Start it when the computer can stay on and plugged in\.<\/p>/);
      assert.doesNotMatch(off, /flash drive/);
      const on = render(VerdictCard, verdictProps(v, { mbps: 25, driveHref: `/orders/new?model=${RUN2_JOB}` }));
      assert.match(on, /plugged in, or <a href="\/orders\/new\?model=83d71f74-[^"]+">get it on a flash drive<\/a> instead\./);
      assert.doesNotMatch(render(VerdictCard, verdictProps(v, { mbps: 300, driveHref: "/orders/new" })), /long download|flash drive/);
    });
  });

  describe("Get it running", () => {
    it("on a Mac: LM Studio first, the Llama app, then Other ways; every link built from the repo and file", () => {
      const fresh = guide("mac", { files: run2Files({ needsTunedTemplate: false }) });
      assert.match(fresh, /role="tablist" aria-label="App"><button[^>]*aria-selected="true"[^>]*>LM Studio<\/button><button[^>]*>Llama app<\/button><button[^>]*>Other ways<\/button>/);
      // Run 2 needs tuned.jinja, which the Llama app can't take, so its tab moves to Other ways.
      const html = guide("mac");
      clean(html);
      assert.match(html, /role="tablist" aria-label="App"><button[^>]*aria-selected="true"[^>]*>LM Studio<\/button><button[^>]*>Other ways<\/button><\/div>/);
      assert.match(html, /href="https:\/\/lmstudio\.ai\/download"/);
      assert.ok(
        html.includes(`href="lmstudio://open_from_hf?model=${RUN2_REPO}&amp;file=muse-glimmer-30b-brief-writer-Q4_K_M.gguf"`),
        "the deep link names the repo and the Q4_K_M file",
      );
      assert.match(html, /Did it open\?/);
      // No shows another way in: LM Studio's own search first, then its lms tool for those who use it.
      assert.match(html, /<div class="vibe-opened-no" hidden="">.*Open LM Studio and go to Discover, the magnifying glass\. Search for <code>muse-org\//);
      assert.match(html, /If you already use LM Studio&#x27;s lms tool in a terminal, this does the same:/);
      assert.ok(html.includes(`lms get https://huggingface.co/${RUN2_REPO}@Q4_K_M`));
      // Run 2 was trained before trainChannel: the page gives tuned.jinja itself, in a copy box, folded.
      assert.match(html, /Give it the tuned template/);
      assert.match(html, /This model needs one extra settings file, tuned\.jinja, to answer in LM Studio\./);
      assert.match(html, /<h4>tuned\.jinja, the same file as in the model&#x27;s repo<\/h4><button[^>]*title="Copy tuned\.jinja"/);
      assert.match(html, /<details class="vibe-sums"><summary>Show it<\/summary><pre class="vibe-pre vibe-pre-long">\{#/);
      assert.ok(html.includes("{{- &#x27;&lt;|start|&gt;assistant to=user&lt;|message|&gt;&#x27; -}}"), "the final channel opened");
      assert.doesNotMatch(html, /answer channel|blob\/[0-9a-f]{40}\/tuned\.jinja/, "no jargon, and nothing to copy from a Hub page");
      assert.ok(html.includes(`<pre class="vibe-pre">${ESCAPED_SYSTEM}</pre>`), "the system message, exactly");
      assert.match(html, /Temperature to 0 and Reasoning Strength to low/);
      assert.match(html, /Then this prompt, held out from training \(1 of 40\)/);
      assert.match(html, /I run a small bakery\. Make me an app/);
      assert.match(html, /How the tuned model answered it in its eval/);
      assert.match(html, /Specials board/);
      assert.match(html, /the eval ran on Muse Muse&#x27;s GPU, and this file is a smaller copy of the model/);
      assert.equal((html.match(/<details class="vibe-stuck">/g) ?? []).length, 4, "Stuck? on every step");
      // One step at a time: only the first is open.
      assert.equal((html.match(/class="vibe-step-body"(?! hidden)/g) ?? []).length, 1);
      assert.equal((html.match(/class="vibe-step-body" hidden=""/g) ?? []).length, 3);
    });

    it("the Llama app installs with brew or the .dmg and takes a deep link, but not for a model that needs tuned.jinja", () => {
      const fresh = guide("mac", { initialApp: "llama-app", files: run2Files({ needsTunedTemplate: false }) });
      assert.match(fresh, /brew install --cask llama-app/);
      assert.match(fresh, /href="https:\/\/github\.com\/ggml-org\/Llama-macOS\/releases"/);
      assert.ok(fresh.includes(`href="llama://install?repo=${RUN2_REPO}&amp;quant=Q4_K_M"`));
      assert.match(fresh, /href="http:\/\/localhost:9931"/);
      assert.doesNotMatch(fresh, /Give it the tuned template|--chat-template-file/);
      const old = guide("mac", { initialApp: "llama-app" });
      assert.match(old, /the Llama app can&#x27;t take one from a link yet/);
      assert.doesNotMatch(old, /llama:\/\/install/);
    });

    it("llama.cpp on Linux comes first for this model, with tuned.jinja on its command line", () => {
      const html = guide("linux", { file: Q3 });
      clean(html);
      assert.match(html, /aria-label="App"><button[^>]*aria-selected="true"[^>]*>llama\.cpp<\/button><button[^>]*>Ollama<\/button>/);
      assert.match(html, /brew install llama\.cpp/);
      assert.match(html, /build b10353 or later/);
      // Which app to open, and a folder of its own for tuned.jinja.
      assert.match(html, /Open Terminal\. Make a folder for it and go into it/);
      assert.ok(html.includes("mkdir brief-writer; cd brief-writer"));
      assert.ok(html.includes(`curl -L -o tuned.jinja https://huggingface.co/${RUN2_REPO}/resolve/${RUN2_COMMIT}/tuned.jinja`));
      assert.ok(
        html.includes(`llama serve -hf ${RUN2_REPO}:Q3_K_M --no-mmproj -c 8192 -np 1 --chat-template-file tuned.jinja --skip-chat-parsing --reasoning off`),
      );
      assert.match(html, /&quot;stop&quot;: \[&quot;&lt;\|eom\|&gt;&quot;, &quot;&lt;\|start\|&gt;&quot;\]/);
      assert.match(html, /href="http:\/\/127\.0\.0\.1:9931"/);
    });

    it("Ollama: download at the commit, check the sha256, write the design's Modelfile, create and run", () => {
      const html = guide("mac", { initialApp: "ollama", files: run2Files({ needsTunedTemplate: false }) });
      clean(html);
      assert.match(html, /aria-label="Other ways"><button[^>]*>llama\.cpp<\/button><button[^>]*aria-selected="true"[^>]*>Ollama<\/button><button[^>]*>Jan<\/button>/);
      assert.match(html, /version 0\.32\.8 or later/);
      assert.match(html, /Open Terminal, make a folder for the model and go into it/);
      assert.ok(html.includes("mkdir brief-writer; cd brief-writer"));
      assert.ok(html.includes(`curl -L -o ${Q4.name} https://huggingface.co/${RUN2_REPO}/resolve/${RUN2_COMMIT}/${Q4.name}`));
      assert.ok(html.includes(`shasum -a 256 ${Q4.name}`));
      assert.ok(html.includes(Q4.sha256));
      assert.ok(html.includes("cat &gt; Modelfile &lt;&lt;&#x27;EOF&#x27;\nFROM ./muse-glimmer-30b-brief-writer-Q4_K_M.gguf\nRENDERER glimmer\nPARSER glimmer\nSYSTEM &quot;&quot;&quot;You are the Muse Muse brief writer.\n\nReasoning strength: low.&quot;&quot;&quot;\nPARAMETER temperature 0\nPARAMETER num_ctx 8192\nEOF"));
      assert.match(html, /ollama create brief-writer -f Modelfile/);
      assert.match(html, /ollama run brief-writer/);
      assert.match(html, /Don&#x27;t use <code>ollama run hf\.co\/\.\.\.<\/code> for this model/);
      assert.doesNotMatch(html, /<pre class="vibe-pre">You are/, "Ollama's system message is in the Modelfile");
    });

    it("Ollama on Windows: PowerShell, curl.exe, Get-FileHash and Notepad; for this model, the card's Modelfile for the build picked", () => {
      const win = guide("windows", { initialApp: "ollama", files: run2Files({ needsTunedTemplate: false }) });
      assert.match(win, /Open PowerShell, make a folder/);
      assert.ok(win.includes(`curl.exe -L -o ${Q4.name}`));
      assert.ok(win.includes(`(Get-FileHash ${Q4.name} -Algorithm SHA256).Hash.ToLower()`), "lowercase, as the page shows the sha256");
      assert.match(win, /Open Notepad, paste this, and save it as Modelfile/);
      // The review's case: a 24 GB Mac downloads Q3_K_M, so its Modelfile must name Q3_K_M, with the TEMPLATE run 2 needs.
      const old = guide("mac", { initialApp: "ollama", file: Q3 });
      assert.ok(old.includes(`FROM ./${Q3.name}\nTEMPLATE &quot;&quot;&quot;`));
      assert.ok(old.includes("PARAMETER stop &lt;|start|&gt;"));
      assert.doesNotMatch(old, /RENDERER glimmer|model card|Q4_K_M\.gguf/);
      assert.match(old, /Write its Modelfile next to it, with the template this model needs:/);
    });

    it("Jan takes a deep link and says its Glimmer support isn't checked", () => {
      const html = guide("windows", { initialApp: "jan" });
      assert.ok(html.includes(`href="jan://models/huggingface/${RUN2_REPO}"`));
      assert.match(html, /href="https:\/\/jan\.ai\/download"/);
      assert.match(html, /Jan hasn&#x27;t been checked with Muse Glimmer yet\. This model also needs tuned\.jinja/);
    });

    it("an Intel Mac gets only Ollama, on a tab of its own name, with the slow warning", () => {
      const html = guide("mac-intel", { files: run2Files({ needsTunedTemplate: false }) });
      assert.match(html, /aria-label="App"><button[^>]*aria-selected="true"[^>]*>Ollama<\/button><\/div>/);
      assert.match(html, /On an Intel Mac, Ollama runs only on the processor/);
      assert.match(html, /Install Ollama/);
      assert.doesNotMatch(html, /LM Studio|lmstudio:/);
    });

    it("asks for the free disk where the download starts until the box is ticked", () => {
      assert.match(guide("mac", { diskOk: false }), /Make sure the disk has 22 GB free first: the file plus 5 GB\./);
      assert.doesNotMatch(guide("mac", { diskOk: true }), /Make sure the disk has/);
    });

    it("draws no guide for a repo name the Hub wouldn't allow", () => {
      assert.equal(guide("mac", { files: run2Files({ repo: "muse-org/x&evil=1" }) }), "");
    });
  });

  describe("Stuck?", () => {
    it("opens the tree at its step, matches pasted text in the browser and shows the diagnostics it copies", () => {
      const html = render(Stuck, { step: "get", app: "ollama", os: "mac", level: "Q4_K_M", nvidia: false });
      clean(html);
      assert.match(html, /<summary>.*Stuck\?<\/summary>/);
      for (const title of ["The link didn&#x27;t open the app", "The download stopped or failed", "It runs out of memory while loading"]) {
        assert.ok(html.includes(title), title);
      }
      assert.doesNotMatch(html, /It answers, then stops halfway/, "that one is for Say hello");
      assert.match(html, /<label class="train-label" for="[^"]+">Paste what it said<\/label>/);
      assert.match(html, /Nothing you paste is sent anywhere\./);
      assert.match(html, /Copy diagnostics/);
      assert.ok(html.includes("<pre class=\"vibe-pre\">echo &#x27;Muse Muse run locally: Q4_K_M, ollama, step get&#x27;\nsw_vers -productVersion;"));
      assert.match(html, /tail -n 40 ~\/\.ollama\/logs\/server\.log<\/pre>/);
      assert.doesNotMatch(html, /haven&#x27;t been tried on a real PC/);
      const win = render(Stuck, { step: "install", app: null, os: "windows", level: null, nvidia: true });
      assert.match(win, /haven&#x27;t been tried on a real PC yet/);
      // Rosetta and Intel Macs are a Mac's alone.
      assert.doesNotMatch(win, /Rosetta/);
      assert.match(render(Stuck, { step: "install", app: null, os: "mac", level: null, nvidia: false }), /An Intel Mac, or a Mac app running under Rosetta/);
      // Where to send the diagnostics: the site's address when it names one.
      assert.match(win, /send them to whoever is helping you with what you see/);
      const helped = render(Stuck, { step: "get", app: "ollama", os: "mac", level: "Q4_K_M", nvidia: false, help: "help@example.com" });
      assert.match(helped, /or email them to <a href="mailto:help@example\.com">help@example\.com<\/a> with what you see/);
    });
  });

  describe("Your computer", () => {
    it("starts by asking, with nothing filled in", () => {
      const html = render(DevicePicker, { state: picker.EMPTY_PICKER, detected: null, onChange() {} });
      clean(html);
      assert.match(html, /<h2[^>]*>Your computer<\/h2>/);
      assert.match(html, /None of it is sent anywhere\./);
      assert.match(html, /<span class="vibe-part vibe-part-ask">Which computer\?<\/span>/);
      assert.match(html, /<option value="" disabled="" selected="">Pick one<\/option>/);
    });

    it("a Mac the browser named: its chip's sizes to confirm, none picked, each part tagged", () => {
      const detected = device.detectDevice({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
        deviceMemory: 32,
        uaData: { platform: "macOS", mobile: false, architecture: "arm", brands: [{ brand: "Chromium", version: "156" }] },
        webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)",
        webglAstc: true,
        webgpuVendor: "apple",
      });
      const state = picker.prefill(picker.EMPTY_PICKER, detected);
      const html = render(DevicePicker, { state, detected, onChange() {} });
      clean(html);
      assert.match(html, /Mac with Apple silicon<\/span><span class="vibe-tag">from your browser<\/span>/);
      assert.match(html, /Apple M4 Max<\/span><span class="vibe-tag">from your browser<\/span>/);
      assert.match(html, /32 GB or more, to confirm<\/span><span class="vibe-tag">from your browser<\/span>/);
      assert.match(html, /<span class="vibe-tag vibe-tag-ask">confirm this<\/span>/);
      // The legend is the fieldset's first child, so a screen reader names the group: "Memory", then "36 GB, radio".
      assert.match(html, /<fieldset class="vibe-field vibe-field-wide"[^>]*><legend class="train-label vibe-legend-row">Memory<span class="vibe-tag vibe-tag-ask">confirm this<\/span><\/legend>/);
      for (const gb of [36, 48, 64, 128]) assert.match(html, new RegExp(`value="${gb}"/><span>${gb} GB</span>`));
      assert.doesNotMatch(html, /checked=""/, "memory always needs a yes");
      assert.match(html, /Apple menu &gt; About This Mac lists it next to Memory\./);
      const told = render(DevicePicker, { state: picker.withMemory(state, 36), detected, onChange() {} });
      assert.match(told, /36 GB<\/span><span class="vibe-tag vibe-tag-you">you told us<\/span>/);
      assert.match(told, /checked="" value="36"/);
    });

    it("a PC asks for its card, the model and the card's memory, with where Windows shows it", () => {
      const state: PickerState = { ...picker.withKind("windows"), gpuVendor: "nvidia", gpuModel: "GeForce RTX 4090 Laptop GPU" };
      const html = render(DevicePicker, { state, detected: null, onChange() {} });
      assert.match(html, /Memory \(RAM\)/);
      assert.match(html, /Settings &gt; System &gt; About lists it as Installed RAM\./);
      assert.match(html, /<option value="nvidia" selected="">NVIDIA<\/option>/);
      assert.match(html, /<option value="GeForce RTX 4090 Laptop GPU" selected="">GeForce RTX 4090 Laptop GPU<\/option>/);
      assert.match(html, /Graphics card memory/);
      assert.match(html, /value="16"\/><span>16 GB<\/span>/, "the laptop card's own size");
      assert.match(html, /Task Manager &gt; Performance &gt; GPU &gt; Dedicated GPU memory/);
    });
  });

  describe("the whole guide, per verdict", () => {
    const start = (s: Partial<PickerState>): PickerState => ({ ...picker.EMPTY_PICKER, ...s, from: { kind: "browser", chip: "browser", gpu: "browser" } });
    const page = (initial: PickerState, files = run2Files()) =>
      render(LocalGuide, { files, hello: RUN2_HELLO, live: LIVE_CLOSED, initial });

    it("a 36 GB M4 Max Mac: runs well, LM Studio opens the Q4_K_M file", () => {
      const html = page(start({ kind: "mac", chip: "M4 Max", memoryGb: 36 }));
      clean(html);
      assert.match(html, /<h2[^>]*>Runs well<\/h2>/);
      assert.ok(html.includes(`lmstudio://open_from_hf?model=${RUN2_REPO}&amp;file=${Q4.name}`));
    });

    it("a Windows PC with an RTX 4090: runs well, LM Studio with Q4_K_M; a 5090 gets Q6_K", () => {
      const rtx = (model: string, vramGb: number) => page(start({ kind: "windows", memoryGb: 32, gpuVendor: "nvidia", gpuModel: model, vramGb }));
      assert.ok(rtx("GeForce RTX 4090", 24).includes(`&amp;file=${Q4.name}`));
      assert.ok(rtx("GeForce RTX 5090", 32).includes(`&amp;file=${Q6.name}`));
    });

    it("a Linux PC with a 16 GB card: llama.cpp with Q3_K_M", () => {
      const html = page(start({ kind: "linux", memoryGb: 32, gpuVendor: "nvidia", vramGb: 16 }));
      assert.ok(html.includes(`llama serve -hf ${RUN2_REPO}:Q3_K_M`));
    });

    it("an Intel Mac: its memory first, then Ollama on the processor with 32 GB, and no guide with 16", () => {
      const files = run2Files({ needsTunedTemplate: false });
      const asks = page(start({ kind: "mac-intel" }), files);
      assert.match(asks, /Confirm your memory to see/);
      assert.match(asks, /<legend class="train-label vibe-legend-row">Memory/);
      assert.doesNotMatch(asks, /Get it running/);
      const big = page(start({ kind: "mac-intel", memoryGb: 32 }), files);
      assert.match(big, /<h2[^>]*>Runs slowly<\/h2>/);
      assert.ok(big.includes(`ollama create brief-writer`));
      assert.ok(big.includes(`FROM ./${Q4.name}`));
      const small = page(start({ kind: "mac-intel", memoryGb: 16 }), files);
      assert.match(small, /<h2[^>]*>Won&#x27;t run here<\/h2>/);
      assert.doesNotMatch(small, /Get it running|ollama create/, "no 17 GB download that can't load");
    });

    it("for a drive request: the picker and the verdict only, with no download, disk box or app guide", () => {
      const html = render(LocalGuide, { files: run2Files(), hello: null, live: LIVE_CLOSED, initial: start({ kind: "mac", chip: "M4 Max", memoryGb: 36 }), guide: false });
      clean(html);
      assert.match(html, /<h2[^>]*>Your computer<\/h2>/);
      assert.match(html, /<h2[^>]*>Runs well<\/h2>/);
      assert.doesNotMatch(html, /<dt>Download<\/dt>|I have at least|Get it running|Builds that run here/);
    });

    for (const [name, initial] of [
      ["a phone", { kind: "phone" }],
      ["a 16 GB Mac", { kind: "mac", chip: "M2", memoryGb: 16 }],
      ["a PC with 16 GB of RAM and no card", { kind: "windows", memoryGb: 16, gpuVendor: "none" }],
    ] as const) {
      it(`${name}: won't run here, Try it live, and no guide`, () => {
        const html = page(start(initial as Partial<PickerState>));
        clean(html);
        assert.match(html, /Won&#x27;t run here/);
        assert.match(html, /Try it live/);
        assert.doesNotMatch(html, /Get it running|lmstudio:|llama serve|ollama create/);
      });
    }

    it("before the memory is confirmed, no verdict and no guide", () => {
      const html = page(start({ kind: "mac", chip: "M4 Max" }));
      assert.match(html, /Confirm your memory to see/);
      assert.doesNotMatch(html, /Get it running/);
    });
  });

  describe("the link on the model's page", () => {
    it("says what it takes and opens the run-locally page", () => {
      const html = render(RunLocallyLink, { jobId: RUN2_JOB, files: run2Files() });
      clean(html);
      assert.match(html, new RegExp(`<a class="card vibe-run-link" href="/fine-tuning/${RUN2_JOB}/run">`));
      assert.match(html, /<strong>Run it on your computer<\/strong>/);
      assert.match(html, /Three builds from 13\.7 GB to 22\.9 GB, for a Mac with 24 GB or more or a PC with a 16 GB graphics card\. See which fits yours\./);
    });

    it("only for public files with a repo and at least one build", () => {
      assert.ok(linkable(run2Files()));
      assert.equal(linkable(run2Files({ public: false })), null);
      assert.equal(linkable(run2Files({ repo: null })), null);
      assert.equal(linkable(run2Files({ files: [] })), null);
      assert.equal(linkable(null), null);
    });
  });
});
