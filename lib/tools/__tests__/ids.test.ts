import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { denialOfSlug, denialOfToolkit, TOOL_POLICIES } from "@/lib/tools/catalog.source";
import { BUILTIN_TOOL_IDS, isToolId, PERSONAL_TOOL_IDS, PUBLIC_TOOL_IDS, TOOL_ERRORS, TOOL_IDS, toolMarker, toolOfMarker, type ToolId } from "@/lib/tools/ids";
import { toolKey } from "@/lib/tools/keys";

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "lib/tools/composio/catalog.json"), "utf8")) as { tools: Array<{ id: string }> };

describe("tool ids", () => {
  it("are exactly the catalog's, from its source and its generated file", () => {
    assert.deepEqual(TOOL_IDS, TOOL_POLICIES.map((p) => p.id));
    assert.deepEqual([...TOOL_IDS].sort(), catalog.tools.map((t) => t.id).sort());
  });

  it("split into public and personal, with web_search the only general search and built in", () => {
    assert.deepEqual([...PUBLIC_TOOL_IDS, ...PERSONAL_TOOL_IDS].sort(), [...TOOL_IDS].sort());
    assert.deepEqual(PUBLIC_TOOL_IDS, ["web_search", "scholar", "places", "events", "read_page"]);
    assert.deepEqual(BUILTIN_TOOL_IDS, ["web_search"]);
    assert.ok(!isToolId("web_results"));
    assert.ok(!isToolId("news"));
  });

  it("never name Exa, and nothing denied is listed", () => {
    for (const p of TOOL_POLICIES) {
      assert.doesNotMatch(p.id, /exa/i);
      if (p.toolkit) assert.equal(denialOfToolkit(p.toolkit), null, p.id);
      for (const f of p.functions) assert.equal(denialOfSlug(f.slug), null, f.slug);
    }
  });

  it("go to and from a token's markers", () => {
    const id: ToolId = "gmail_read";
    assert.equal(toolMarker(id), "tool:gmail_read");
    assert.equal(toolOfMarker("tool:gmail_read"), "gmail_read");
    assert.equal(toolOfMarker("tool:exa_search"), null);
    assert.equal(toolOfMarker("muse-wonder-1.0"), null);
    assert.equal(toolOfMarker("agent"), null);
  });

  it("have an error list with the statuses the contract gives", () => {
    assert.equal(TOOL_ERRORS.tool_not_allowed, 403);
    assert.equal(TOOL_ERRORS.tools_paused, 503);
    assert.equal(TOOL_ERRORS.tool_failed, 502);
  });
});

describe("toolKey", () => {
  const withEnv = (vars: Record<string, string | undefined>, read: () => void) => {
    const saved = Object.fromEntries(Object.keys(vars).map((n) => [n, process.env[n]]));
    for (const [n, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    try {
      read();
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  };

  it("gives each use its own key, and the pepper itself is never one", () => {
    withEnv({ TOOLS_SIGNING_SECRET: undefined, GATEWAY_TOKEN_PEPPER: "pepper-for-tests" }, () => {
      assert.notDeepEqual(toolKey("owner-pass"), toolKey("approvals"));
      assert.equal(toolKey("owner-pass").length, 32);
      assert.deepEqual(toolKey("owner-pass"), toolKey("owner-pass"));
      assert.ok(!toolKey("owner-pass").toString("utf8").includes("pepper"));
    });
  });

  it("changes when TOOLS_SIGNING_SECRET is set", () => {
    const keys: Buffer[] = [];
    withEnv({ TOOLS_SIGNING_SECRET: undefined, GATEWAY_TOKEN_PEPPER: "pepper-for-tests" }, () => keys.push(toolKey("a")));
    withEnv({ TOOLS_SIGNING_SECRET: "secret-for-tests", GATEWAY_TOKEN_PEPPER: "pepper-for-tests" }, () => keys.push(toolKey("a")));
    assert.notDeepEqual(keys[0], keys[1]);
  });
});
