import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replyView, userView } from "@/components/docs/chat/reply";
import type { ChatPart } from "@/lib/docs/client/assistant";

const searched: ChatPart = { kind: "tool", name: "search_docs", label: 'Searched the docs for "streaming"', state: "done" };
const running: ChatPart = { kind: "tool", name: "run_demo", label: "Running the demo", state: "running" };
const stopped: ChatPart = { kind: "tool", name: "run_demo", label: "Ran the demo", state: "failed", detail: "Stopped." };
const pictures: ChatPart = { kind: "images", srcs: ["data:image/png;base64,AAAA"] };
const answer: ChatPart = { kind: "text", text: "Streaming has its own page." };

describe("a reply while it runs", () => {
  it("waits on the model before anything comes, and again after a step finishes", () => {
    assert.deepEqual(replyView([], true), { folded: [], shown: [], waiting: true });
    assert.equal(replyView([searched], true).waiting, true);
    assert.equal(replyView([searched, pictures], true).waiting, true, "pictures from a finished step");
  });

  it("doesn't wait while a step runs, even when the step's pictures come first", () => {
    assert.equal(replyView([running], true).waiting, false);
    assert.equal(replyView([searched, running, pictures], true).waiting, false);
  });

  it("doesn't wait while its words stream, and shows every part in order", () => {
    const view = replyView([searched, pictures, answer], true);
    assert.equal(view.waiting, false);
    assert.deepEqual(view.shown, [searched, pictures, answer]);
    assert.deepEqual(view.folded, [], "nothing folds until it's done");
  });
});

describe("a finished reply", () => {
  it("folds every step behind Show thinking and keeps what it made and its answer in order", () => {
    assert.deepEqual(replyView([searched, pictures, stopped, answer], false), {
      folded: [searched, stopped],
      shown: [pictures, answer],
      waiting: false,
    });
  });

  it("folds nothing when it took no steps, and shows nothing for one that ended before a word", () => {
    assert.deepEqual(replyView([answer], false), { folded: [], shown: [answer], waiting: false });
    assert.deepEqual(replyView([], false), { folded: [], shown: [], waiting: false });
  });
});

describe("the reader's message", () => {
  it("has its words, and its pictures for the bubble's thumbnails", () => {
    assert.deepEqual(userView([{ kind: "text", text: "Can you make an image?" }]), { text: "Can you make an image?", images: [] });
    assert.deepEqual(userView([{ kind: "text", text: "Like this" }, pictures, { kind: "text", text: "but blue" }]), {
      text: "Like this\n\nbut blue",
      images: ["data:image/png;base64,AAAA"],
    });
  });
});
