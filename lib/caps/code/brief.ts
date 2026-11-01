import { z } from "zod";
import { codePartsOn, type CodeParts } from "@/lib/caps/code/parts";

/**
 * The code cap's brief block (docs/CAPABILITIES.md, section 15): where a product runs code and whether it opens a page
 * the person typed. Muse Code sessions are not here: they are General's `muse_code` target (tg-musecode).
 *
 *   pyodide   Python in the visitor's browser (the standard library only)
 *   quickjs   JavaScript in the visitor's browser, in its own small engine, cut off after a few seconds
 *   exec      Python or Node on a platform sandbox with no network, 15 seconds at most ({GATEWAY_URL}/exec)
 *   browse    one page whose address the person typed, opened in a sandbox that reaches only that site
 *             ({GATEWAY_URL}/browse)
 */
export const CODE_RUNTIMES = ["pyodide", "quickjs", "exec"] as const;
export type CodeRuntime = (typeof CODE_RUNTIMES)[number];

const CodeBaseBlock = z.object({
  runtimes: z.array(z.enum(CODE_RUNTIMES)).max(CODE_RUNTIMES.length),
  browse: z.boolean(),
});

export const CodeBriefBlock = CodeBaseBlock.extend({ museCode: z.boolean().optional() });

export type CodeBrief = z.infer<typeof CodeBriefBlock>;

/** The runtimes the writer may pick while these parts are on: exec only with CODE_EXEC. */
export function codeRuntimesOn(parts: CodeParts = codePartsOn()): CodeRuntime[] {
  return CODE_RUNTIMES.filter((r) => r !== "exec" || parts.exec);
}

/**
 * The block the brief writer answers in: runtimes only from the parts that are on. browse stays a boolean (the rules
 * say to leave it false while it's off, and normalizeCodeBlock makes it false). The stored block is CodeBriefBlock.
 */
export function codeWriterBlock(parts: CodeParts = codePartsOn()): z.ZodTypeAny {
  const runtimes = codeRuntimesOn(parts) as [CodeRuntime, ...CodeRuntime[]];
  const base = parts.exec ? CodeBaseBlock : z.object({ runtimes: z.array(z.enum(runtimes)).max(runtimes.length), browse: z.boolean() });
  // Unit 9, 15b: required in the writer's answer while Muse Code is on, and absent while it's off.
  return parts.museCode ? base.extend({ museCode: z.boolean() }) : base;
}

/**
 * The brief's code block as this platform can serve it, or null. A part whose route is switched off (exec without
 * CODE_EXEC, browse without CODE_BROWSE or a builder snapshot) is left out, so the build prompt, the judge and the fixed
 * checks (codeProof's brief:<part>) never ask for a route that answers 404. A block left with nothing is null, and
 * capsForBuild drops the cap.
 */
export function codeBlock(brief: object | null | undefined, parts: CodeParts = codePartsOn()): CodeBrief | null {
  const block = (brief as { code?: unknown } | null | undefined)?.code;
  const parsed = CodeBriefBlock.safeParse(block);
  if (!parsed.success) return null;
  const runtimes = parsed.data.runtimes.filter((r) => r !== "exec" || parts.exec);
  const browse = parsed.data.browse && parts.browse;
  const museCode = parsed.data.museCode === true && parts.museCode === true;
  if (museCode) return { runtimes, browse, museCode };
  return runtimes.length || browse ? { runtimes, browse } : null;
}

/** The parts a stored block asks for that are switched off now, for the build log. */
export function codePartsOff(brief: object | null | undefined, parts: CodeParts = codePartsOn()): Array<"exec" | "browse" | "museCode"> {
  const parsed = CodeBriefBlock.safeParse((brief as { code?: unknown } | null | undefined)?.code);
  if (!parsed.success) return [];
  return [
    ...(parsed.data.runtimes.includes("exec") && !parts.exec ? (["exec"] as const) : []),
    ...(parsed.data.browse && !parts.browse ? (["browse"] as const) : []),
    ...(parsed.data.museCode === true && !parts.museCode ? (["museCode"] as const) : []),
  ];
}

