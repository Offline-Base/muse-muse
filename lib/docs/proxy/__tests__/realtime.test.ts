import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCS_KEYS, minuteStart } from "@/lib/docs/proxy/limits";
import {
  closeMessage,
  handleDocsRealtime,
  realtimeSettings,
  realtimeUsage,
  relayRealtime,
  type RealtimeSocket,
} from "@/lib/docs/proxy/realtime";
import { errorOf, fakeDocs, IP, NOW, ORIGIN, TEST_KEY, wavBytes } from "./helpers";

/** A virtual clock: sleeps resolve only when the driver moves time to them. */
class FakeClock {
  t = 1_000;
  private timers: Array<{ at: number; resolve: () => void }> = [];
  now = () => this.t;
  sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = { at: this.t + ms, resolve };
      this.timers.push(timer);
      signal.addEventListener("abort", () => {
        this.timers = this.timers.filter((x) => x !== timer);
        resolve();
      });
    });
  /** Fires the earliest timer. False when none is waiting. */
  advance(): boolean {
    if (!this.timers.length) return false;
    this.timers.sort((a, b) => a.at - b.at);
    const next = this.timers.shift()!;
    this.t = Math.max(this.t, next.at);
    next.resolve();
    return true;
  }
}

/** Runs `work` to its end, letting promises settle before each step of virtual time. */
async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let finished = false;
  work.then(
    () => (finished = true),
    () => (finished = true),
  );
  for (let i = 0; i < 100_000 && !finished; i++) {
    await new Promise((r) => setImmediate(r));
    if (!finished) clock.advance();
  }
  return work;
}

type Behavior = "normal" | "error-before-ack" | "auth-error" | "refused-handshake" | "silent" | "drop-mid-stream" | "stall";

/** Meta's realtime socket, scripted: acknowledges the handshake, reports progress, flushes and closes on endStream. */
class FakeSocket implements RealtimeSocket {
  binaryType = "blob";
  sent: Array<{ at: number; data: string | Uint8Array }> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  private audioBytes = 0;

  constructor(
    readonly url: string,
    private readonly clock: FakeClock,
    private readonly behavior: Behavior = "normal",
    private readonly bytesPerMs = 32,
  ) {
    queueMicrotask(() => this.fire("open", {}));
  }

  addEventListener(type: string, listener: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private fire(type: string, event: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }

  private say(frame: unknown) {
    queueMicrotask(() => this.fire("message", { data: JSON.stringify(frame) }));
  }

  private shut(code: number, reason = "") {
    queueMicrotask(() => this.fire("close", { code, reason }));
  }

  send(data: string | ArrayBufferView) {
    const copy = typeof data === "string" ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    this.sent.push({ at: this.clock.now(), data: copy });
    if (typeof copy === "string") {
      const frame = JSON.parse(copy) as Record<string, unknown>;
      if (frame.authorization) {
        if (this.behavior === "error-before-ack") {
          this.say({ type: "error", message: "Unsupported model for mode", sessionId: "", errorType: "invalid_request_error" });
          this.shut(1008, "invalid request");
        } else if (this.behavior === "auth-error") {
          this.say({ type: "error", message: `Invalid access token ${TEST_KEY.slice(0, 8)}...`, errorType: "authentication_error" });
          this.shut(1008, `bad token ${TEST_KEY}`);
        } else if (this.behavior === "refused-handshake") {
          this.shut(1008, `credential ${TEST_KEY} rejected`);
        } else if (this.behavior !== "silent") {
          this.say({ sessionId: "sess-1" });
        }
      } else if (frame.type === "endStream" && this.behavior !== "stall") {
        this.say({ type: "transcript", transcript: "hello there", final: true, audioProcessedMs: this.audioBytes / this.bytesPerMs });
        this.shut(1000);
      }
      return;
    }
    this.audioBytes += copy.byteLength;
    const frames = this.sent.filter((s) => typeof s.data !== "string").length;
    if (this.behavior === "drop-mid-stream" && frames === 3) this.shut(1011, "backend failure");
    else if (frames % 5 === 0) this.say({ type: "audioProgress", audioProcessedMs: this.audioBytes / this.bytesPerMs });
  }

  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.shut(code ?? 1000, reason);
  }
}

