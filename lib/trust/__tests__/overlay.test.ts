/**
 * The trust overlay's platform side (lib/trust/overlay.ts): the two files written from the brief, the build prompt's
 * section, and the apply and restore scripts run for real in bash on a temporary git repo.
 *
 *   npx tsx --test lib/trust/__tests__/overlay.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderBuildPrompt } from "@/lib/brief/render";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { taskScript } from "@/lib/sandbox/tasks";
import { parseGeoCountries } from "@/lib/trust/geo";
import {
  applyTrustScript,
  productPrivacyFor,
  productTrustFor,
  restoreTrustFilesScript,
  TRUST_COMMIT,
  withTrustEnv,
} from "@/lib/trust/overlay";
import { trustBuildLines } from "@/lib/trust/prompt";

const FLAGS = { ageGate: true, legalPages: true, geoBlock: true, geoCountries: parseGeoCountries("meta"), reports: true };
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("musemuse.privacy.json", () => {
  it("names each model once with what it does and what it gets, and says nothing is kept on a server", () => {
    const p = productPrivacyFor({
      ...BRIEF,
      capabilities: [...BRIEF.capabilities, { need: "count them again", model: "sam-3.1", why: "x" }, { need: "read the label", model: "muse-wonder-1.0", why: "y" }],
    }) as { models: Array<{ id: string; label: string; does: string; gets: string[] }>; keeps: string[]; services: string[]; uploads: boolean };
    assert.deepEqual(p.models.map((m) => m.id), ["sam-3.1", "muse-wonder-1.0"]);
    assert.equal(p.models[0]!.does, "Find birds.");
    assert.deepEqual(p.models[0]!.gets, ["what you type", "the photos you add"]);
    assert.match(p.keeps[0]!, /^Nothing on a server/);
    assert.deepEqual(p.services, []);
    assert.equal(p.uploads, true);
  });

  it("names Composio when an agent uses tools beyond web search, and no uploads for text only", () => {
    const p = productPrivacyFor({
      ...BRIEF,
      inputs: [],
      agent: { task: "Plan a trip", tools: [{ id: "web_search", need: "a", why: "b" }, { id: "gmail_create_draft", need: "c", why: "d" }], connections: "owner", stepsPerRun: 4 },
    } as never) as { services: string[]; uploads: boolean };
    assert.equal(p.services.length, 1);
    assert.match(p.services[0]!, /to Composio, which runs the tool/);
    assert.equal(p.uploads, false);
  });
});

describe("musemuse.trust.json", () => {
  it("carries the flags, the Report link and the list, plus a model's own restriction", () => {
    const t = productTrustFor(BRIEF, { slug: "bird-count", platformUrl: "https://musemuse.example/", flags: FLAGS }) as Record<string, unknown>;
    assert.equal(t.reportUrl, "https://musemuse.example/report/bird-count");
    assert.equal(t.ageGate, true);
    assert.ok((t.geo as string[]).includes("CU"));
    assert.ok(!(t.geo as string[]).includes("IN"), "SAM isn't restricted in India");
    const image = productTrustFor({ ...BRIEF, capabilities: [{ need: "draw", model: "muse-image-1.0", why: "x" }] }, { slug: "s", platformUrl: "https://m", flags: FLAGS }) as { geo: string[] };
    assert.ok(image.geo.includes("IN"), "Muse Image is (Geographic Use Policy 2.2)");
    const off = productTrustFor(BRIEF, { slug: "s", platformUrl: "https://m", flags: { ...FLAGS, geoBlock: false, reports: false } }) as Record<string, unknown>;
    assert.deepEqual(off.geo, []);
    assert.equal(off.reportUrl, null);
  });
});

describe("the build prompt", () => {
  const opts = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
  it("gets the Trust pages section only with the overlay", () => {
    assert.deepEqual(trustBuildLines(undefined), []);
    assert.deepEqual(trustBuildLines(false), []);
    const plain = renderBuildPrompt(BRIEF, opts);
    const trusted = renderBuildPrompt(BRIEF, { ...opts, trust: true });
    assert.ok(!plain.includes("## Trust pages"));
    assert.ok(trusted.includes("## Trust pages"));
    assert.ok(trusted.indexOf("## Trust pages") > trusted.indexOf("## Meta models") && trusted.indexOf("## Trust pages") < trusted.indexOf("## Inputs"));
    assert.equal(trusted.replace(`${trustBuildLines(true).join("\n")}\n`, ""), plain);
    assert.ok(!/—/.test(trusted));
  });
});

describe(".env.local", () => {
  it("gets MUSEMUSE_BUILD=1 after the caps' lines with the overlay, and is unchanged without it", () => {
    assert.equal(withTrustEnv(undefined, false), undefined);
    assert.equal(withTrustEnv("A=1\n", false), "A=1\n");
    assert.equal(withTrustEnv(undefined, true), "MUSEMUSE_BUILD=1\n");
    assert.equal(withTrustEnv("A=1\n", true), "A=1\nMUSEMUSE_BUILD=1\n");
  });
});

describe("apply and restore, in bash", () => {
  const bash = (script: string, cwd: string) => spawnSync("bash", ["-c", script], { cwd, encoding: "utf8" });
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), "trust-overlay-"));
    dirs.push(root);
    const caps = path.join(root, "caps");
    const record = path.join(root, "record");
    const product = path.join(root, "product");
    mkdirSync(path.join(caps, "trust/files/components"), { recursive: true });
    mkdirSync(path.join(caps, "trust/files/app/(musemuse)/privacy"), { recursive: true });
    writeFileSync(path.join(caps, "trust/files/proxy.ts"), "export const proxy = 1;\n");
    writeFileSync(path.join(caps, "trust/files/components/Footer.tsx"), "export const Footer = 'trust';\n");
    writeFileSync(path.join(caps, "trust/files/app/(musemuse)/privacy/page.tsx"), "export default 1;\n");
    writeFileSync(path.join(caps, "trust/platform-files.json"), JSON.stringify(["proxy.ts", "components/Footer.tsx", "app/(musemuse)/privacy/page.tsx"]));
    mkdirSync(record);
    writeFileSync(path.join(record, "musemuse.trust.json"), '{"v":1}\n');
    writeFileSync(path.join(record, "musemuse.privacy.json"), '{"v":1,"models":[]}\n');
    mkdirSync(path.join(product, "components"), { recursive: true });
    writeFileSync(path.join(product, "components/Footer.tsx"), "export const Footer = 'template';\n");
    for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["add", "-A"], ["commit", "-qm", "Template"]]) git(product, ...args);
    return { caps, record, product };
  }

  it("applies the files and records in one commit, and a retry does nothing", () => {
    const { caps, record, product } = setup();
    const res = bash(applyTrustScript(caps, record), product);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(path.join(product, "components/Footer.tsx"), "utf8"), "export const Footer = 'trust';\n");
    assert.ok(existsSync(path.join(product, "app/(musemuse)/privacy/page.tsx")));
    assert.equal(readFileSync(path.join(product, "musemuse.privacy.json"), "utf8"), '{"v":1,"models":[]}\n');
    assert.equal(git(product, "log", "-1", "--format=%s").stdout.trim(), TRUST_COMMIT);
    assert.equal(git(product, "status", "--porcelain").stdout, "", "everything committed");
    writeFileSync(path.join(product, "proxy.ts"), "changed\n");
    assert.equal(bash(applyTrustScript(caps, record), product).status, 0);
    assert.equal(readFileSync(path.join(product, "proxy.ts"), "utf8"), "changed\n", "a retry leaves the build's work alone");
  });

  it("restore puts the platform files and records back in a product that has the overlay", () => {
    const { caps, record, product } = setup();
    bash(applyTrustScript(caps, record), product);
    rmSync(path.join(product, "proxy.ts"));
    writeFileSync(path.join(product, "components/Footer.tsx"), "export const Footer = () => null;\n");
    writeFileSync(path.join(product, "musemuse.trust.json"), '{"v":1,"ageGate":false}\n');
    const res = bash(restoreTrustFilesScript(caps, record), product);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, "");
    assert.equal(readFileSync(path.join(product, "proxy.ts"), "utf8"), "export const proxy = 1;\n");
    assert.equal(readFileSync(path.join(product, "components/Footer.tsx"), "utf8"), "export const Footer = 'trust';\n");
    assert.equal(readFileSync(path.join(product, "musemuse.trust.json"), "utf8"), '{"v":1}\n');
  });

  it("restore does nothing, and says nothing, in a product without it", () => {
    const { caps, record, product } = setup();
    const res = bash(restoreTrustFilesScript(caps, record), product);
    assert.equal(res.status, 0);
    assert.equal(res.stdout + res.stderr, "");
    assert.equal(readFileSync(path.join(product, "components/Footer.tsx"), "utf8"), "export const Footer = 'template';\n");
    assert.ok(!existsSync(path.join(product, "proxy.ts")));
    // Outside a git repo too, as the demo's own tests run it.
    const bare = mkdtempSync(path.join(tmpdir(), "trust-bare-"));
    dirs.push(bare);
    assert.equal(bash(restoreTrustFilesScript(caps, record), bare).status, 0);
  });

  it("is in every verify and demo, after the caps' restore", () => {
    for (const task of ["verify", "demo"] as const) {
      const script = taskScript(task, "/x/out");
      assert.ok(script.includes(restoreTrustFilesScript()), task);
      assert.ok(script.indexOf("/vercel/musemuse/caps/active.json") < script.indexOf(TRUST_COMMIT), task);
    }
  });
});
