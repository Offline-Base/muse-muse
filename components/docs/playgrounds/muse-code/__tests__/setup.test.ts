/**
 * The overview, auth and subscriptions builders against their pages: the exact install and CI commands, which
 * credential wins, the CI file, the plan picker, the Contributor-mode rules and the billing-cycle dates.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code/__tests__/setup.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { logout, resolveCredential } from "@/components/docs/playgrounds/muse-code/auth";
import { ciConfig, cleanSecretName, execCommand } from "@/components/docs/playgrounds/muse-code/ci";
import { commandLine, quoteArg, setEnv, utf8Bytes } from "@/components/docs/playgrounds/muse-code/shell";
import { AVAILABILITY, execLine, installSteps, INSTALL_POSIX, INSTALL_WINDOWS, taskCommand } from "@/components/docs/playgrounds/muse-code/start";
import {
  chargeDayIn,
  contributorMode,
  dayBefore,
  paygEstimate,
  PLANS,
  promptRange,
  recommendPlan,
  renewals,
  type ContributorInput,
} from "@/components/docs/playgrounds/muse-code/subscriptions";

const page = (slug: string) => readFileSync(`content/meta-docs/pages/${slug}.md`, "utf8");

describe("shell", () => {
  it("quotes prompts the way the page writes them, and safely otherwise", () => {
    assert.equal(quoteArg("Run the test suite and summarize failures."), '"Run the test suite and summarize failures."');
    assert.equal(quoteArg("--max-model-steps"), "--max-model-steps");
    assert.equal(quoteArg("costs $5"), "'costs $5'");
    assert.equal(quoteArg("it's here $x"), "'it'\\''s here $x'");
    assert.equal(quoteArg('say "hi" $x', "powershell"), "'say \"hi\" $x'");
    assert.equal(commandLine(["muse", "exec", "fix it"]), 'muse exec "fix it"');
    assert.equal(setEnv("META_API_KEY", '"x"', "powershell"), '$env:META_API_KEY = "x"');
    assert.equal(utf8Bytes("é"), 2);
  });
});

describe("start", () => {
  it("hands out the page's exact install commands", () => {
    const md = page("muse-code");
    assert.ok(md.includes(INSTALL_POSIX));
    assert.ok(md.includes(INSTALL_WINDOWS));
    assert.equal(installSteps("linux")[0].code, INSTALL_POSIX);
    assert.equal(installSteps("windows")[0].code, INSTALL_WINDOWS);
    assert.equal(installSteps("windows")[0].syntax, "powershell");
    assert.ok(installSteps("macos-arm").some((s) => s.notes.some((n) => n.includes("muse-spark-1.2"))));
  });

  it("writes the auth page's CI form, and PowerShell on Windows", () => {
    const ci = taskCommand("ci", { os: "linux", prompt: "Run the test suite and summarize failures.", model: "", secret: "MUSE_KEY" });
    assert.equal(ci.code, 'META_API_KEY="$MUSE_KEY" muse exec "Run the test suite and summarize failures."');
    assert.ok(page("muse-code/auth").includes(ci.code));
    const win = taskCommand("ci", { os: "windows", prompt: "x y", model: "muse-wonder-1.0", secret: "MUSE_KEY" });
    assert.equal(win.code, '$env:META_API_KEY = $env:MUSE_KEY\nmuse exec --model muse-wonder-1.0 "x y"');
    assert.equal(execLine("check it", "linux"), 'muse exec "check it"');
  });

  it("offers the auth page's two key options as alternatives, not one recipe", () => {
    const md = page("muse-code/auth");
    for (const os of ["linux", "windows"] as const) {
      const login = taskCommand("login", { os, prompt: "", model: "", secret: "" }).code.split("\n");
      const exported = login.findIndex((l) => l.includes("META_API_KEY"));
      const stored = login.indexOf("muse auth set");
      assert.ok(exported > 0 && stored > exported, os);
      assert.ok(login.slice(exported + 1, stored).some((l) => /^# or /.test(l)), `${os}: an "or" between them`);
    }
    assert.ok(md.includes('export META_API_KEY="<your-key>"') && md.includes("muse auth set"));
  });

  it("says workflows are missing from the Apple silicon package and voice from Windows", () => {
    const wf = AVAILABILITY.find((a) => a.feature === "Workflows")!;
    assert.match(wf.values["macos-arm"], /aarch64-apple-darwin/);
    assert.equal(AVAILABILITY.find((a) => a.feature.startsWith("Voice"))!.values.windows, "Unavailable");
    assert.equal(AVAILABILITY.find((a) => a.feature === "Session messaging")!.values.windows, "Unavailable");
  });
});

describe("auth", () => {
  it("prefers META_API_KEY, then a stored key, then a browser session", () => {
    assert.equal(resolveCredential({ account: "personal", envKey: true, storedKey: true, browserSession: true }).source, "env");
    assert.equal(resolveCredential({ account: "personal", envKey: false, storedKey: true, browserSession: true }).source, "stored-key");
    assert.equal(resolveCredential({ account: "personal", envKey: false, storedKey: false, browserSession: true }).source, "browser");
    assert.equal(resolveCredential({ account: "personal", envKey: false, storedKey: false, browserSession: false }).source, "none");
    assert.match(resolveCredential({ account: "personal", envKey: true, storedKey: false, browserSession: true }).notes.join(" "), /tells you/);
  });

  it("never uses a browser session for MMA accounts", () => {
    const r = resolveCredential({ account: "mma", envKey: false, storedKey: false, browserSession: true });
    assert.equal(r.source, "none");
    assert.match(r.summary, /Paste an API key/);
  });

  it("keeps an exported META_API_KEY through muse logout", () => {
    const out = logout({ account: "personal", envKey: true, storedKey: true, browserSession: true });
    assert.deepEqual([out.state.storedKey, out.state.browserSession, out.state.envKey], [false, false, true]);
    assert.match(out.message, /remove it from your shell or secret store/);
    assert.equal(resolveCredential(out.state).source, "env");
  });
});

describe("ci", () => {
  const base = { platform: "github" as const, secret: "MUSE_KEY", prompt: "Run the test suite and summarize failures.", posture: "disable-approval" as const, maxSteps: 40, json: false, contributor: "off" as const, verify: "npm test" };

  it("builds a GitHub Actions job with the secret only in the environment", () => {
    const out = ciConfig(base);
    assert.match(out.code, /META_API_KEY: \$\{\{ secrets\.MUSE_KEY \}\}/);
    assert.match(out.code, /curl -fsSL https:\/\/dev\.meta\.ai\/install\.sh \| sh/);
    assert.match(out.code, /muse exec --disable-approval --max-model-steps 40 --contributor-mode off "Run the test suite/);
    assert.match(out.code, /run: npm test/);
    assert.equal(out.label, ".github/workflows/muse-code.yml");
  });

  it("warns about unattended prompts, --yolo on pull requests, and a missing gate", () => {
    assert.match(ciConfig({ ...base, posture: "none" }).warnings.join(" "), /stays unresolved/);
    assert.match(ciConfig({ ...base, posture: "yolo", trigger: "pull_request" }).warnings.join(" "), /attacker-controlled/);
    assert.match(ciConfig({ ...base, verify: "" }).warnings.join(" "), /Gate on your own test command/);
    assert.match(ciConfig({ ...base, maxSteps: null }).warnings.join(" "), /--max-model-steps/);
  });

  it("writes GitLab and shell variants and cleans secret names", () => {
    assert.match(ciConfig({ ...base, platform: "gitlab" }).code, /META_API_KEY: \$MUSE_KEY/);
    assert.match(ciConfig({ ...base, platform: "shell" }).code, /META_API_KEY="\$MUSE_KEY" muse exec/);
    assert.equal(cleanSecretName("1 my-key!"), "mykey");
    assert.equal(cleanSecretName("!!"), "MUSE_KEY");
    assert.equal(execCommand({ ...base, json: true, promptFile: "./task.txt" }), "muse exec --disable-approval --max-model-steps 40 --contributor-mode off --json --prompt-file ./task.txt");
  });
});

describe("subscriptions", () => {
  it("lists the page's four plans and their multiples", () => {
    assert.deepEqual(PLANS.map((p) => [p.name, p.multiplier]), [
      ["Everyday Usage", 1],
      ["High Usage", 5],
      ["Power Usage", 20],
      ["Maximum Usage", 80],
    ]);
    assert.deepEqual(promptRange(PLANS[2]), { low: 200, high: 1000 });
    const md = page("muse-code/subscriptions");
    for (const p of PLANS) assert.ok(md.includes(`### ${p.name}`), p.name);
  });

  it("recommends by usage at the reader's prompt size, and by features", () => {
    assert.equal(recommendPlan({ prompts: 30, weight: "mixed", wonderFull: false, earlyAccess: false, higherUploads: false }).plan.id, "everyday");
    assert.equal(recommendPlan({ prompts: 30, weight: "heavy", wonderFull: false, earlyAccess: false, higherUploads: false }).plan.id, "high");
    assert.equal(recommendPlan({ prompts: 5, weight: "light", wonderFull: true, earlyAccess: false, higherUploads: false }).plan.id, "power");
    const over = recommendPlan({ prompts: 5000, weight: "light", wonderFull: false, earlyAccess: false, higherUploads: false });
    assert.equal(over.overMax, true);
    assert.equal(over.plan.id, "maximum");
    assert.match(over.reasons.join(" "), /wait for your limit to refresh/);
  });

  it("estimates pay-as-you-go from the pricing table", () => {
    const e = paygEstimate({ model: "muse-spark-1.2", promptsPerDay: 10, daysPerMonth: 20, inputTokens: 1_000_000, cachedShare: 0, outputTokens: 0 });
    assert.equal(e.perPrompt, 1.25);
    assert.equal(e.perMonth, 250);
    assert.equal(e.promptsPerMonth, 200);
  });

  const sub = (p: Partial<ContributorInput>): ContributorInput => ({ billing: "subscription", surface: "headless", flag: "none", env: "unset", saved: "never", ...p });

  it("follows the page's Contributor mode rules for a run", () => {
    assert.equal(contributorMode(sub({ saved: "nofile" })).state, "off");
    assert.equal(contributorMode(sub({ saved: "never" })).state, "maybe");
    assert.equal(contributorMode(sub({ surface: "interactive", saved: "nofile" })).state, "on");
    assert.equal(contributorMode(sub({ flag: "off", env: "1" })).state, "off");
    assert.match(contributorMode(sub({ flag: "off", env: "1" })).reasons.join(" "), /flag wins/);
    assert.equal(contributorMode(sub({ env: "1" })).state, "on");
    assert.equal(contributorMode(sub({ surface: "interactive", flag: "on" })).row, "(run override)");
    assert.equal(contributorMode(sub({ saved: "on" })).state, "on");
    const managed = contributorMode(sub({ billing: "managed", flag: "on", env: "1" }));
    assert.equal(managed.state, "off");
    assert.match(managed.reasons.join(" "), /no effect/);
    assert.equal(contributorMode(sub({ billing: "payg" })).state, "hidden");
    assert.equal(contributorMode(sub({ billing: "zdr" })).row, null);
  });

  it("charges on the last day when the subscription day doesn't exist", () => {
    assert.deepEqual(chargeDayIn(2026, 2, 31), { y: 2026, m: 2, d: 28 });
    assert.deepEqual(chargeDayIn(2028, 2, 31), { y: 2028, m: 2, d: 29 });
    const r = renewals({ y: 2026, m: 1, d: 31 }, { y: 2026, m: 1, d: 31 }, 4);
    assert.deepEqual(r, [
      { y: 2026, m: 2, d: 28 },
      { y: 2026, m: 3, d: 31 },
      { y: 2026, m: 4, d: 30 },
      { y: 2026, m: 5, d: 31 },
    ]);
    assert.deepEqual(renewals({ y: 2026, m: 11, d: 15 }, { y: 2026, m: 11, d: 15 }, 2), [
      { y: 2026, m: 12, d: 15 },
      { y: 2027, m: 1, d: 15 },
    ]);
    assert.deepEqual(dayBefore({ y: 2026, m: 3, d: 1 }), { y: 2026, m: 2, d: 28 });
    // The billing tab passes today: only the charges still to come, the last-day rule included.
    assert.deepEqual(renewals({ y: 2026, m: 1, d: 31 }, { y: 2026, m: 10, d: 30 }, 3), [
      { y: 2026, m: 10, d: 31 },
      { y: 2026, m: 11, d: 30 },
      { y: 2026, m: 12, d: 31 },
    ]);
  });
});
