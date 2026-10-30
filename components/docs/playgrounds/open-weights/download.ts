import { GGUF_FILES, GLIMMER, GLIMMER_REPOS, PTE_REPO_GB, SPARK, SPARK_CHECKPOINTS, gb, inSentence, pteExport, type GgufFileId, type PteBackend, type PteDecoding, type PteModality, type PteQuant, type SparkCheckpoint } from "@/components/docs/playgrounds/open-weights/facts";
import type { CodeStep } from "@/components/docs/playgrounds/open-weights/deploy";
import { shq } from "@/components/docs/playgrounds/open-weights/shell";

/**
 * The "Get the model" pages as command builders (muse-spark-open/get-the-model, muse-glimmer/get-the-model): every
 * checkpoint and build the pages list, from Meta or Hugging Face, with the download commands, a disk check, two ways
 * to verify what landed (a quick count against the page's shard numbers, or SHA-256 against the hashes the Hub
 * publishes for each file), and the page's tokenizer check.
 */

export type VerifyMode = "count" | "sha256";

/**
 * Checks every downloaded file against the SHA-256 the Hub lists for it (large files carry one in their LFS
 * metadata). Meta's download page serves the same files, so this verifies a browser download too.
 */
export function sha256Script(repo: string, folder: string, patterns: string[] = []): string {
  return [
    "import fnmatch",
    "import hashlib",
    "import pathlib",
    "",
    "from huggingface_hub import HfApi",
    "",
    `repo = ${JSON.stringify(repo)}`,
    `folder = pathlib.Path(${JSON.stringify(folder)})`,
    ...(patterns.length ? [`patterns = ${JSON.stringify(patterns)}`] : []),
    "",
    "info = HfApi().model_info(repo, files_metadata=True)",
    ...(patterns.length
      ? ["files = [f for f in info.siblings if any(fnmatch.fnmatch(f.rfilename, p) for p in patterns)]"]
      : ["files = info.siblings"]),
    "problems = []",
    "for f in files:",
    "    path = folder / f.rfilename",
    "    if not path.exists():",
    '        problems.append(f"missing: {f.rfilename}")',
    "        continue",
    "    if f.lfs is None:  # small text files carry no hash on the Hub",
    "        continue",
    "    digest = hashlib.sha256()",
    '    with path.open("rb") as fh:',
    '        for chunk in iter(lambda: fh.read(1 << 24), b""):',
    "            digest.update(chunk)",
    "    if digest.hexdigest() != f.lfs.sha256:",
    '        problems.append(f"checksum mismatch: {f.rfilename}")',
    "",
    'print("\\n".join(problems) if problems else f"all {len(files)} files present, every hash matches")',
  ].join("\n");
}

/** A quick look: the shard count the page gives, the index's shards all present, and the named files. */
export function countScript(folder: string, shards: number): string {
  return [
    "import json",
    "import pathlib",
    "",
    `folder = pathlib.Path(${JSON.stringify(folder)})`,
    'shards = sorted(p.name for p in folder.glob("*.safetensors"))',
    `print(f"{len(shards)} weight shards (the page lists ${shards})")`,
    "",
    'index = folder / "model.safetensors.index.json"',
    "if index.exists():",
    '    wanted = set(json.loads(index.read_text())["weight_map"].values())',
    "    missing = sorted(wanted - set(shards))",
    '    print("missing shards:", ", ".join(missing) if missing else "none")',
    "",
    'for name in ["config.json", "LICENSE.md"]:',
    '    print(name, "ok" if (folder / name).exists() else "MISSING")',
  ].join("\n");
}

/**
 * The files Meta's download page has you fetch (get-the-model, "Download from Meta", step 4): the weight shards,
 * LICENSE.md, and the config, tokenizer and chat template files. The Hub repository also holds files Meta's list
 * leaves out (README.md, .gitattributes), so a check of a Meta download covers these and nothing else.
 */
export const META_DOWNLOAD_FILES = ["*.safetensors", "*.json", "*.jinja", "LICENSE.md"];

export interface SparkDownloadOptions {
  checkpoint: SparkCheckpoint;
  source: "hf" | "meta";
  folder: string;
  verify: VerifyMode;
}

export interface DownloadPlan {
  steps: CodeStep[];
  notes: string[];
  warnings: string[];
  totalGb: number | null;
  summary: string;
}

