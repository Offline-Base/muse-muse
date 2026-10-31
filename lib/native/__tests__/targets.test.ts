import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TARGETS, type Brief } from "@/lib/brief/schema";
import { env } from "@/lib/env";
import { applyTargets, briefTargets, hasNativeWork, parseNativeTargets, TARGET_GUIDE, validateTargets } from "@/lib/native/targets";
import { JOB_KIND_LANE, NATIVE_JOB_KINDS, NATIVE_LANES } from "@/lib/native/types";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

describe("briefTargets", () => {
  it("is web only for no brief, an older brief and an empty list", () => {
    assert.deepEqual(briefTargets(null), ["web"]);
    assert.deepEqual(briefTargets(undefined), ["web"]);
    assert.deepEqual(briefTargets(BRIEF), ["web"]);
    assert.deepEqual(briefTargets({ targets: [] }), ["web"]);
    assert.deepEqual(briefTargets({ targets: null }), ["web"]);
  });

  it("puts web first, keeps each target once and ignores ids it doesn't know", () => {
    const targets = [{ id: "phone" }, { id: "toaster" }, { id: "phone" }, { id: "web" }, { id: "vr" }];
    assert.deepEqual(briefTargets({ targets }), ["web", "phone", "vr"]);
  });

  it("hasNativeWork is true only for phone and desktop, which the native lane packages", () => {
    assert.equal(hasNativeWork(BRIEF), false);
    assert.equal(hasNativeWork({ targets: [{ id: "vr" }, { id: "agent" }] }), false);
    assert.equal(hasNativeWork({ targets: [{ id: "phone" }] }), true);
    assert.equal(hasNativeWork({ targets: [{ id: "desktop" }] }), true);
  });
});

describe("validateTargets", () => {
  it("takes nothing as nothing asked for", () => {
    assert.deepEqual(validateTargets(undefined, []), { ok: true, value: [] });
    assert.deepEqual(validateTargets(null, ["phone"]), { ok: true, value: [] });
  });

  it("orders them and keeps each once", () => {
    assert.deepEqual(validateTargets(["vr", "phone", "web", "phone"], ["phone", "vr"]), { ok: true, value: ["web", "phone", "vr"] });
  });

  it("refuses what isn't on here, and anything that isn't a list of targets", () => {
    assert.equal(validateTargets(["desktop"], ["phone"]).ok, false);
    assert.equal(validateTargets(["toaster"], ["phone"]).ok, false);
    assert.equal(validateTargets([1], ["phone"]).ok, false);
    assert.equal(validateTargets("phone", ["phone"]).ok, false);
    assert.equal(validateTargets({}, ["phone"]).ok, false);
  });
});

describe("applyTargets", () => {
  const withTargets = (targets: Brief["targets"]): Brief => ({ ...BRIEF, targets });

  it("returns the same object when nothing is enabled, whatever the brief says", () => {
    assert.equal(applyTargets(BRIEF, { enabled: [] }), BRIEF);
    const brief = withTargets([{ id: "phone", why: "x" }]);
    assert.equal(applyTargets(brief, { enabled: [], requested: ["phone"] }), brief);
  });

  it("adds web and drops what isn't enabled", () => {
    const out = applyTargets(withTargets([{ id: "phone", why: "On the go" }, { id: "desktop", why: "At a desk" }]), { enabled: ["phone"] });
    assert.deepEqual(out.targets, [
      { id: "web", why: "Every product runs on the web." },
      { id: "phone", why: "On the go" },
    ]);
  });

  it("lets the person's picks win over the writer's, keeping the writer's why where it has one", () => {
    const out = applyTargets(withTargets([{ id: "phone", why: "On the go" }, { id: "vr", why: "A space" }]), {
      enabled: ["phone", "desktop", "vr"],
      requested: ["desktop", "phone"],
    });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web", "desktop", "phone"]);
    assert.equal(out.targets?.[1]?.why, "You asked for it.");
    assert.equal(out.targets?.[2]?.why, "On the go");
  });

  it("ignores a pick that isn't enabled, and never changes the rest of the brief", () => {
    const out = applyTargets(BRIEF, { enabled: ["phone"], requested: ["vr"] });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web"]);
    assert.equal(out.name, BRIEF.name);
    assert.ok(!("targets" in BRIEF), "the brief it was given is left alone");
  });
});

