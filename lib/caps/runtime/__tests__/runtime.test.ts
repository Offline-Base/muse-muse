/**
 * The runtime cap (docs/CAPABILITIES.md, section 16): its brief block, the writer's rules and catalog, the build
 * prompt's section, the build env, PyPI in the build firewall for downloads only, and the live check's Python route.
 *   npx tsx --test lib/caps/runtime/__tests__/runtime.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BriefSchema, newBriefSchemaFor, NewBriefSchemaNoGadget, type Brief } from "@/lib/brief/schema";
import { renderBuildPrompt, renderRefinePrompt, briefToMarkdown } from "@/lib/brief/render";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { briefCaps, capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks, howProductsRun } from "@/lib/caps/catalog";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { CAP_BUILD_HOSTS, capBuildHosts } from "@/lib/caps/hosts";
import { capsLivePaths } from "@/lib/caps/live";
import { capsFileFor, overlaysFor } from "@/lib/caps/overlays";
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { normalizeRuntimeBlock, RuntimeBriefBlock, type RuntimeBrief } from "@/lib/caps/runtime/brief";
import { liveCheck } from "@/lib/engine/live-check";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { builderNetworkPolicy, capHostRules } from "@/lib/sandbox/policy";

const RUNTIME: RuntimeBrief = {
  why: "Curve fitting and statistics need scipy.",
  functions: [{ name: "fit_curve", does: "Takes points and returns the best line and its error." }],
  packages: ["numpy", "scipy"],
};
const WITH: Brief = { ...BRIEF, runtime: RUNTIME } as Brief;
const render = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };

describe("the runtime brief block", () => {
  it("is an optional field of the stored brief, and in the writer's schema only when the cap is on", () => {
    assert.deepEqual(BriefSchema.parse(WITH).runtime, RUNTIME);
    assert.equal(BriefSchema.parse(BRIEF).runtime, undefined);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: [] }), NewBriefSchemaNoGadget);
    const on = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["runtime"] });
    assert.equal(on.safeParse(BRIEF).success, false, "required, as null, when the cap is on");
    assert.equal(on.safeParse({ ...BRIEF, runtime: null }).success, true);
    assert.equal(on.safeParse(WITH).success, true);
    const strict = strictJsonSchema(on) as { required: string[] };
    assert.ok(strict.required.includes("runtime"));
  });

  it("refuses more than 4 functions, none, and more than 8 packages", () => {
    const fn = (name: string) => ({ name, does: "x" });
    assert.equal(RuntimeBriefBlock.safeParse({ ...RUNTIME, functions: [] }).success, false);
    assert.equal(RuntimeBriefBlock.safeParse({ ...RUNTIME, functions: ["a", "b", "c", "d", "e"].map(fn) }).success, false);
    assert.equal(RuntimeBriefBlock.safeParse({ ...RUNTIME, packages: Array.from({ length: 9 }, (_, i) => `p${i}`) }).success, false);
  });

  it("is cleaned before zod: snake-case names once each, versions and web frameworks dropped, and null with no function", () => {
    const raw = {
      why: "  Python for the maths  ",
      functions: [{ name: "fitCurve", does: "fits" }, { name: "fit-curve", does: "again" }, { name: "musemuse_health", does: "taken" }, { name: "2d", does: "x" }, { name: "a", does: "x" }, { name: "b", does: "x" }, { name: "c", does: "x" }],
      packages: ["NumPy==2.3.4", "scipy>=1.14", "Flask", "fastapi[all]", "pandas ; python_version>'3.9'", "not a name!", "numpy"],
    };
    const out = normalizeRuntimeBlock(raw) as RuntimeBrief;
    assert.deepEqual(out.functions.map((f) => f.name), ["fit_curve", "py_2d", "a", "b"]);
    assert.deepEqual(out.packages, ["numpy", "scipy", "pandas"]);
    assert.equal(normalizeRuntimeBlock({ ...raw, functions: [{ name: "musemuse_health", does: "x" }] }), null);
    assert.equal(normalizeRuntimeBlock(null), null);
    // Through the brief's own normalizer, which the writer's reply always takes.
    const brief = normalizeRawBrief({ ...BRIEF, runtime: raw }, []) as { runtime: RuntimeBrief };
    assert.equal(brief.runtime.why, "Python for the maths");
    assert.ok(RuntimeBriefBlock.safeParse(brief.runtime).success);
    assert.equal((normalizeRawBrief({ ...BRIEF, runtime: null }, []) as { runtime: unknown }).runtime, null);
  });
});

describe("the writer's rules and catalog", () => {
  it("say when to pick Python, and are there only when the cap is on", () => {
    assert.equal(capsWriterRules([]), "");
    const rules = capsWriterRules(["runtime"]);
    assert.match(rules, /^\n\nPlatform services\n- runtime: fill it only when/);
    assert.match(rules, /Never a web framework/);
    assert.match(rules, /Python never calls a model/);
    assert.ok(!rules.includes("—"), "no em dashes");
    assert.deepEqual(capsCatalogBlocks([]), []);
    assert.match(capsCatalogBlocks(["runtime"]).join("\n"), /runtime \(Python functions\)/);
    assert.match(howProductsRun(["runtime"], { gadgets: false })!.first, /add small Python functions, only when the brief picks them/);
  });
});

describe("the build prompt", () => {
  it("has a Python functions section that names the skill, the helper, the runner, PyPI and the smoke rule", () => {
    const lines = capsBuildLines(WITH).join("\n");
    assert.match(lines, /^\n## Platform services\n\n### Python functions\n\nThe brief asks for Python: Curve fitting/);
    for (const want of ["`api/py/fit_curve.py`: Takes points", "`numpy`, `scipy`", ".agents/skills/muse-python/SKILL.md", 'callPython(request, "<name>", input)', "node scripts/py-local.mjs install", "expectPythonAction", "pypi.org and files.pythonhosted.org", "`template/AGENTS.md` says the build machine reaches only npm"]) {
      assert.ok(lines.includes(want), want);
    }
    assert.ok(!lines.includes("—"));
    assert.ok(renderBuildPrompt(WITH, render).includes("### Python functions"));
  });

  it("says what is true of the Python endpoints: public, with the deployment's settings, guarded, and never reading text as code", () => {
    const lines = capsBuildLines(WITH).join("\n");
    for (const want of [
      "`/api/py/<name>` is a public address, and on a deployment the function runs with the product's settings in its environment",
      "The guard clears them and refuses calls that don't come from `callPython`",
      "Each function still checks every field it uses",
      "`sympify` or `parse_expr`",
      "Verify's `safe` check",
      "node scripts/py-local.mjs new <name>",
      "a call never installs",
      "only an input of 64 KB or less is kept to run again",
      "Vercel's 500 MB for one Python function",
      "refuses to open `.env` files",
    ]) {
      assert.ok(lines.includes(want), want);
    }
    assert.ok(!lines.includes("It holds no key or token"), "the old claim is gone");
    const rules = capsWriterRules(["runtime"]);
    assert.match(rules, /inside Vercel's 500 MB for one Python function/);
    assert.match(rules, /Python never reads a person's text as code/);
    assert.ok(!renderBuildPrompt(BRIEF, render).includes("Python"));
  });

  it("names only plain function and package names, and says when there are no packages", () => {
    const odd = { ...WITH, runtime: { ...RUNTIME, functions: [{ name: "x; rm -rf /", does: "bad" }, { name: "ok_one", does: "fine" }], packages: [] } } as Brief;
    const lines = capsBuildLines(odd).join("\n");
    assert.ok(!lines.includes("rm -rf"));
    assert.ok(lines.includes("`api/py/ok_one.py`"));
    assert.match(lines, /No packages: the standard library is enough/);
  });

  it("adds a refine line and the product page's markdown, and nothing for a brief without the block", () => {
    assert.match(capsRefineLines(WITH).join("\n"), /api\/py\//);
    assert.match(capsMarkdown(WITH).join("\n"), /\*\*Python functions\*\*[\s\S]*`fit_curve`[\s\S]*`numpy`, `scipy`/);
    assert.ok(renderRefinePrompt({ brief: WITH, message: "Add a chart.", newReferences: [] }).includes("api/py/"));
    assert.ok(briefToMarkdown(WITH).includes("Python functions"));
    assert.deepEqual(capsBuildLines(BRIEF), []);
    assert.deepEqual(capsRefineLines(BRIEF), []);
    assert.deepEqual(capsMarkdown(BRIEF), []);
  });
});

describe("the build sandbox", () => {
  it("gets the runtime overlay with core, the build env line, the cap marker, and no deploy env", () => {
    assert.deepEqual(briefCaps(WITH), ["runtime"]);
    assert.deepEqual(overlaysFor(WITH), ["core", "runtime"]);
    assert.deepEqual(capsFileFor(WITH), { caps: ["runtime"], overlays: ["core", "runtime"] });
    assert.equal(capBuildEnv(WITH), "MUSEMUSE_PYTHON=local\nMUSEMUSE_PYTHON_NOTES=1\n");
    assert.deepEqual(capDeployEnv(WITH, "mm_live_x"), {});
    assert.ok(allowedModelsFor(WITH).includes("cap:runtime"));
    assert.ok(!allowedModelsFor(BRIEF).some((m) => m.startsWith("cap:")));
    assert.equal(capBuildEnv(BRIEF), "");
  });

  it("reaches PyPI for GET only, with the Host pinned, and api.meta.ai's rules stay as they are", () => {
    assert.deepEqual(CAP_BUILD_HOSTS.runtime, ["pypi.org", "files.pythonhosted.org"]);
    assert.deepEqual(capBuildHosts(["runtime"]), ["pypi.org", "files.pythonhosted.org"]);
    const policy = builderNetworkPolicy({ modelApiKey: "k", placeholderKey: "p", platformHost: null, capHosts: capBuildHosts(["runtime"]) }) as { allow: Record<string, unknown[]> };
    const without = builderNetworkPolicy({ modelApiKey: "k", placeholderKey: "p", platformHost: null }) as { allow: Record<string, unknown[]> };
    assert.deepEqual(policy.allow["api.meta.ai"], without.allow["api.meta.ai"]);
    for (const host of ["pypi.org", "files.pythonhosted.org"]) {
      assert.deepEqual(policy.allow[host], [
        { match: { method: ["GET"] }, transform: [{ headers: { Host: host } }] },
        { response: { statusCode: 403, body: "Blocked by the Muse Muse build firewall. This host is open to the build for downloads only.", contentType: "text/plain" } },
      ]);
    }
    assert.deepEqual(capHostRules("other.example"), [], "a host with no method list is allowed with no rules");
    assert.ok(!("pypi.org" in without.allow));
  });
});

describe("the live check", () => {
  it("loads the Python health function on the live link for a product with Python, and nothing more without", async () => {
    assert.deepEqual(capsLivePaths(BRIEF), []);
    assert.deepEqual(capsLivePaths(null), []);
    assert.deepEqual(capsLivePaths(WITH).map((p) => p.path), ["/api/py/musemuse_health"]);
    const seen: string[] = [];
    const site = (python: { status: number; body: unknown } | "down") =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        seen.push(`${init?.method ?? "GET"} ${u.pathname}`);
        if (u.pathname === "/") return new Response("<html><body>hi</body></html>", { headers: { "content-type": "text/html" } });
        if (u.pathname === "/api/musemuse/health") return Response.json({ ok: true });
        if (u.pathname === "/api/py/musemuse_health") {
          if (python === "down") throw new TypeError("fetch failed");
          return Response.json(python.body, { status: python.status });
        }
        return new Response("no", { status: 404 });
      }) as typeof fetch;
    const input = { url: "https://p.example", actions: [], health: true, capPaths: capsLivePaths(WITH), attempts: 1, waitMs: 0 };
    const ok = await liveCheck({ ...input, fetch: site({ status: 200, body: { ok: true, python: "3.12.7" } }) });
    assert.equal(ok.ok, true, ok.reason ?? "");
    assert.deepEqual(seen, ["GET /", "GET /api/musemuse/health", "GET /api/py/musemuse_health"]);
    const missing = await liveCheck({ ...input, fetch: site({ status: 404, body: { error: "x" } }) });
    assert.equal(missing.reason, "its Python functions don't run on the live link (/api/py/musemuse_health answered HTTP 404)");
    const down = await liveCheck({ ...input, fetch: site("down") });
    assert.match(down.reason!, /^its Python functions don't run on the live link \(\/api\/py\/musemuse_health gave the link couldn't be reached\)$/);
    seen.length = 0;
    await liveCheck({ ...input, capPaths: undefined, fetch: site("down") });
    assert.deepEqual(seen, ["GET /", "GET /api/musemuse/health"]);
  });
});