export function sparkDownload(o: SparkDownloadOptions): DownloadPlan {
  const c = SPARK_CHECKPOINTS[o.checkpoint];
  const folder = o.folder.trim() || c.localDir;
  const steps: CodeStep[] = [];
  const notes: string[] = [];
  steps.push({ title: "Check the free space first", lang: "bash", code: `df -h ${shq(folder.includes("/") ? folder.replace(/\/[^/]*\/?$/, "") || "." : ".")}`, note: `${c.label} needs ${inSentence(c.footprint)} on disk.` });
  if (o.source === "hf") {
    steps.push({ title: "Install the Hugging Face CLI", lang: "bash", code: "pip install -U huggingface_hub" });
    steps.push({ title: `Download the ${c.label} checkpoint`, lang: "bash", code: `hf download ${c.repo} --local-dir ${shq(folder)}`, note: "Run it again to resume an interrupted download." });
  } else {
    steps.push({
      title: "Download from Meta in your browser",
      lang: "text",
      code: [
        "1. Sign in and open https://dev.meta.ai/platform/models/download/muse-spark-open",
        `2. Under Choose a checkpoint, select ${c.label} checkpoint.`,
        "3. Under Licensing Terms, open License and Terms and scroll to the end to accept it.",
        "4. In the Files list, download every file: the weight shards, LICENSE.md, and the config,",
        "   tokenizer and chat template files.",
        `5. Save them all, with their original names, in one folder: ${folder}`,
      ].join("\n"),
      note: `Your browser downloads each file separately: ${c.label} has ${c.shards} weight shards. Pass this folder wherever a command uses the Hugging Face repository ID.`,
    });
  }
  steps.push(
    o.verify === "count"
      ? { title: "Check that every file landed", lang: "python", code: countScript(folder, c.shards) }
      : {
          title: "Verify every file against the Hub's SHA-256",
          lang: "python",
          code: sha256Script(c.repo, folder, o.source === "meta" ? META_DOWNLOAD_FILES : []),
          note: `This reads every byte (${inSentence(c.footprint)}), so it takes a while; it needs network access for the hashes only.${
            o.source === "meta" ? " It checks the files Meta's list has (the shards, LICENSE.md, the JSON and template files), so the Hub's README.md and .gitattributes don't count as missing." : ""
          }`,
        },
  );
  steps.push({
    title: "Check the tokenizer renders a prompt",
    lang: "python",
    code: [
      "from transformers import AutoTokenizer",
      "",
      `tok = AutoTokenizer.from_pretrained(${JSON.stringify(folder)})`,
      "",
      'messages = [{"role": "user", "content": "In one sentence, what is Muse Spark good at?"}]',
      "print(tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False))",
    ].join("\n"),
    note: `Needs transformers ${SPARK.transformers} or later: pip install -U "transformers>=${SPARK.transformers}". Each message should start with <|start|> and its role, with content after <|message|> and <|eot|> at the end.`,
  });
  notes.push(`${c.label}: ${c.what} Serving recipe: ${c.recipe}. The footprint leaves out the KV cache, activations and runtime overhead.`);
  return { steps, notes, warnings: [], totalGb: c.footprintGb, summary: `${c.label}: ${inSentence(c.footprint)} in ${c.shards} weight shards, from ${o.source === "hf" ? "Hugging Face" : "Meta"}.` };
}

export type GlimmerItem = "bf16" | GgufFileId | "assistant" | "pte";

export interface GlimmerDownloadOptions {
  items: GlimmerItem[];
  pte: { quant: PteQuant; modality: PteModality; decoding: PteDecoding; backend: PteBackend };
  verify: boolean;
}

export const GLIMMER_ITEMS: { id: GlimmerItem; label: string; detail: string; sizeGb: number | null }[] = [
  { id: "bf16", label: "bf16 safetensors", detail: "For vLLM and SGLang, with the tokenizer, chat template and processor config", sizeGb: GLIMMER.bf16WeightsGb },
  { id: "kquant17", label: "GGUF text model, K-Quant-17GB", detail: "Smaller footprint: fits under 24 GB of VRAM", sizeGb: GGUF_FILES.kquant17.downloadGb },
  { id: "dynamic", label: "GGUF text model, Dynamic Q4_K_XL", detail: "Higher quality: for 32 GB of VRAM", sizeGb: GGUF_FILES.dynamic.downloadGb },
  { id: "mmproj", label: "GGUF vision projector", detail: "Needed for image input", sizeGb: GGUF_FILES.mmproj.downloadGb },
  { id: "dflash", label: "GGUF DFlash draft", detail: "Speculative decoding for llama.cpp and ExecuTorch, optional", sizeGb: GGUF_FILES.dflash.downloadGb },
  { id: "assistant", label: "DFlash draft checkpoint (assistant)", detail: "For SGLang's speculative decoding; serves as published", sizeGb: null },
  { id: "pte", label: "Prebuilt ExecuTorch export", detail: "One .pte program, so you skip exporting a 30B model", sizeGb: null },
];

