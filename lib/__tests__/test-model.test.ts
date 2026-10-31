import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { env, testModel } from "@/lib/env";

const CONTRIBUTOR = "muse-spark-1.3-contributor";
const NAMES = ["TEST_MODEL", "VERCEL_ENV", "BUILD_MODEL", "BRIEF_MODEL", "JUDGE_MODEL", "COMPLEX_BUILD_MODEL"] as const;
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

function set(values: Partial<Record<(typeof NAMES)[number], string>>) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, values);
}

test("TEST_MODEL moves the brief, build and judge onto Contributor", () => {
  set({ TEST_MODEL: CONTRIBUTOR, BUILD_MODEL: "muse-wonder-1.0", VERCEL_ENV: "preview" });
  assert.equal(testModel(), CONTRIBUTOR);
  assert.equal(env.buildModel, CONTRIBUTOR);
  assert.equal(env.complexBuildModel, CONTRIBUTOR);
  assert.equal(env.briefModel, CONTRIBUTOR);
  assert.equal(env.judgeModel, CONTRIBUTOR);
});

test("TEST_MODEL never applies on production, where real people's data goes through", () => {
  set({ TEST_MODEL: CONTRIBUTOR, VERCEL_ENV: "production" });
  assert.equal(testModel(), null);
  assert.equal(env.buildModel, "muse-wonder-1.0");
  assert.equal(env.briefModel, "muse-wonder-1.0");
});

test("TEST_MODEL accepts only Contributor, and unset changes nothing", () => {
  set({ TEST_MODEL: "muse-spark-1.3" });
  assert.equal(testModel(), null);
  set({ TEST_MODEL: "muse-wonder-1.0" });
  assert.equal(testModel(), null);
  set({});
  assert.equal(testModel(), null);
  assert.equal(env.judgeModel, "muse-wonder-1.0");
});

test("the reminders-off setting names every reminder, scope too, and turns each one off", async () => {
  const { remindersOffSetting, REMINDER_IDS } = await import("@/lib/sandbox/muse-config");
  const [key, value] = [remindersOffSetting().slice(0, 20), JSON.parse(remindersOffSetting().slice(21))];
  assert.equal(key, "runtime_capabilities");
  for (const id of ["scope", ...REMINDER_IDS]) {
    assert.deepEqual(value[`plugin:tbh-reminders:reminder:${id}-reminder`], { enabled: false });
  }
});
