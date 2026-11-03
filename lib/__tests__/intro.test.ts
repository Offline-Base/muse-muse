import assert from "node:assert/strict";
import { test } from "node:test";
import { INTRO_DEFAULT, isIntroKind, pickIntro } from "@/lib/intro";

const base = { param: null, path: "/", seen: false, reducedMotion: false };

test("first visit to the home page shows the default intro", () => {
  assert.equal(pickIntro(base), INTRO_DEFAULT);
});

test("seen, another page, or reduced motion: no intro", () => {
  assert.equal(pickIntro({ ...base, seen: true }), null);
  assert.equal(pickIntro({ ...base, path: "/builds" }), null);
  assert.equal(pickIntro({ ...base, reducedMotion: true }), null);
});

test("?intro= picks one on any page, even after it was seen; off turns it off", () => {
  assert.equal(pickIntro({ ...base, param: "shades", path: "/gallery", seen: true }), "shades");
  assert.equal(pickIntro({ ...base, param: "curtain", seen: true, reducedMotion: true }), "curtain");
  assert.equal(pickIntro({ ...base, param: "off" }), null);
  assert.equal(pickIntro({ ...base, param: "nope" }), INTRO_DEFAULT);
});

test("isIntroKind", () => {
  assert.ok(isIntroKind("curtain") && isIntroKind("shades"));
  assert.ok(!isIntroKind("hello"));
  assert.ok(!isIntroKind("Curtain") && !isIntroKind(undefined));
});