function relayWith(behavior: Behavior, opts: { pcmMs?: number; rate?: number; abortAfterFrames?: number } = {}) {
  const clock = new FakeClock();
  const rate = opts.rate ?? 16_000;
  const pcm = new Uint8Array((rate / 1000) * 2 * (opts.pcmMs ?? 1_000));
  const events: Array<{ event: string; data: string }> = [];
  const sockets: FakeSocket[] = [];
  const reader = new AbortController();
  const done = relayRealtime({
    url: "wss://api.meta.test/v1/asr/realtime?sessionId=docs-1",
    connect: (url) => {
      const socket = new FakeSocket(url, clock, behavior, (rate / 1000) * 2);
      sockets.push(socket);
      if (opts.abortAfterFrames !== undefined) {
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          send(data);
          if (socket.sent.filter((s) => typeof s.data !== "string").length === opts.abortAfterFrames) reader.abort();
        };
      }
      return socket;
    },
    handshake: { authorization: { accessToken: `Bearer ${TEST_KEY}` }, audioEncoding: rate === 24_000 ? "PCM_24KHZ" : "PCM_16KHZ", model: "muse-voice-transcribe-1.0", mode: "PUSH_TO_TALK" },
    pcm,
    sampleRate: rate,
    emit: (event, data) => events.push({ event, data }),
    sleep: clock.sleep,
    now: clock.now,
    signal: reader.signal,
  });
  return { clock, events, sockets, done: drive(clock, done) };
}

test("the relay sends the handshake first, paces 80 ms frames in real time, ends with endStream, and relays every frame", async () => {
  const { events, sockets, done } = relayWith("normal", { pcmMs: 1_000 });
  const summary = await done;
  const socket = sockets[0];
  const handshake = JSON.parse(socket.sent[0].data as string) as Record<string, unknown>;
  assert.deepEqual(handshake.authorization, { accessToken: `Bearer ${TEST_KEY}` }, "the credential travels in the first frame");
  assert.equal(handshake.audioEncoding, "PCM_16KHZ");
  const frames = socket.sent.filter((s) => typeof s.data !== "string");
  assert.equal(frames.length, 13, "1 s of 16 kHz audio is 12.5 frames of 2,560 bytes");
  assert.deepEqual(
    frames.map((f) => f.at - frames[0].at),
    frames.map((_, i) => i * 80),
    "one frame every 80 ms, on schedule from the first",
  );
  assert.equal((frames[0].data as Uint8Array).byteLength, 2_560);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!.data as string), { type: "endStream" });

  assert.equal(events[0].event, "handshake");
  assert.deepEqual(JSON.parse(events[0].data), { sessionId: "sess-1" });
  assert.deepEqual(
    events.map((e) => e.event),
    ["handshake", "audioProgress", "audioProgress", "transcript", "done"],
  );
  const final = JSON.parse(events.at(-2)!.data) as { transcript: string; final: boolean };
  assert.equal(final.transcript, "hello there");
  assert.deepEqual(JSON.parse(events.at(-1)!.data), { ok: true, sessionId: "sess-1", code: 1000, audioMs: 1000, processedMs: 1000 });
  assert.equal(events.some((e) => e.data.includes(TEST_KEY)), false, "the key is never relayed");
  assert.equal(summary.sentMs, 1_000);
  assert.equal(summary.transcribed, true);
  assert.equal(socket.closedWith, null, "Meta closed it; the relay didn't have to");
});

test("24 kHz audio goes as PCM_24KHZ in 3,840-byte frames", async () => {
  const { sockets, done } = relayWith("normal", { pcmMs: 400, rate: 24_000 });
  await done;
  assert.equal(JSON.parse(sockets[0].sent[0].data as string).audioEncoding, "PCM_24KHZ");
  assert.deepEqual(
    sockets[0].sent.filter((s) => typeof s.data !== "string").map((s) => (s.data as Uint8Array).byteLength),
    [3_840, 3_840, 3_840, 3_840, 3_840],
  );
});

test("an error frame before the acknowledgement is relayed, then done; no audio is sent", async () => {
  const { events, sockets, done } = relayWith("error-before-ack");
  const summary = await done;
  assert.deepEqual(
    events.map((e) => e.event),
    ["error", "done"],
  );
  assert.match(events[0].data, /Unsupported model for mode/);
  assert.equal(sockets[0].sent.filter((s) => typeof s.data !== "string").length, 0);
  assert.equal(summary.failed, true);
  assert.equal(JSON.parse(events[1].data).ok, false);
  assert.deepEqual(realtimeUsage("muse-voice-transcribe-1.0", summary), [], "nothing sent, nothing billed");
});