describe("the target flags", () => {
  const withEnv = (vars: Record<string, string>, read: () => void) => {
    const names = ["NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED", "AGENTS_ENABLED", ...Object.keys(vars)];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    Object.assign(process.env, vars);
    try {
      read();
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  };

  it("NATIVE_TARGETS names phone and desktop only, in any case and order", () => {
    assert.deepEqual(parseNativeTargets(undefined), []);
    assert.deepEqual(parseNativeTargets(""), []);
    assert.deepEqual(parseNativeTargets(" , "), []);
    assert.deepEqual(parseNativeTargets("Desktop, PHONE"), ["phone", "desktop"]);
    assert.deepEqual(parseNativeTargets("web,vr,glasses,agent,toaster"), []);
  });

  it("every switch is off when nothing is set", () => {
    withEnv({}, () => {
      assert.deepEqual(env.nativeTargets, []);
      assert.deepEqual(env.enabledTargets, []);
      for (const off of [env.nativeLab, env.nativeDeviceFarm, env.vrEnabled, env.glassesEnabled, env.glassesNativeChecks, env.agentsEnabled, env.composioPersonalEnabled]) {
        assert.equal(off, false);
      }
    });
  });

  it("a switch takes the repo's usual words, and anything else is off", () => {
    for (const on of ["1", "true", "YES", " on "]) withEnv({ VR_ENABLED: on }, () => assert.equal(env.vrEnabled, true));
    for (const off of ["0", "false", "no", "off", "2", ""]) withEnv({ VR_ENABLED: off }, () => assert.equal(env.vrEnabled, false));
  });

  it("enabledTargets puts each switch's target in TARGETS order, and never web", () => {
    withEnv({ NATIVE_TARGETS: "desktop", AGENTS_ENABLED: "1", GLASSES_ENABLED: "1" }, () => {
      assert.deepEqual(env.enabledTargets, ["desktop", "glasses", "agent"]);
    });
    withEnv({ NATIVE_TARGETS: "vr" }, () => assert.deepEqual(env.enabledTargets, [], "vr has its own switch"));
  });

  it("the spend settings have the plan's defaults, and 0 means none", () => {
    withEnv({}, () => {
      assert.equal(env.nativeSpendCapUsd, 150);
      assert.equal(env.nativeDeviceFarmCapUsd, 40);
      assert.equal(env.nativeWindowsCapUsd, 15);
      assert.equal(env.nativeSpendAlertUsd, 120);
      assert.equal(env.toolsDailySpendCapUsd, 10);
      assert.equal(env.toolsDailyCalls, 3000);
      assert.equal(env.gatewayWonderTpm, 1_500_000);
    });
    withEnv({ TOOLS_DAILY_SPEND_CAP_USD: "0" }, () => assert.equal(env.toolsDailySpendCapUsd, 0));
    withEnv({ TOOLS_DAILY_SPEND_CAP_USD: "lots" }, () => assert.equal(env.toolsDailySpendCapUsd, 10));
  });
});

describe("the contract's lists", () => {
  it("has a guide for every target, in plain words with no em dash", () => {
    for (const id of TARGETS) {
      assert.ok(TARGET_GUIDE[id].length > 20, id);
      assert.doesNotMatch(TARGET_GUIDE[id], /\u2014/);
    }
    assert.doesNotMatch(Object.values(TARGET_GUIDE).join(" "), /\bExa\b/);
  });

  it("gives every job kind but shell_release a lane", () => {
    for (const kind of NATIVE_JOB_KINDS) {
      if (kind !== "shell_release") assert.ok(NATIVE_LANES.includes(JOB_KIND_LANE[kind]), kind);
    }
  });
});
