import { z } from "zod";

/**
 * The runtime cap's brief block (docs/CAPABILITIES.md, section 16): small Python functions a product's actions call, for
 * work Python's libraries do best. Only Python is in the brief: the VS Code extension, the GitHub Action and the
 * self-host kit are made by the platform from a live product, so the writer never picks them (RUNTIME_OUTPUTS).
 */

/** A function's name: its file is api/py/<name>.py and it answers at /api/py/<name>. */
export const PY_FUNCTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** A PyPI project name as PEP 508 writes it, without a version. Muse Code pins the version in requirements.txt. */
export const PYPI_NAME = /^[a-z0-9]([a-z0-9._-]{0,58}[a-z0-9])?$/;
export const MAX_PY_FUNCTIONS = 4;
export const MAX_PY_PACKAGES = 8;

/**
 * Web frameworks never go in a product's requirements.txt: with one listed, Vercel runs the whole project as that
 * framework's app instead of next to the Next.js app (its Python framework preset). Lowercase, PEP 503 normalized.
 */
export const PY_WEB_FRAMEWORKS = ["flask", "fastapi", "django", "starlette", "quart", "sanic", "litestar", "bottle", "falcon", "tornado", "aiohttp", "uvicorn", "gunicorn"] as const;

export const RuntimeBriefBlock = z.object({
  /** Why this product needs Python rather than TypeScript, in one plain sentence. */
  why: z.string().min(1).max(200),
  functions: z
    .array(z.object({ name: z.string().min(1).max(40), does: z.string().min(1).max(200) }))
    .min(1)
    .max(MAX_PY_FUNCTIONS),
  /** PyPI names only. Empty for the standard library. */
  packages: z.array(z.string().min(1).max(60)).max(MAX_PY_PACKAGES),
});

export type RuntimeBrief = z.infer<typeof RuntimeBriefBlock>;

/** PEP 503's normalized name, which pip and PyPI compare by. */
export function normalizePackage(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function snakeName(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
  return /^[a-z]/.test(out) ? out : `py_${out || "function"}`.slice(0, 40);
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

/**
 * The writer's raw runtime block, cleaned before zod (normalizeRawBrief): names in snake case and each once, at most 4
 * functions and 8 packages, versions and web frameworks dropped from packages, text clipped to the schema's limits. A
 * block with no usable function isn't a Python product, so it becomes null. Anything else is left for zod to report.
 */
export function normalizeRuntimeBlock(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (typeof b.why === "string") b.why = clip(b.why.trim(), 200);
  if (Array.isArray(b.functions)) {
    const seen = new Set<string>();
    b.functions = b.functions
      .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object" && typeof (f as { name?: unknown }).name === "string")
      .map((f) => ({ ...f, name: snakeName(f.name as string), ...(typeof f.does === "string" ? { does: clip(f.does.trim(), 200) } : {}) }))
      .filter((f) => !seen.has(f.name) && Boolean(seen.add(f.name)) && f.name !== "musemuse_health")
      .slice(0, MAX_PY_FUNCTIONS);
    if (!(b.functions as unknown[]).length) return null;
  }
  if (Array.isArray(b.packages)) {
    const seen = new Set<string>();
    b.packages = b.packages
      .filter((p): p is string => typeof p === "string")
      .map((p) => {
        // A requirement as people write one: a name, maybe extras and a version, maybe a marker after ";". Only the name stays.
        const spec = p.split(";")[0]!.trim();
        const m = spec.match(/^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*([=<>!~].*)?$/);
        return m ? normalizePackage(m[1]!) : "";
      })
      .filter((p) => PYPI_NAME.test(p) && !(PY_WEB_FRAMEWORKS as readonly string[]).includes(p) && !seen.has(p) && Boolean(seen.add(p)))
      .slice(0, MAX_PY_PACKAGES);
  }
  return b;
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES). */
export const RUNTIME_WRITER_RULES: readonly string[] = [
  "runtime: fill it only when the product's main work needs Python's own libraries, such as numbers and tables (numpy, pandas), statistics and curve fitting (scipy), symbolic math (sympy) or image processing (pillow), that TypeScript can't do as well. Otherwise null.",
  "runtime.functions: one entry per Python function, at most 4. Each takes JSON from one of the product's actions and returns JSON, in under 10 seconds. Name each in snake_case for what it computes, and say in does what goes in and what comes out.",
  "runtime.packages: PyPI names only, no versions, at most 8, and an empty list when the standard library is enough. Never a web framework (Flask, FastAPI, Django or the like). As few as the work needs: every function deploys with all of them inside Vercel's 500 MB for one Python function, so numpy with one or two more, never torch or tensorflow.",
  "Python never calls a model or an outside service. Model calls stay in the product's TypeScript, so an action that needs both calls the model in TypeScript and the Python function for the computing.",
  "Python never reads a person's text as code. For a formula a person types, say in does that it takes the formula as a parsed tree of numbers, names and operators, not as text.",
];
