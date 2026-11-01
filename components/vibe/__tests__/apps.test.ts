import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ggufModelfile, hubSlug, studentSystem } from "@/lib/train/hub-cards";
import {
  INSTALL,
  checksumCommand,
  downloadCommand,
  folderCommand,
  hubFileUrl,
  hubResolveUrl,
  isGgufName,
  isRepoId,
  janLink,
  llamaAppLink,
  llamaServeCommands,
  lmStudioLink,
  lmsGetCommand,
  modelfile,
  ollamaCommands,
  writeModelfileCommand,
} from "@/components/vibe/apps";
import { RUN2_BUILDS, RUN2_COMMIT, RUN2_REPO, RUN2_SLUG, RUN2_SYSTEM, RUN2_TITLE, run2Files } from "./fixtures";

const Q3 = RUN2_BUILDS[0];
const Q4 = RUN2_BUILDS[1];

describe("run 2's local files, as the fixture fakes them", () => {
  it("name the repo and the system message the way the cards do", () => {
    assert.equal(hubSlug(RUN2_TITLE), RUN2_SLUG);
    assert.equal(RUN2_SYSTEM, `${studentSystem(RUN2_TITLE)}\n\nReasoning strength: low.`);
    assert.ok(isRepoId(RUN2_REPO));
    for (const f of RUN2_BUILDS) assert.ok(isGgufName(f.name) && f.name.endsWith(`-${f.level}.gguf`), f.name);
  });
});

describe("deep links, built from the repo and file names", () => {
  it("LM Studio opens the repo at the file", () => {
    assert.equal(
      lmStudioLink(RUN2_REPO, Q4.name),
      "lmstudio://open_from_hf?model=muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74&file=muse-glimmer-30b-brief-writer-Q4_K_M.gguf",
    );
  });

  it("the Llama app installs the repo at the quant level, and Jan opens the repo", () => {
    assert.equal(llamaAppLink(RUN2_REPO, "Q6_K"), "llama://install?repo=muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74&quant=Q6_K");
    assert.equal(janLink(RUN2_REPO), "jan://models/huggingface/muse-org/muse-glimmer-30b-brief-writer-gguf-83d71f74");
  });

  it("builds nothing from a repo or file name the Hub wouldn't allow", () => {
    for (const repo of ["muse-org/x&file=evil.gguf", "../etc/passwd", "a/b/c", "javascript:alert(1)", "muse-org/-x", "muse-org/x..y", "", "muse org/x"]) {
      assert.equal(isRepoId(repo), false, repo);
      assert.equal(lmStudioLink(repo, Q4.name), null, repo);
      assert.equal(llamaAppLink(repo, "Q4_K_M"), null, repo);
      assert.equal(janLink(repo), null, repo);
      assert.equal(llamaServeCommands("mac", { repo, commit: null, needsTunedTemplate: false }, "Q4_K_M"), null, repo);
    }
    for (const name of ["x.gguf?y=1", "../x.gguf", "x.bin", "x y.gguf", "$(rm -rf ~).gguf"]) {
      assert.equal(lmStudioLink(RUN2_REPO, name), null, name);
      assert.equal(downloadCommand("mac", run2Files(), name), null, name);
    }
  });
});

