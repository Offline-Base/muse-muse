/**
 * The pure half of scripts/backfill-live-urls.ts: which links are long, their short alias, and when moving is safe.
 *   npx tsx --test lib/publish/__tests__/live-alias.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideBackfill, deploymentIdOf, longLinkAlias, shortAliasFor } from "@/lib/publish/live-alias";

const LONG = "https://musemuse-crumb-ledger-weekly-ethan-6436s-projects.vercel.app";
const SHORT = "https://musemuse-crumb-ledger-weekly.vercel.app";

describe("longLinkAlias", () => {
  it("finds the short alias for the long team-scoped link, with or without a slash", () => {
    assert.equal(shortAliasFor("crumb-ledger-weekly"), SHORT);
    assert.equal(longLinkAlias(LONG, "crumb-ledger-weekly"), SHORT);
    assert.equal(longLinkAlias(`${LONG}/`, "crumb-ledger-weekly"), SHORT);
  });

  it("leaves short links, other projects, custom domains and odd values alone", () => {
    assert.equal(longLinkAlias(SHORT, "crumb-ledger-weekly"), null);
    assert.equal(longLinkAlias("https://musemuse-aisle-together-ethan-6436s-projects.vercel.app", "crumb-ledger-weekly"), null);
    assert.equal(longLinkAlias("https://crumb.example.com", "crumb-ledger-weekly"), null);
    assert.equal(longLinkAlias(`${LONG}/p/x`, "crumb-ledger-weekly"), null);
    assert.equal(longLinkAlias(LONG.replace("https:", "http:"), "crumb-ledger-weekly"), null);
    assert.equal(longLinkAlias("not a url", "crumb-ledger-weekly"), null);
    assert.equal(longLinkAlias(null, "crumb-ledger-weekly"), null);
  });
});

describe("deploymentIdOf", () => {
  it("reads the one deployment a page's asset links name", () => {
    const html = '<script src="/_next/static/a.js?dpl=dpl_9L4bSUeWZ9DwXQVe1xZPcFsjGVBg"></script><link href="/b.css?dpl=dpl_9L4bSUeWZ9DwXQVe1xZPcFsjGVBg">';
    assert.equal(deploymentIdOf(html), "dpl_9L4bSUeWZ9DwXQVe1xZPcFsjGVBg");
  });

  it("can't tell with none or with two", () => {
    assert.equal(deploymentIdOf("<html></html>"), null);
    assert.equal(deploymentIdOf("?dpl=dpl_AAAAAAAAAAAA ?dpl=dpl_BBBBBBBBBBBB"), null);
  });
});

describe("decideBackfill", () => {
  const ok = { status: 200, deploymentId: "dpl_AAAAAAAAAAAA" };

  it("moves a product only when both answer 200 from the same deployment", () => {
    assert.deepEqual(decideBackfill({ alias: SHORT, long: ok, short: ok }), { update: true, to: SHORT });
  });

  it("stays put when the alias doesn't answer, the link is down, or the deployments differ or can't be told", () => {
    assert.match((decideBackfill({ alias: SHORT, long: ok, short: { status: 404, deploymentId: null } }) as { why: string }).why, /short link answered 404/);
    assert.match((decideBackfill({ alias: SHORT, long: ok, short: { status: 0, deploymentId: null } }) as { why: string }).why, /answered nothing/);
    assert.match((decideBackfill({ alias: SHORT, long: { status: 308, deploymentId: null }, short: ok }) as { why: string }).why, /stored link answered 308/);
    assert.match((decideBackfill({ alias: SHORT, long: ok, short: { status: 200, deploymentId: "dpl_BBBBBBBBBBBB" } }) as { why: string }).why, /different deployments/);
    assert.match((decideBackfill({ alias: SHORT, long: ok, short: { status: 200, deploymentId: null } }) as { why: string }).why, /didn't say/);
  });
});
