/**
 * The build room's state with `native` events in its log: they change nothing in it. Their step comes from apps.tsx, on top
 * of condenseNativeEvents, and goes in roomSteps' targets slot (apps.test.tsx).
 *   npx tsx --test components/build/__tests__/native-event.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveRoom } from "@/components/build/derive";
import type { BuildView } from "@/components/view-types";
import type { BuildEvent, BuildEventBody } from "@/lib/types";

const build: BuildView = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "build",
  message: null,
  rebuildOf: null,
  productId: "22222222-2222-4222-8222-222222222222",
  userId: "u1",
  inspirationId: "i1",
  status: "live",
  step: null,
  brief: null,
  buildModel: "muse-wonder-1.0",
  museSessionId: null,
  fixRounds: 0,
  previewUrl: null,
  costUsd: 3,
  error: null,
  startedAt: "2026-10-31T12:00:00.000Z",
  finishedAt: "2026-10-31T12:20:00.000Z",
};

const stored = (bodies: BuildEventBody[]) => bodies.map((b, i) => ({ ...b, id: i + 1, at: "2026-10-31T12:21:00.000Z" }) as BuildEvent);

const native: BuildEventBody = {
  type: "native",
  runId: "run-1",
  origin: "ship",
  item: "package:android",
  target: "phone",
  state: "done",
  title: "Packaged the Android app (41 MB)",
  artifact: { kind: "android_apk", url: "https://blob.example/a.apk", bytes: 41_000_000 },
  costUsd: 0.1,
};

describe("the build room with native events", () => {
  it("derives the same room as without them, apart from the stream's place", () => {
    const rest: BuildEventBody[] = [
      { type: "status", status: "live", message: "It's live." },
      { type: "deploy", url: "https://bird-count.vercel.app" },
      { type: "cost", totalUsd: 3, addedUsd: 3, what: "the build" },
    ];
    const plain = deriveRoom(build, stored(rest));
    const room = deriveRoom(build, stored([...rest, native, native]));
    assert.equal(room.lastEventId, plain.lastEventId + 2, "the stream's place still moves on");
    assert.deepEqual(JSON.parse(JSON.stringify({ ...room, lastEventId: 0 })), JSON.parse(JSON.stringify({ ...plain, lastEventId: 0 })));
  });

  it("doesn't crash on one from a newer branch with little in it", () => {
    assert.ok(deriveRoom(build, stored([{ type: "native" } as unknown as BuildEventBody])));
  });
});