describe("commands", () => {
  it("llama serve from the Hub with no vision projector, 8K in one slot", () => {
    const files = run2Files({ needsTunedTemplate: false });
    assert.deepEqual(llamaServeCommands("mac", files, "Q4_K_M"), [`llama serve -hf ${RUN2_REPO}:Q4_K_M --no-mmproj -c 8192 -np 1`]);
  });

  it("an adapter trained before trainChannel gets tuned.jinja at the repo's commit, with Glimmer's parsing and reasoning off", () => {
    assert.deepEqual(llamaServeCommands("mac", run2Files(), "Q3_K_M"), [
      `curl -L -o tuned.jinja https://huggingface.co/${RUN2_REPO}/resolve/${RUN2_COMMIT}/tuned.jinja`,
      `llama serve -hf ${RUN2_REPO}:Q3_K_M --no-mmproj -c 8192 -np 1 --chat-template-file tuned.jinja --skip-chat-parsing --reasoning off`,
    ]);
    assert.match(llamaServeCommands("windows", run2Files(), "Q3_K_M")![0], /^curl\.exe -L -o tuned\.jinja /, "PowerShell's curl is another command");
  });

  it("downloads read the file at the commit, and the Hub page shows it; without a commit, main", () => {
    assert.equal(downloadCommand("linux", run2Files(), Q4.name), `curl -L -o ${Q4.name} https://huggingface.co/${RUN2_REPO}/resolve/${RUN2_COMMIT}/${Q4.name}`);
    assert.equal(hubFileUrl(RUN2_REPO, RUN2_COMMIT, "tuned.jinja"), `https://huggingface.co/${RUN2_REPO}/blob/${RUN2_COMMIT}/tuned.jinja`);
    assert.equal(hubResolveUrl(RUN2_REPO, null, Q4.name), `https://huggingface.co/${RUN2_REPO}/resolve/main/${Q4.name}`);
    assert.equal(hubResolveUrl(RUN2_REPO, "not-a-sha", Q4.name), `https://huggingface.co/${RUN2_REPO}/resolve/main/${Q4.name}`);
  });

  it("the sha256 check for each OS", () => {
    assert.equal(checksumCommand("mac", Q4.name), `shasum -a 256 ${Q4.name}`);
    assert.equal(checksumCommand("linux", Q4.name), `sha256sum ${Q4.name}`);
    assert.equal(checksumCommand("windows", Q4.name), `(Get-FileHash ${Q4.name} -Algorithm SHA256).Hash.ToLower()`, "lowercase, as the page shows it");
  });

  it("lms gets the repo's build from a terminal", () => {
    assert.equal(lmsGetCommand(RUN2_REPO, "Q4_K_M"), `lms get https://huggingface.co/${RUN2_REPO}@Q4_K_M`);
  });

  it("the Modelfile is the design's, with the system message exactly, and the GGUF card's own for every build", () => {
    assert.equal(
      modelfile(Q4, RUN2_SYSTEM, false),
      [
        "FROM ./muse-glimmer-30b-brief-writer-Q4_K_M.gguf",
        "RENDERER glimmer",
        "PARSER glimmer",
        'SYSTEM """You are the Muse Muse brief writer.',
        "",
        'Reasoning strength: low."""',
        "PARAMETER temperature 0",
        "PARAMETER num_ctx 8192",
      ].join("\n"),
    );
    const llama = modelfile({ ...Q4, name: "Llama-3.2-3B-made-up-Q4_K_M.gguf" }, "You are made up.", false)!;
    assert.doesNotMatch(llama, /glimmer/i, "a Llama file gets no Glimmer renderer");
    assert.match(llama, /^FROM \.\/Llama-3\.2-3B-made-up-Q4_K_M\.gguf\nSYSTEM """You are made up\."""\n/);
    assert.match(llama, /PARAMETER stop <\|eot_id\|>/);
    assert.equal(modelfile(Q4, 'You are """ a trap.', false), null, "a system message that would end the SYSTEM block early");
    // An adapter trained before trainChannel gets the TEMPLATE that opens the final channel, and its stops, for the
    // build being set up, not the card's Q4_K_M.
    const old = modelfile(Q3, RUN2_SYSTEM, true)!;
    assert.equal(old, ggufModelfile(Q3.name, RUN2_SYSTEM, 0));
    assert.ok(old.startsWith("FROM ./muse-glimmer-30b-brief-writer-Q3_K_M.gguf\nTEMPLATE \"\"\"") && !old.includes("RENDERER"));
    assert.deepEqual(old.split("\n").filter((l) => l.startsWith("PARAMETER stop ")), ["PARAMETER stop <|eot|>", "PARAMETER stop <|eom|>", "PARAMETER stop <|end_of_text|>", "PARAMETER stop <|start|>"]);
    assert.equal(folderCommand(RUN2_SLUG), "mkdir brief-writer; cd brief-writer", "one line for Terminal and PowerShell alike");
    assert.equal(writeModelfileCommand("FROM ./x.gguf"), "cat > Modelfile <<'EOF'\nFROM ./x.gguf\nEOF");
    assert.deepEqual(ollamaCommands(RUN2_SLUG), { create: "ollama create brief-writer -f Modelfile", run: "ollama run brief-writer" });
  });

  it("install links go to each app's own site over https", () => {
    const hosts = Object.values(INSTALL).map((a) => new URL(a.url).host);
    assert.deepEqual(hosts, ["lmstudio.ai", "github.com", "github.com", "ollama.com", "jan.ai"]);
    for (const a of Object.values(INSTALL)) assert.equal(new URL(a.url).protocol, "https:");
  });
});