/**
 * The writer's raw code block, cleaned before zod (normalizeRawBrief): runtimes it knows, each once, in a fixed order,
 * and browse as a boolean. A block that asks for nothing isn't a code product, so it becomes null. Anything else is
 * left for zod to report.
 */
export function normalizeCodeBlock(raw: unknown, parts: CodeParts = codePartsOn()): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(b.runtimes)) {
    const asked = new Set(b.runtimes.filter((r): r is string => typeof r === "string").map((r) => r.trim().toLowerCase()));
    // A runtime whose route is off isn't kept: the build couldn't use it.
    b.runtimes = codeRuntimesOn(parts).filter((r) => asked.has(r));
  }
  if (typeof b.browse === "string") b.browse = ["true", "yes", "1"].includes(b.browse.trim().toLowerCase());
  if (b.browse === true && !parts.browse) b.browse = false;
  // Unit 9, 15b: museCode as a boolean while Muse Code is on; left out entirely while it's off.
  if ("museCode" in b) {
    if (!parts.museCode) delete b.museCode;
    else if (typeof b.museCode === "string") b.museCode = ["true", "yes", "1"].includes(b.museCode.trim().toLowerCase());
  }
  if (Array.isArray(b.runtimes) && !(b.runtimes as unknown[]).length && b.browse === false && b.museCode !== true) return null;
  return b;
}

/**
 * The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES), naming only the parts that are on:
 * exec with CODE_EXEC, browse with CODE_BROWSE and a builder snapshot, and visitors on /exec with CODE_EXEC_VISITORS.
 */
export function codeWriterRules(parts: CodeParts = codePartsOn()): readonly string[] {
  const who = parts.visitors ? "for anyone using the product, within a small daily limit each" : "for the product's owner only";
  const browser = "pyodide runs Python in the visitor's browser, standard library only. quickjs runs JavaScript in the visitor's browser in its own small engine, a few seconds at most.";
  return [
    parts.browse
      ? "code: fill it only when running code a person writes or pastes is the product's main work (a snippet runner, a coding exercise checker, a data cleanup script) or the product opens a web page the person names. Otherwise null."
      : "code: fill it only when running code a person writes or pastes is the product's main work (a snippet runner, a coding exercise checker, a data cleanup script). Otherwise null.",
    parts.exec
      ? `code.runtimes: ${browser} exec runs Python or Node on a platform sandbox with no network for at most 15 seconds, ${who}. Prefer pyodide and quickjs: they work for every visitor and cost nothing. Pick exec only when the code needs a real Python or Node with files${parts.visitors ? ", and say in limits how many runs a day each person gets" : ", and say in limits that only the owner can run it"}.`
      : `code.runtimes: ${browser} Those are the only two.`,
    parts.browse
      ? "code.browse: true only when the product opens a page whose address the person types (a page summarizer, a link checker). It opens that one site, never logs in, and only for the product's owner. Say both in limits."
      : "code.browse: always false. Opening web pages isn't available.",
    "Code never calls a model or an outside service. Model calls stay in the product's own server code, which passes results in.",
    // ---------- Wave 3, unit 9: Muse Code sessions (15b), only while MUSE_CODE_ENABLED is on ----------
    ...(parts.museCode
      ? [
          `code.museCode: true only when the product's main work is a coding agent doing a task in a workspace and handing back files (a tool that takes a CSV and writes a cleanup script, a small site or script maker). Muse Code runs each task in a private temporary workspace, at most 15 minutes and $1 a task, ${parts.museCodeVisitors ? "for anyone using the product, 3 tasks a day each" : "for the product's owner only"}. The task is sent to Meta. Say both in limits. Otherwise false. A product that only runs code a person wrote uses runtimes instead.`,
        ]
      : []),
  ];
}
