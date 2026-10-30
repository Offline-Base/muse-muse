import { GGUF_FILES, GLIMMER_MEASURED, GLIMMER_REPOS, gb, n, type GgufFileId } from "@/components/docs/playgrounds/open-weights/facts";
import { gbToGib } from "@/components/docs/playgrounds/open-weights/hardware";
import { command } from "@/components/docs/playgrounds/open-weights/shell";

/**
 * Muse Glimmer's quantization page as a planner: pick a GGUF for your memory, see the memory budget the page
 * measured (K-Quant-17GB with the projector at 131,072 tokens: 15.6 + 1.3 + 2.1 = 19.0 GiB, plus about 1.5 GiB for
 * the DFlash drafter), and get the llama serve command with --hf-file, -c and -np, or the convert, quantize and
 * perplexity commands when neither shipped file fits.
 */

export interface BudgetRow {
  label: string;
  gib: number;
  /** "measured" on the page, or "estimate" (scaled or read from a file size). */
  basis: "measured" | "estimate";
  note?: string;
}

export interface GgufBudget {
  rows: BudgetRow[];
  totalGib: number;
}

export interface GgufNeeds {
  file: "kquant17" | "dynamic";
  vision: boolean;
  dflash: boolean;
  /** Total context, -c. */
  ctx: number;
}

/** The text model's loaded size: measured for K-Quant-17GB, read from the file size for the dynamic quant. */
export function textGib(file: "kquant17" | "dynamic"): { gib: number; basis: "measured" | "estimate" } {
  return file === "kquant17" ? { gib: GLIMMER_MEASURED.textGib, basis: "measured" } : { gib: gbToGib(GGUF_FILES.dynamic.downloadGb), basis: "estimate" };
}

/**
 * The memory budget. The KV cache and compute buffers measure 2.1 GiB at 131,072 tokens; for other sizes this scales
 * that figure with the context, a rough guide (the buffers don't shrink with it, and only a quarter of the layers keep
 * a full-length cache).
 */
export function ggufBudget(needs: GgufNeeds): GgufBudget {
  const text = textGib(needs.file);
  const rows: BudgetRow[] = [{ label: needs.file === "kquant17" ? "Text model (K-Quant-17GB)" : "Text model (Dynamic Q4_K_XL)", gib: text.gib, basis: text.basis, note: text.basis === "estimate" ? "its 19.7 GB file in GiB" : undefined }];
  if (needs.vision) rows.push({ label: "Vision projector", gib: GLIMMER_MEASURED.mmprojGib, basis: "measured" });
  const atPage = needs.ctx === GLIMMER_MEASURED.contextTokens;
  rows.push({
    label: `KV cache and compute buffers (${n(needs.ctx)} tokens)`,
    gib: GLIMMER_MEASURED.kvAndBuffersGib * (needs.ctx / GLIMMER_MEASURED.contextTokens),
    basis: atPage ? "measured" : "estimate",
    note: atPage ? undefined : "scaled from 2.1 GiB at 131,072",
  });
  if (needs.dflash) rows.push({ label: "DFlash drafter", gib: GLIMMER_MEASURED.dflashGib, basis: "measured", note: "the page's roughly 1.5 GiB" });
  return { rows, totalGib: rows.reduce((s, r) => s + r.gib, 0) };
}

export interface GgufPick {
  file: "kquant17" | "dynamic" | null;
  budget: GgufBudget;
  headroomGib: number;
  verdict: "fits" | "tight" | "no";
  summary: string;
  /** The largest context that fits with this file, when the asked one doesn't. */
  maxCtx: number | null;
}

/** Headroom the picker keeps free for the OS, the display and fragmentation. */
export const HEADROOM_GIB = 1;

/** The largest -c (a multiple of 4,096) whose scaled KV budget still fits. */
export function maxContextFor(memGib: number, needs: Omit<GgufNeeds, "ctx">): number {
  const fixed = ggufBudget({ ...needs, ctx: 0 }).totalGib;
  const room = memGib - HEADROOM_GIB - fixed;
  if (room <= 0) return 0;
  const tokens = (room / GLIMMER_MEASURED.kvAndBuffersGib) * GLIMMER_MEASURED.contextTokens;
  return Math.max(0, Math.floor(tokens / 4096) * 4096);
}

/** The page pitches the dynamic quant at 32 GB cards and K-Quant-17GB at cards under 24 GB. */
export const DYNAMIC_FROM_GIB = 32;

/**
 * The file to use: in auto, the dynamic quant on 32 GB or more (the page's pitch for it) when it fits, else
 * K-Quant-17GB, else neither. A forced file is checked as it is.
 */
