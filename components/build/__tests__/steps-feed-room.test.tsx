/**
 * BUILD_ROOM_STEPS: the room's two columns, from stored builds with made-up data. Flag off is covered byte for byte by
 * plan-art-flag-off.test.tsx.
 *
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/steps-feed-room.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";

const canMock = typeof (mock as { module?: unknown }).module === "function";
let room: (name: "running" | "failed" | "finished", feed: boolean) => string;

describe("the two column room", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/b/x" } });
    mock.module("next/link", { defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }) });
    const { renderToString } = await import("react-dom/server");
    const { BuildRoom } = await import("@/components/build/BuildRoom");
    const { FIXTURES, inspiration, tokens } = await import("@/components/build/__tests__/room-fixture");
    room = (name, feed) => {
      const f = FIXTURES[name];
      return renderToString(
        createElement(BuildRoom as ComponentType<never>, {
          build: f.build, product: f.product, inspiration, events: f.events, history: [], tokens, canRefine: false, canSteer: false, signedIn: true,
          origin: "https://musemuse.example", serverNow: Date.parse(f.build.startedAt) + 60_000, focusRefine: false, rebuild: null, maxFixRounds: 3, stepsFeed: feed,
        } as never),
      );
    };
  });

  it("puts the feed on the left and the plan on the right, with the raw steps behind Show details", () => {
    const html = room("running", true);
    const left = html.indexOf('class="room-feed-col"');
    const feed = html.indexOf('class="steps-feed"');
    const right = html.indexOf('class="room-stuff"');
    const plan = html.indexOf("plan-card");
    assert.ok(left >= 0 && left < feed && feed < right && right < plan);
    assert.match(html, /Show details/);
    assert.doesNotMatch(html, /Hide details/);
  });

  it("keeps the feed as a finished build's history, and says a failed one plainly", () => {
    assert.match(room("finished", true), /steps-feed-step/);
    const failed = room("failed", true);
    assert.match(failed, /The build stopped and did not ship/);
    assert.match(failed, /This build didn&#x27;t ship/);
  });

  it("shows no feed without the flag", () => {
    assert.doesNotMatch(room("running", false), /steps-feed|room-columns/);
  });

  it("puts no path or tool name in the feed", () => {
    for (const name of ["running", "failed", "finished"] as const) {
      const feed = /<ul class="steps-feed".*?<\/ul>/s.exec(room(name, true))?.[0] ?? "";
      assert.ok(feed);
      assert.doesNotMatch(feed.replace(/<[^>]+>/g, " "), /[/`—]|edit_file|\.tsx|mcp__|bash/);
    }
  });
});
