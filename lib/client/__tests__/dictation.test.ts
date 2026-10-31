import assert from "node:assert/strict";
import { test } from "node:test";
import { dictationError, insertDictation, looksLikeData, offersVoice, tidyTranscript, type FieldFacts } from "@/lib/client/dictation";

const field = (over: Partial<FieldFacts> = {}): FieldFacts => ({
  tag: "textarea",
  type: "textarea",
  names: "Your question",
  autocomplete: "",
  className: "pg-textarea",
  readOnly: false,
  disabled: false,
  noSpellcheck: false,
  voice: null,
  looksLikeData: false,
  width: 400,
  ...over,
});

test("prose fields offer voice", () => {
  assert.ok(offersVoice(field()));
  assert.ok(offersVoice(field({ tag: "input", type: "text", names: "name Your name" })));
  assert.ok(offersVoice(field({ tag: "input", type: "search", names: "Search the docs" })));
});

test("nothing secret is ever spoken", () => {
  for (const names of ["password", "access-code Access code", "API key", "MODEL_API_KEY", "token", "Bearer token", "secret", "passcode", "One-time code", "card number"]) {
    assert.equal(offersVoice(field({ tag: "input", type: "text", names })), false, names);
  }
  assert.equal(offersVoice(field({ tag: "input", type: "password", names: "" })), false);
  assert.equal(offersVoice(field({ tag: "input", type: "text", names: "", autocomplete: "current-password" })), false);
  assert.equal(offersVoice(field({ tag: "input", type: "text", names: "", autocomplete: "one-time-code" })), false);
  assert.equal(offersVoice(field({ tag: "input", type: "text", names: "", autocomplete: "cc-number" })), false);
});

test("exact values and code stay typed", () => {
  for (const type of ["email", "url", "number", "tel", "date", "file", "checkbox", "radio", "range", "hidden"]) {
    assert.equal(offersVoice(field({ tag: "input", type }), ), false, type);
  }
  for (const names of ["Email", "Image URL", "file_id", "Response ID", "JSON schema", "Cron schedule", "Tracking number", "ZIP"]) {
    assert.equal(offersVoice(field({ tag: "input", type: "text", names })), false, names);
  }
  assert.equal(offersVoice(field({ className: "pg-textarea pg-code-input" })), false);
  assert.equal(offersVoice(field({ noSpellcheck: true })), false);
  assert.ok(offersVoice(field({ tag: "input", type: "search", names: "Search the docs", noSpellcheck: true })));
  assert.equal(offersVoice(field({ looksLikeData: true })), false);
});

test("read-only, disabled and very small fields don't, and a field can opt out or bring its own button", () => {
  assert.equal(offersVoice(field({ readOnly: true })), false);
  assert.equal(offersVoice(field({ disabled: true })), false);
  assert.equal(offersVoice(field({ width: 100 })), false);
  assert.equal(offersVoice(field({ voice: "off" })), false);
  assert.equal(offersVoice(field({ voice: "inline" })), false);
  assert.equal(offersVoice(field({ tag: "select" })), false);
});

test("data is told from prose by how it starts", () => {
  for (const text of ['{"a":1}', "[1,2]", "<div>", "https://a.test", "data:image/png;base64,x", "curl -s x", "$ npm i"]) assert.ok(looksLikeData(text), text);
  for (const text of ["", "Hello there", "What's the weather?"]) assert.equal(looksLikeData(text), false, text);
});

test("words go at the caret, with spaces only where they're needed", () => {
  assert.deepEqual(insertDictation("", 0, 0, " hello there "), { value: "hello there", caret: 11 });
  assert.deepEqual(insertDictation("Say", 3, 3, "hello"), { value: "Say hello", caret: 9 });
  assert.deepEqual(insertDictation("Say ", 4, 4, "hello"), { value: "Say hello", caret: 9 });
  assert.deepEqual(insertDictation("Say there", 4, 4, "hello"), { value: "Say hello there", caret: 9 });
  assert.deepEqual(insertDictation("Say .", 4, 4, "hello"), { value: "Say hello.", caret: 9 });
  assert.deepEqual(insertDictation("Say OLD now", 4, 7, "new"), { value: "Say new now", caret: 7 });
});

test("words stop at the field's limit, and silence changes nothing", () => {
  assert.equal(insertDictation("abc", 3, 3, "defgh", 6).value, "abc de");
  assert.equal(insertDictation("abcdef", 6, 6, "more", 6).value, "abcdef");
  assert.equal(insertDictation("abc", 3, 3, "   ").value, "abc");
  assert.equal(insertDictation("abc", 3, 3, "defgh", -1).value, "abc defgh");
});

test("microphone errors read as what to do", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });
  assert.match(dictationError(named("NotAllowedError")), /Allow the microphone/);
  assert.match(dictationError(named("NotFoundError")), /No microphone/);
  assert.match(dictationError(named("NotReadableError")), /Another app/);
  assert.equal(dictationError(new Error("Too many runs")), "Too many runs");
  assert.match(dictationError("?"), /didn't work/);
});

test("a take cut off mid-sentence doesn't end in a doubled period, and an ellipsis stays", () => {
  assert.equal(tidyTranscript(" for Muse voice transcribe.. "), "for Muse voice transcribe.");
  assert.equal(tidyTranscript("and then..."), "and then...");
  assert.equal(tidyTranscript("Done."), "Done.");
});
