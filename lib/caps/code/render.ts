import type { Brief } from "@/lib/brief/schema";
import { codeBlock, type CodeBrief } from "@/lib/caps/code/brief";
import { BROWSE_LIMITS, EXEC_LIMITS, SMOKE_EXEC_RUNS } from "@/lib/caps/code/limits";
import { codePartsOn } from "@/lib/caps/code/parts";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The code cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 15). Its text names the platform files in
 * template/caps/code: lib/platform/{code-run,pyodide,quickjs,exec,browse}.ts, components/platform/CodeOutput.tsx,
 * tests/caps/code.ts and the muse-code-run skill. The text follows codeBlock, which leaves out a part whose route is
 * switched off, so the build is never told to call a route that answers 404.
 */

const has = (block: CodeBrief, runtime: CodeBrief["runtimes"][number]) => block.runtimes.includes(runtime);

function asks(block: CodeBrief): string {
  const parts = [
    ...(has(block, "pyodide") ? ["Python in the visitor's browser (Pyodide)"] : []),
    ...(has(block, "quickjs") ? ["JavaScript in the visitor's browser (QuickJS)"] : []),
    ...(has(block, "exec") ? ["Python or Node on a platform sandbox with no network (`/exec`)"] : []),
    ...(block.browse ? ["opening one page whose address the person typed (`/browse`)"] : []),
  ];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const CODE_RENDER: CapRenderEntry = {
  title: "Running code",
  build(brief: Brief) {
    const block = codeBlock(brief);
    if (!block) return [];
    const lines = [
      `The brief asks for ${asks(block)}.`,
      "",
      "- Read `.agents/skills/muse-code-run/SKILL.md` first. It has every helper, what each returns, and the smoke test's rules.",
      "- Show every run's output with `CodeOutput` from `components/platform/CodeOutput.tsx`, right under the code that made it: stdout, errors, and how long it took.",
    ];
    if (has(block, "pyodide")) {
      lines.push(
        "- Python in the browser: `runPython(code, { stdin })` from `lib/platform/pyodide.ts`, in client components only. It loads Pyodide from the product's own static files in `public/musemuse/pyodide/` and runs it in a sealed frame with no network, no cookies and no access to the page, and stops a run after 10 seconds. The standard library only: no numpy, no pip, and no `js` or `pyodide.http` calls out.",
      );
    }
    if (has(block, "quickjs")) {
      lines.push(
        "- JavaScript in the browser: `runJavaScript(code, { stdin })` from `lib/platform/quickjs.ts`, in client components only. It runs in its own small engine with no page, no network and no `fetch`, 64 MB of memory, and stops after 3 seconds. `console.log` is its output, and `INPUT` holds stdin as text.",
      );
    }
    if (has(block, "exec")) {
      lines.push(
        `- Python or Node on the platform: \`runOnServer(request, { language, code, stdin, files })\` from \`lib/platform/exec.ts\`, in a route handler or server action only, passing the incoming request so the gateway knows who is asking. Each run gets a fresh sandbox with no network and no secrets, at most ${EXEC_LIMITS.runSeconds} seconds, ${EXEC_LIMITS.codeMaxBytes / 1024} KB of code and stdin, ${EXEC_LIMITS.filesMaxBytes / 1024 / 1024} MB of files and ${EXEC_LIMITS.outputMaxBytes / 1024} KB of output. Python has its standard library only.`,
        codePartsOn().visitors
          ? `- Anyone using the product can run code on the platform, ${EXEC_LIMITS.perPersonPerDay} programs a day each and ${EXEC_LIMITS.perProductPerDay} for the product. A person past their limit gets \`rate_limited\` (a \`CapError\`): say so plainly, and offer the browser runtime instead when the brief has one.`
          : `- Only the product's owner can run code on the platform: anyone else gets \`sign_in_required\` (a \`CapError\`). Show visitors plainly that running here is for the owner, and offer the browser runtime instead when the brief has one. Each person can run ${EXEC_LIMITS.perPersonPerDay} programs a day, and the product ${EXEC_LIMITS.perProductPerDay}.`,
        `- In this build, \`runOnServer\` runs for real: at most ${SMOKE_EXEC_RUNS} times each time the smoke test runs, and ${EXEC_LIMITS.perBuild} in the whole build. Don't call it while the page loads, only when a person asks.`,
      );
    }
    if (block.browse) {
      lines.push(
        "- Opening a page: `openPage(request, { url, input, actions })` from `lib/platform/browse.ts`, in a route handler or server action only. `input` is exactly what the person typed, and the address must be in it: the gateway refuses any other page. It opens that one site in a sandbox that reaches nothing else, follows no link to another site, and never signs in or types into password, code or card fields. It returns the page's `title`, `text` and a `screenshot` (a data URL for an `<img>`).",
        `- Only the product's owner can open pages: anyone else gets \`sign_in_required\`. A page gets ${BROWSE_LIMITS.seconds} seconds and at most ${BROWSE_LIMITS.actionsMax} click, type or wait steps, ${BROWSE_LIMITS.perPersonPerDay} pages a day per person.`,
        "- In this build, `openPage` returns one of the platform's recorded sample pages, marked `simulated: true`, whatever the address. Show it as you would a real one.",
      );
    }
    lines.push(
      "- Code never calls a model or an outside service. When the product also needs a model, call it in the product's own server code and pass the result in.",
      "- Smoke test: use `tests/caps/code.ts`. " +
        [
          ...(has(block, "pyodide") || has(block, "quickjs") ? ["Run the platform's fixture program in the page through the product's own editor with `codeFixture(\"python\" | \"javascript\")` and `expectInPageRun(page, fixture)`"] : []),
          ...(has(block, "exec") ? [`run \`codeFixture("python")\` through the product's own server route at most ${SMOKE_EXEC_RUNS} times and check what shows with \`expectExecOutput(page, fixture)\``] : []),
          ...(block.browse ? ["open one page through the product's own route and check what shows with `expectBrowsePage(page)`"] : []),
        ].join("; ") +
        ". Each records its check and takes its judge screenshot. Assert structure, never a sample page's words.",
    );
    if (block.browse) lines.push("- `template/AGENTS.md` says the product reaches only Meta's models and the gateway. For this brief the gateway also opens the page the person typed, for the owner only.");
    lines.push("- `lib/platform/code-run.ts`, `lib/platform/pyodide.ts`, `lib/platform/quickjs.ts`, `lib/platform/exec.ts`, `lib/platform/browse.ts`, `components/platform/CodeOutput.tsx`, `public/musemuse/pyodide/` and `tests/caps/code.ts` are platform files. Leave them as they are.");
    return lines;
  },
  refine(brief) {
    const block = codeBlock(brief);
    if (!block) return [];
    return ["- It runs code with the platform's helpers in `lib/platform/` and shows each run with `CodeOutput` (`.agents/skills/muse-code-run/SKILL.md`)."];
  },
  markdown(brief) {
    const block = codeBlock(brief);
    if (!block) return [];
    return [`Runs code: ${asks(block)}.`];
  },
};