test("an auth failure on the socket reads as the docs' own message, and nothing about the key gets through", async () => {
  for (const behavior of ["auth-error", "refused-handshake"] as const) {
    const { events, done } = relayWith(behavior);
    const summary = await done;
    assert.deepEqual(events.map((e) => e.event), ["error", "done"], behavior);
    const error = JSON.parse(events[0].data) as { code: string; message: string };
    assert.equal(error.code, "upstream_auth", behavior);
    assert.match(error.message, /refused Muse Muse's key for live demos/);
    const all = events.map((e) => e.data).join("\n");
    assert.equal(all.includes(TEST_KEY), false, `${behavior}: the key is never relayed`);
    assert.equal(all.includes(TEST_KEY.slice(0, 8)), false, `${behavior}: nor any of it`);
    assert.equal(all.includes("bad token") || all.includes("rejected"), false, `${behavior}: the close reason is dropped`);
    assert.equal(summary.failed, true);
  }
  // Other closes before the acknowledgement say their code, never their reason.
  const { events, done } = relayWith("silent");
  await done;
  assert.equal(JSON.parse(events[0].data).code, "realtime_handshake");
});

test("no acknowledgement within 10 s is an error, and the socket is closed", async () => {
  const { events, sockets, clock, done } = relayWith("silent");
  await done;
  assert.equal(clock.t, 11_000, "gave up at the deadline");
  assert.equal(events[0].event, "error");
  assert.equal(JSON.parse(events[0].data).code, "realtime_handshake");
  assert.equal(events.at(-1)!.event, "done");
  assert.equal(sockets[0].closedWith?.code, 1000);
});

test("Meta closing mid-stream ends the run with an error that says why", async () => {
  const { events, done } = relayWith("drop-mid-stream", { pcmMs: 2_000 });
  const summary = await done;
  const error = events.find((e) => e.event === "error");
  assert.ok(error);
  assert.match(JSON.parse(error.data).message, /internal error: backend failure/);
  assert.equal(summary.closeCode, 1011);
  assert.equal(summary.sentMs, 240, "three frames went before the close");
  assert.equal(realtimeUsage("muse-voice-transcribe-1.0", summary)[0].audioSeconds, 0.24);
});

test("a session that never finishes after endStream gives up after 20 s and closes the socket", async () => {
  const { events, sockets, clock, done } = relayWith("stall", { pcmMs: 160 });
  const summary = await done;
  const error = events.find((e) => e.event === "error");
  assert.equal(JSON.parse(error!.data).code, "realtime_stalled");
  assert.equal(events.at(-1)!.event, "done");
  assert.deepEqual(sockets[0].closedWith, { code: 1000, reason: "done" });
  assert.equal(summary.sentMs, 160);
  assert.ok(clock.t >= 1_000 + 80 + 20_000, "waited out the drain");
});

test("a reader who leaves stops the audio and closes the socket cleanly", async () => {
  const { sockets, done } = relayWith("normal", { pcmMs: 3_000, abortAfterFrames: 4 });
  const summary = await done;
  const socket = sockets[0];
  assert.equal(socket.sent.filter((s) => typeof s.data !== "string").length, 4);
  assert.equal(socket.sent.some((s) => s.data === JSON.stringify({ type: "endStream" })), false);
  assert.deepEqual(socket.closedWith, { code: 1000, reason: "reader left" });
  assert.equal(summary.sentMs, 320);
});

test("close codes read as a docs reader should hear them", () => {
  assert.match(closeMessage(1008, "below real-time ingress"), /refused the stream: below real-time ingress/);
  assert.match(closeMessage(1013, ""), /rate limited/);
  assert.match(closeMessage(4000, ""), /closed early \(code 4000\)/);
});

test("query settings: defaults, diarization, and refusals", () => {
  const defaults = realtimeSettings(new URLSearchParams());
  assert.deepEqual(defaults, { model: "muse-voice-transcribe-1.0", settings: { model: "muse-voice-transcribe-1.0", mode: "PUSH_TO_TALK", emitAudioProgress: true } });
  const diarized = realtimeSettings(new URLSearchParams("diarization=true&partialMode=delta&keywords=Muse, Spark,,&languageBias=English"));
  assert.ok("settings" in diarized);
  assert.equal(diarized.settings.mode, "DIARIZATION");
  assert.equal(diarized.settings.partialMode, "DELTA");
  assert.deepEqual(diarized.settings.keywords, ["Muse", "Spark"]);
  assert.deepEqual(diarized.settings.languageBias, ["English"]);
  const endpointing = realtimeSettings(new URLSearchParams("mode=endpointing"));
  assert.ok("settings" in endpointing && endpointing.settings.mode === "ENDPOINTING");
  assert.deepEqual(realtimeSettings(new URLSearchParams("mode=karaoke")), { error: "mode must be one of PUSH_TO_TALK, ENDPOINTING, DIARIZATION.", status: 400 });
  assert.equal((realtimeSettings(new URLSearchParams("model=muse-wonder-1.0")) as { status: number }).status, 404);
});

function realtimeRequest(body: BodyInit, query = "", headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/docs/asr-realtime${query}`, {
    method: "POST",
    headers: { host: "mm.example", origin: ORIGIN, "sec-fetch-site": "same-origin", "x-real-ip": IP, "content-type": "audio/wav", ...headers },
    body,
  });
}

test("POST /api/docs/asr-realtime: SSE down, billed by the audio, the key only in the handshake", async () => {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const g = fakeDocs();
  const res = await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 800), "?mode=ENDPOINTING"), g.deps, {
    connect: (url) => {
      const socket = new FakeSocket(url, clock);
      sockets.push(socket);
      return socket;
    },
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res.headers.get("x-docs-model"), "muse-voice-transcribe-1.0");
  const text = await drive(clock, res.text());
  assert.match(text, /^event: handshake\ndata: \{"sessionId":"sess-1"\}\n\n/);
  assert.match(text, /event: transcript\ndata: .*"final":true/);
  assert.match(text, /event: done\ndata: \{"ok":true[^\n]*\}\n\n$/);
  assert.equal(text.includes(TEST_KEY), false);
  assert.match(sockets[0].url, /^wss:\/\/api\.meta\.ai\/v1\/asr\/realtime\?sessionId=docs-[0-9a-f-]{36}$/);
  const handshake = JSON.parse(sockets[0].sent[0].data as string) as Record<string, unknown>;
  assert.equal(handshake.mode, "ENDPOINTING");
  await g.settled();
  assert.equal(g.usage[0].ctx.endpoint, "asr/realtime");
  assert.equal(g.usage[0].items[0].audioSeconds, 0.8);
  assert.equal(g.inFlight.get(DOCS_KEYS.inFlight(IP)), 0, "the slot comes back when the session ends");
  assert.equal(g.counter(DOCS_KEYS.minute(IP), minuteStart(NOW)), 1);
});

test("the realtime route refuses bad audio, other sites and runs over the limits before connecting", async () => {
  let connected = 0;
  const opts = { connect: () => ((connected++, null) as unknown as RealtimeSocket) };
  const g = fakeDocs();
  const stereo = await errorOf(await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 500, { channels: 2 })), g.deps, opts));
  assert.equal(stereo.code, "invalid_audio");
  assert.match(stereo.message, /mono/);
  const long = await errorOf(await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 61_000)), g.deps, opts));
  assert.match(long.message, /at most 60 s/);
  assert.equal((await errorOf(await handleDocsRealtime(realtimeRequest("{}", "", { "content-type": "application/json" }), g.deps, opts))).code, "invalid_body");
  assert.equal((await errorOf(await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 100), "", { origin: "https://evil.example" }), g.deps, opts))).code, "cross_site");
  assert.equal((await errorOf(await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 100), "?model=sam-3.1"), g.deps, opts))).code, "model_not_found");
  const busy = fakeDocs({ counters: { [`${DOCS_KEYS.minute(IP)}|${minuteStart(NOW).toISOString()}`]: 20 } });
  assert.equal((await errorOf(await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 100)), busy.deps, opts))).code, "rate_limited");
  const paused = fakeDocs({ config: { live: false } });
  assert.equal((await errorOf(await handleDocsRealtime(realtimeRequest(wavBytes(16_000, 100)), paused.deps, opts))).code, "docs_paused");
  assert.equal(connected, 0);
});
