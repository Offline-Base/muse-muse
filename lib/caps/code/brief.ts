import { z } from "zod";

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

export const CodeBriefBlock = z.object({
  runtimes: z.array(z.enum(CODE_RUNTIMES)).max(CODE_RUNTIMES.length),
  browse: z.boolean(),
});

export type CodeBrief = z.infer<typeof CodeBriefBlock>;

/** The brief's code block, or null. */
export function codeBlock(brief: object | null | undefined): CodeBrief | null {
  const block = (brief as { code?: unknown } | null | undefined)?.code;
  const parsed = CodeBriefBlock.safeParse(block);
  return parsed.success && (parsed.data.runtimes.length || parsed.data.browse) ? parsed.data : null;
}

/**
 * The writer's raw code block, cleaned before zod (normalizeRawBrief): runtimes it knows, each once, in a fixed order,
 * and browse as a boolean. A block that asks for nothing isn't a code product, so it becomes null. Anything else is
 * left for zod to report.
 */
export function normalizeCodeBlock(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(b.runtimes)) {
    const asked = new Set(b.runtimes.filter((r): r is string => typeof r === "string").map((r) => r.trim().toLowerCase()));
    b.runtimes = CODE_RUNTIMES.filter((r) => asked.has(r));
  }
  if (typeof b.browse === "string") b.browse = ["true", "yes", "1"].includes(b.browse.trim().toLowerCase());
  if (Array.isArray(b.runtimes) && !(b.runtimes as unknown[]).length && b.browse === false) return null;
  return b;
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES). */
export const CODE_WRITER_RULES: readonly string[] = [
  "code: fill it only when running code a person writes or pastes is the product's main work (a snippet runner, a coding exercise checker, a data cleanup script) or the product opens a web page the person names. Otherwise null.",
  "code.runtimes: pyodide runs Python in the visitor's browser, standard library only. quickjs runs JavaScript in the visitor's browser in its own small engine, a few seconds at most. exec runs Python or Node on a platform sandbox with no network for at most 15 seconds, for the product's owner only. Prefer pyodide and quickjs: they work for every visitor and cost nothing. Pick exec only when the code needs a real Python or Node with files, and say in limits that only the owner can run it.",
  "code.browse: true only when the product opens a page whose address the person types (a page summarizer, a link checker). It opens that one site, never logs in, and only for the product's owner. Say both in limits.",
  "Code never calls a model or an outside service. Model calls stay in the product's own server code, which passes results in.",
];