export function pickGguf(memGib: number, needs: Omit<GgufNeeds, "file">, prefer: "auto" | "kquant17" | "dynamic" = "auto"): GgufPick {
  const order: Array<"kquant17" | "dynamic"> =
    prefer === "kquant17" ? ["kquant17"] : prefer === "dynamic" ? ["dynamic"] : memGib >= DYNAMIC_FROM_GIB ? ["dynamic", "kquant17"] : ["kquant17"];
  for (const file of order) {
    const budget = ggufBudget({ ...needs, file });
    const headroomGib = memGib - budget.totalGib;
    if (headroomGib >= HEADROOM_GIB) {
      return {
        file,
        budget,
        headroomGib,
        verdict: headroomGib >= 3 ? "fits" : "tight",
        summary: `${file === "dynamic" ? "Dynamic Q4_K_XL" : "K-Quant-17GB"} fits: about ${gb(budget.totalGib)} GiB of ${gb(memGib)} GiB, ${gb(headroomGib)} GiB to spare.`,
        maxCtx: null,
      };
    }
  }
  const file = order[order.length - 1];
  const budget = ggufBudget({ ...needs, file });
  const maxCtx = maxContextFor(memGib, { file, vision: needs.vision, dflash: needs.dflash });
  return {
    file: null,
    budget,
    headroomGib: memGib - budget.totalGib,
    verdict: "no",
    summary:
      maxCtx >= 8192
        ? `Neither fits at ${n(needs.ctx)} tokens: about ${gb(budget.totalGib)} GiB needed. ${file === "kquant17" ? "K-Quant-17GB" : "This file"} fits with -c ${n(maxCtx)} or less.`
        : `Neither shipped file fits in ${gb(memGib)} GiB. Quantize the bf16 weights yourself to a smaller type, or use a machine with more memory.`,
    maxCtx: maxCtx >= 8192 ? maxCtx : null,
  };
}

export interface ServeOptions {
  file: "kquant17" | "dynamic";
  vision: boolean;
  dflash: boolean;
  ctx: number;
  np: number;
  port: number;
}

/** The quantization page's llama serve command, with the budget's choices applied. */
export function ggufServe(o: ServeOptions): string {
  return command(`llama serve -hf ${GLIMMER_REPOS.gguf}`, [
    `--hf-file ${GGUF_FILES[o.file].file}`,
    o.ctx !== GLIMMER_MEASURED.contextTokens && `-c ${o.ctx}`,
    o.np > 1 && `-np ${o.np}`,
    !o.vision && "--no-mmproj",
    o.dflash && `-md ${GGUF_FILES.dflash.file} --spec-type draft-dflash`,
    o.dflash && "-ngld 99 --spec-draft-n-max 4",
    `--port ${o.port}`,
  ]);
}

/**
 * The DFlash draft, which a serve command with -md needs on disk: llama serve -hf fetches the text model and the
 * vision projector, but the draft is downloaded by hand ("download dflash-Muse-Glimmer-30B-Q4_K_M.gguf from the same
 * repository and add -md ...", muse-glimmer/deploy). Into the working directory, so -md's bare file name resolves.
 */
export function ggufDraftDownload(dir = "."): string {
  return `hf download ${GLIMMER_REPOS.gguf} --local-dir ${dir} \\\n  --include "${GGUF_FILES.dflash.file}"`;
}

/** hf download for the files a plan uses (optional: llama serve fetches them itself). */
export function ggufDownload(files: GgufFileId[], dir = "./muse-glimmer"): string {
  return [`hf download ${GLIMMER_REPOS.gguf} --local-dir ${dir} \\`, ...files.map((f, i) => `  --include "${GGUF_FILES[f].file}"${i < files.length - 1 ? " \\" : ""}`)].join("\n");
}

/** Convert the bf16 safetensors to GGUF, quantize, and compare perplexity (the page's "Quantize it yourself"). */
export function quantizeYourself(type: string): string {
  const t = /^[A-Za-z0-9_]+$/.test(type) ? type : "Q4_K_M";
  const out = `muse-glimmer-30b-${t.toLowerCase()}.gguf`;
  return [
    "# Convert to GGUF format",
    "python3 llama.cpp/convert_hf_to_gguf.py \\",
    "  ./muse-glimmer-30b \\",
    "  --outtype bf16 \\",
    "  --outfile muse-glimmer-30b-bf16.gguf",
    "",
    `# Quantize to ${t}`,
    "llama.cpp/build/bin/llama-quantize \\",
    "  muse-glimmer-30b-bf16.gguf \\",
    `  ${out} \\`,
    `  ${t}`,
    "",
    "# Evaluate perplexity with llama.cpp",
    "llama.cpp/build/bin/llama-perplexity \\",
    `  -m ${out} \\`,
    "  -f wikitext-2-raw/wiki.test.raw",
  ].join("\n");
}

/** The two text checkpoints' recipes (quantization, "Choose a checkpoint"). */
export const RECIPES = {
  kquant17: "A fixed scheme: a Q4_K body at group size 32, Q6_K at group size 128 on the attn_v and ffn_down projections, and Q5_K at group size 128 on the output head.",
  dynamic: "Searches per-unit precision across Q4_K, Q5_K and Q6_K, all at group size 32.",
} as const;
