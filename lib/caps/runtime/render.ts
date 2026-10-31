import type { Brief } from "@/lib/brief/schema";
import type { CapRenderEntry } from "@/lib/caps/render";
import { PY_FUNCTION_NAME, PYPI_NAME, type RuntimeBrief } from "@/lib/caps/runtime/brief";

/**
 * The runtime cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 16). Its text names the platform files
 * in template/caps/runtime: lib/platform/python.ts, scripts/py-local.mjs, tests/caps/runtime.ts and the muse-python skill.
 */

/** A function or package name as the brief stored it. Names that aren't plain are left out rather than quoted. */
const plainName = (name: string) => PY_FUNCTION_NAME.test(name);

function block(brief: Brief): RuntimeBrief | null {
  return ((brief as { runtime?: RuntimeBrief | null }).runtime ?? null) as RuntimeBrief | null;
}

function functionLines(runtime: RuntimeBrief): string[] {
  return runtime.functions.filter((f) => plainName(f.name)).map((f) => `- \`api/py/${f.name}.py\`: ${f.does}`);
}

const packages = (runtime: RuntimeBrief) => runtime.packages.filter((p) => PYPI_NAME.test(p));

function packagesLine(runtime: RuntimeBrief): string {
  return packages(runtime).length
    ? `Packages, from PyPI: ${packages(runtime).map((p) => `\`${p}\``).join(", ")}. Pin each in \`requirements.txt\` as \`name==version\` with a version that has wheels for Python 3.14, which both the build machine and Vercel run (\`.python-version\`).`
    : "No packages: the standard library is enough. Keep `requirements.txt` without any.";
}

export const RUNTIME_RENDER: CapRenderEntry = {
  title: "Python functions",
  build(brief) {
    const runtime = block(brief);
    if (!runtime) return [];
    return [
      `The brief asks for Python: ${runtime.why}`,
      "",
      ...functionLines(runtime),
      "",
      packagesLine(runtime),
      "",
      "- Read `.agents/skills/muse-python/SKILL.md` first. It has the file shape, the local runner and the test helper.",
      "- Each function is one file, `api/py/<name>.py`, that defines `class handler(BaseHTTPRequestHandler)` with a `do_POST` reading a JSON body and writing a JSON reply. Vercel serves it at `/api/py/<name>`, next to the Next.js app.",
      "- Actions stay in TypeScript: `app/api/actions/<name>/route.ts` validates the input and calls `callPython(request, \"<name>\", input)` from `lib/platform/python.ts`, then answers. The UI calls the action route, never `/api/py/` itself.",
      "- After changing `requirements.txt`, run `node scripts/py-local.mjs install`. `node scripts/py-local.mjs call <name>` runs one function with JSON on stdin, which is the quickest way to try it.",
      "- Python gets only the JSON its action sends. It holds no key or token, calls no model and reaches no other service. Model calls stay in TypeScript and pass their results in.",
      "- A user waits at most 10 seconds for a function and sends at most 4.5 MB to it. Say so next to the input when a person could run into it.",
      "- There is no stand-in: during the build `callPython` runs the real function on this machine through the local runner, and the platform runs each function again on the same input in verify's checks.",
      "- Smoke test: run one Python-backed action through its route with `expectPythonAction(request, \"<action>\", input)` from `tests/caps/runtime.ts`, and assert the reply's shape. It records the check.",
      "- `template/AGENTS.md` says the build machine reaches only npm, the Meta API and the Muse Muse gateway. For this brief it also reaches PyPI (pypi.org and files.pythonhosted.org), for downloads only.",
      "- `lib/platform/python.ts`, `scripts/py-local.mjs`, `api/py/musemuse_health.py`, `vercel.json`, `.python-version` and `tests/caps/runtime.ts` are platform files. Leave them as they are.",
    ];
  },
  refine(brief) {
    const runtime = block(brief);
    if (!runtime) return [];
    return [
      "- Its Python functions live in `api/py/` and actions call them with `callPython` (`.agents/skills/muse-python/SKILL.md`). After changing `requirements.txt`, run `node scripts/py-local.mjs install`.",
    ];
  },
  markdown(brief) {
    const runtime = block(brief);
    if (!runtime) return [];
    const names = runtime.functions.filter((f) => plainName(f.name)).map((f) => `\`${f.name}\``);
    return [
      runtime.why,
      "",
      `Python functions: ${names.join(", ") || "none"}. Packages: ${packages(runtime).length ? packages(runtime).map((p) => `\`${p}\``).join(", ") : "the standard library only"}.`,
    ];
  },
};