export function glimmerDownload(o: GlimmerDownloadOptions): DownloadPlan {
  const steps: CodeStep[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const has = (i: GlimmerItem) => o.items.includes(i);
  const gguf = (["kquant17", "dynamic", "mmproj", "dflash"] as const).filter((f) => has(f));
  let total = 0;
  let unknown = false;
  if (!o.items.length) return { steps, notes, warnings: ["Pick at least one artifact."], totalGb: 0, summary: "Nothing picked yet." };

  steps.push({ title: "Install the Hugging Face CLI", lang: "bash", code: "pip install -U huggingface_hub" });
  if (has("bf16")) {
    total += GLIMMER.bf16WeightsGb;
    steps.push({ title: "The bf16 checkpoint, for vLLM and SGLang (about 60 GB)", lang: "bash", code: `hf download ${GLIMMER_REPOS.bf16} --local-dir ./muse-glimmer-30b` });
  }
  if (gguf.length) {
    total += gguf.reduce((s, f) => s + GGUF_FILES[f].downloadGb, 0);
    steps.push({
      title: "The GGUF files you need, and nothing else",
      lang: "bash",
      code: [`hf download ${GLIMMER_REPOS.gguf} --local-dir ./muse-glimmer \\`, ...gguf.map((f, i) => `  --include "${GGUF_FILES[f].file}"${i < gguf.length - 1 ? " \\" : ""}`)].join("\n"),
    });
  }
  if (has("assistant")) {
    unknown = true;
    steps.push({ title: "The DFlash draft checkpoint", lang: "bash", code: `hf download ${GLIMMER_REPOS.assistant} --local-dir ./muse-glimmer-assistant` });
  }
  if (has("pte")) {
    const e = pteExport(o.pte.quant, o.pte.modality, o.pte.decoding, o.pte.backend);
    total += e.sizeGb;
    steps.push({
      title: `One prebuilt ExecuTorch export (${e.sizeGb} GB)`,
      lang: "bash",
      code: [
        `EXPORT_DIR=${e.dir}`,
        "",
        `hf download ${GLIMMER_REPOS.pte} \\`,
        '  --include "$EXPORT_DIR/*" \\',
        "  --include tokenizer.json --include tokenizer_config.json --include chat_template.jinja \\",
        "  --local-dir exports",
      ].join("\n"),
    });
    warnings.push(`Download one export, not the whole repository: it publishes 16 exports and is ${PTE_REPO_GB} GB.`);
    if (o.pte.backend === "sm80+ptx") notes.push("The sm80+ptx export adds a .ptd beside the .pte: on CUDA the weights live in the .ptd, so both are needed.");
    if (o.pte.modality === "text-image") notes.push("A text-image export adds pos_embed.bin.");
  }
  if ((has("kquant17") || has("dynamic")) && !has("mmproj")) notes.push("Image input needs the vision projector beside the text model.");
  if (has("mmproj") && !has("kquant17") && !has("dynamic")) warnings.push("The projector and drafter work with a GGUF text model; pick one too.");
  if (has("dflash") && !has("kquant17") && !has("dynamic")) notes.push("The GGUF draft speculates for a GGUF target (llama.cpp, ExecuTorch, or SGLang's GGUF-draft path).");
  if (has("kquant17") && has("dynamic")) notes.push("You rarely need both text models: K-Quant-17GB fits under 24 GB of VRAM, the dynamic quant wants 32 GB.");

  if (o.verify) {
    if (has("bf16")) steps.push({ title: "Verify the bf16 download against the Hub's SHA-256", lang: "python", code: sha256Script(GLIMMER_REPOS.bf16, "./muse-glimmer-30b") });
    if (gguf.length) steps.push({ title: "Verify the GGUF files", lang: "python", code: sha256Script(GLIMMER_REPOS.gguf, "./muse-glimmer", gguf.map((f) => GGUF_FILES[f].file)) });
    if (has("assistant")) steps.push({ title: "Verify the draft checkpoint", lang: "python", code: sha256Script(GLIMMER_REPOS.assistant, "./muse-glimmer-assistant") });
    if (has("pte")) {
      const e = pteExport(o.pte.quant, o.pte.modality, o.pte.decoding, o.pte.backend);
      steps.push({ title: "Verify the export", lang: "python", code: sha256Script(GLIMMER_REPOS.pte, "./exports", [`${e.dir}/*`, "tokenizer.json", "tokenizer_config.json", "chat_template.jinja"]) });
    }
  }
  steps.push({
    title: "Check the tokenizer",
    lang: "python",
    code: [
      "from transformers import AutoTokenizer",
      "",
      `tok = AutoTokenizer.from_pretrained(${JSON.stringify(has("bf16") ? "./muse-glimmer-30b" : GLIMMER_REPOS.bf16)})`,
      "",
      'messages = [{"role": "user", "content": "In one sentence, what is Muse Glimmer good at?"}]',
      "print(tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False))",
    ].join("\n"),
    note: `Use transformers ${GLIMMER.transformers} or later: earlier versions lack the native Muse Glimmer path and ask for trust_remote_code. The prompt uses <|start|>, <|message|> and <|eot|>.`,
  });
  const summary = `${o.items.length} artifact${o.items.length === 1 ? "" : "s"}: about ${gb(total)} GB${unknown ? " plus the draft checkpoint (its size isn't listed)" : ""}.`;
  return { steps, notes, warnings, totalGb: total, summary };
}
