/**
 * A shipped build's known issues (lib/pipeline/known-issues.ts) in the build room's last turn: listed by name, never a
 * clean "It's live." with the judge's mismatches hidden. A clean ship renders as before.
 *
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/known-issues.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const canMock = typeof (mock as { module?: unknown }).module === "function";

describe("ShipBody's known issues", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let turns: typeof import("@/components/build/turns");
  before(async () => {
    mock.module("next/link", { defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }) });
    turns = await import("@/components/build/turns");
  });

  it("lists each issue in place of the generic partial line", () => {
    const html = renderToStaticMarkup(
      createElement(turns.ShipBody, { status: "partial", liveUrl: "https://musemuse-fable-case-ledger.vercel.app", slug: "fable-case-ledger", issues: ["Final Memo screen must show the signed memo without a memo call failed error box."] }),
    );
    assert.match(html, /Shipped as partial\./);
    assert.match(html, /role="note" aria-label="Known issues"/);
    assert.match(html, /<strong>Known issue<\/strong>/);
    assert.match(html, /<li>Final Memo screen must show the signed memo without a memo call failed error box\.<\/li>/);
    assert.doesNotMatch(html, /some checks still fail for a documented reason/);
  });

  it("renders a clean ship and a partial without issues as before", () => {
    const live = renderToStaticMarkup(createElement(turns.ShipBody, { status: "live", liveUrl: null, slug: null }));
    assert.match(live, /It&#x27;s live\./);
    assert.doesNotMatch(live, /Known issue/);
    const partial = renderToStaticMarkup(createElement(turns.ShipBody, { status: "partial", liveUrl: null, slug: null }));
    assert.match(partial, /some checks still fail for a documented reason/);
  });

  it("names a polish round plainly and folds the platform's note away; a person's change renders as before", async () => {
    const { polishNote } = await import("@/lib/polish/logic");
    const html = renderToStaticMarkup(createElement(turns.UserTurn, { inspiration: null, message: polishNote("Tabs clip."), rebuild: null, showReferences: false }));
    assert.match(html, /Final pass on Muse Wonder/);
    assert.match(html, /A final UI pass to Meta&#x27;s look, on Muse Wonder\. Every feature stays as it is\./);
    assert.match(html, /<details class="bubble-context"><summary>What Muse Code was asked<\/summary>/);
    assert.match(html, /<p>Tabs clip\.<\/p>/);
    const plain = renderToStaticMarkup(createElement(turns.UserTurn, { inspiration: null, message: "Add a dark mode", rebuild: null, showReferences: false }));
    assert.doesNotMatch(plain, /Muse Wonder/);
    assert.match(plain, /Add a dark mode/);
  });
});
