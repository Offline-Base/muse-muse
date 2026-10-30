import { test } from "node:test";
import assert from "node:assert/strict";
import { docsConfig } from "@/lib/docs/proxy/deps";

/** Runs `fn` with these environment variables set (undefined unsets one), then puts them back. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("docs dollar caps: 0 means no paid calls, unset or garbage means the default", () => {
  withEnv({ DOCS_DAILY_SPEND_CAP_USD: "0", DOCS_IP_DAILY_USD: "0" }, () => {
    const cfg = docsConfig();
    assert.equal(cfg.docsDailyCapUsd, 0);
    assert.equal(cfg.perIpDailyUsd, 0);
  });
  withEnv({ DOCS_DAILY_SPEND_CAP_USD: undefined, DOCS_IP_DAILY_USD: "" }, () => {
    const cfg = docsConfig();
    assert.equal(cfg.docsDailyCapUsd, 25);
    assert.equal(cfg.perIpDailyUsd, 2);
  });
  withEnv({ DOCS_DAILY_SPEND_CAP_USD: "ten", DOCS_IP_DAILY_USD: "-1" }, () => {
    const cfg = docsConfig();
    assert.equal(cfg.docsDailyCapUsd, 25, "a typo doesn't switch spending off");
    assert.equal(cfg.perIpDailyUsd, 2);
  });
  withEnv({ DOCS_DAILY_SPEND_CAP_USD: "40", DOCS_IP_DAILY_USD: "0.5" }, () => {
    const cfg = docsConfig();
    assert.equal(cfg.docsDailyCapUsd, 40);
    assert.equal(cfg.perIpDailyUsd, 0.5);
  });
});
