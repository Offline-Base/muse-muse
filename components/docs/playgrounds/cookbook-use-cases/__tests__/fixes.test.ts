/**
 * The review fixes of Oct 30, 2026: stateless replay of a real computer_call, the computer-use lab's budgets for a
 * cut-off reply and for replay, waiting out the live demos' rate limit with calls paced to it (checked against a fake
 * proxy that allows 20 calls a calendar minute, as production does), the Mines shell's compound commands, the
 * error-fix demo's second screenshot, clock times in the alert number check, the chart card's label match, and the
 * game loop's refinement passes. No network: clocks and sleeps are fakes.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-use-cases/__tests__/fixes.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { replayItems } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { DEFAULT_BUDGET, REPLAY_MAX_PAIRS, budgetsFor, cutOffText, raisedBudget, stepCap, stepOptionsUnder } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-budget";
import { createPacer, paceGapMs } from "@/components/docs/playgrounds/cookbook-use-cases/lib/pace";
import { RATE_RETRIES, retryText, withRetries, type RetryNote } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { minesShell, shellPipelines } from "@/components/docs/playgrounds/cookbook-use-cases/lib/mines-shell";
import { initialState, type MinesState } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-sim";
import { CART_SHOT_CHROME, CART_SHOT_UI, drawCartShot, type DrawContext } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cart-shot";
import { PLAN_PROMPT_TWO, SHOP_FILES } from "@/components/docs/playgrounds/cookbook-use-cases/lib/error-fix";
import { digestOf, numberCheck, syntheticAlerts } from "@/components/docs/playgrounds/cookbook-use-cases/lib/alerts";
import { checkBars } from "@/components/docs/playgrounds/cookbook-use-cases/lib/chart";
import { GAME_LOOP, SITE_LOOP } from "@/components/docs/playgrounds/cookbook-use-cases/lib/gamedev";
import { harnessSources } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/replies.json", import.meta.url), "utf8"));
type Json = Record<string, unknown>;

describe("stateless replay of the computer tool", () => {
  it("sends a real computer_call back unchanged, status and receipt included", () => {
    const reply = structuredClone(FIX.computer_call) as Json;
    const output = reply.output as Json[];
    const call = output.find((i) => i.type === "computer_call")!;
    // The fixture had its opaque receipt removed; put one back to check it survives.
    call.meta_safety_replay_receipt = "receipt-opaque";
    const items = replayItems(reply);
    const replayed = items.find((i) => i.type === "computer_call")!;
    assert.deepEqual(replayed, call, "the computer_call is replayed exactly as the API returned it");
    assert.equal(replayed.status, "completed");
    assert.equal(replayed.meta_safety_replay_receipt, "receipt-opaque");
    for (const item of items.filter((i) => i.type !== "computer_call")) assert.equal("status" in item, false, `${String(item.type)} drops its status`);
  });

  it("keeps function-call replays as they were (no status)", () => {
    const items = replayItems(FIX.metacua_call);
    const fc = items.find((i) => i.type === "function_call")!;
    assert.equal("status" in fc, false);
    assert.equal(fc.name, "computer.computer");
  });
});

describe("computer-use budgets", () => {
  it("raises a cut-off turn's budget within the model's cap", () => {
    assert.equal(DEFAULT_BUDGET, 4000);
    assert.equal(raisedBudget(1500, "muse-spark-1.3-contributor"), 4000);
    assert.equal(raisedBudget(4000, "muse-spark-1.3-contributor"), 8000);
    assert.equal(raisedBudget(8000, "muse-spark-1.3-contributor"), 16000);
    assert.equal(raisedBudget(16000, "muse-spark-1.3-contributor"), 16384);
    assert.equal(raisedBudget(16384, "muse-spark-1.3-contributor"), null, "at the cap there is nothing to raise");
    assert.equal(raisedBudget(8000, "muse-spark-1.2"), 8192, "Standard Spark stops at 8,192");
    assert.equal(raisedBudget(8192, "muse-spark-1.2"), null);
    assert.deepEqual(budgetsFor("muse-spark-1.2"), [1500, 4000, 8000]);
  });

  it("says what a cut-off reply spent", () => {
    const text = cutOffText({ output_tokens: 1500, output_tokens_details: { reasoning_tokens: 1498 } }, 1500);
    assert.match(text, /used 1,500 of its 1,500 output tokens \(1,498 of them reasoning\)/);
    assert.match(text, /status "incomplete"/);
    assert.match(cutOffText(null, 4000), /used 4,000 of its 4,000/);
  });

  it("caps direct replay of the computer tool at 29 calls and leaves the rest at 40", () => {
    assert.equal(stepCap("computer", "replay"), REPLAY_MAX_PAIRS);
    assert.equal(REPLAY_MAX_PAIRS, 29);
    assert.equal(stepCap("computer", "server"), 40);
    assert.equal(stepCap("metacua", "replay"), 40);
    assert.deepEqual(stepOptionsUnder(29), [6, 12, 24, 29]);
    assert.deepEqual(stepOptionsUnder(40), [6, 12, 24, 40]);
  });
});

/** A fake clock that sleeps by moving time forward. */
function fakeClock(start = Date.UTC(2026, 9, 30, 12, 0, 2)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

/**
 * The proxy's per-network limit as lib/docs/proxy/limits.ts applies it: calls counted per calendar minute, every
 * call counted (refused ones too), a 429 past the limit with retry-after the seconds to the next minute.
 */
function fakeProxy(clock: ReturnType<typeof fakeClock>, limit = 20, callMs = 500) {
  const counts = new Map<number, number>();
  let refused = 0;
  return {
    get refused() {
      return refused;
    },
    /** A call from somewhere else on the same network (another tab, the Ask panel). */
    bump(minute = Math.floor(clock.now() / 60_000), n = 1) {
      counts.set(minute, (counts.get(minute) ?? 0) + n);
    },
    async call() {
      const minute = Math.floor(clock.now() / 60_000);
      const n = (counts.get(minute) ?? 0) + 1;
      counts.set(minute, n);
      if (n > limit) {
        refused++;
        const retryAfterSec = Math.max(1, Math.ceil(((minute + 1) * 60_000 - clock.now()) / 1000));
        return { ok: false, status: 429, error: { type: "rate_limit_error", code: "rate_limited", message: `Live demos are limited to ${limit} runs a minute. Try again in ${retryAfterSec} s.`, retryAfterSec } };
      }
      clock.advance(callMs);
      return { ok: true, status: 200, error: null };
    },
  };
}

describe("the live demos' rate limit", () => {
  it("spaces calls 60 / limit seconds apart, with a little to spare", () => {
    assert.equal(paceGapMs(20), 3150);
    assert.equal(paceGapMs(600), 105);
    assert.equal(paceGapMs(Number.NaN), 3150, "an unreadable limit falls back to production's 20");
  });

  it("runs a 44-call agent run on a 20-a-minute proxy without one refusal", async () => {
    const clock = fakeClock();
    const proxy = fakeProxy(clock);
    const pace = createPacer({ limit: async () => 20, now: clock.now, sleep: clock.sleep });
    const started = clock.now();
    for (let i = 0; i < 44; i++) {
      const r = await withRetries(() => proxy.call(), { pace, sleep: clock.sleep });
      assert.equal(r.ok, true, `call ${i + 1}`);
    }
    assert.equal(proxy.refused, 0, "pacing alone keeps a run under the limit");
    assert.ok(clock.now() - started >= 43 * 3150, "and that costs about 3 s a call");
  });

  it("waits out 429s caused elsewhere on the network, for up to a minute each, instead of ending the run", async () => {
    const clock = fakeClock();
    const proxy = fakeProxy(clock);
    const pace = createPacer({ limit: async () => 20, now: clock.now, sleep: clock.sleep });
    // Another tab used 15 of this minute's runs, so this run hits the limit on its sixth call.
    proxy.bump(undefined, 15);
    const notes: RetryNote[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await withRetries(() => proxy.call(), { pace, sleep: clock.sleep, onRetry: (n) => notes.push(n) });
      assert.equal(r.ok, true, `call ${i + 1} went through`);
    }
    assert.ok(proxy.refused >= 1);
    assert.ok(notes.every((n) => n.kind === "rate_limit" && n.waitMs > 15_000 && n.waitMs <= 61_000), JSON.stringify(notes));
    assert.match(retryText(notes[0]), /^Live demos are limited to 20 runs a minute\. Try again in \d+ s\. Waiting \d+ s for the limit, then the same call goes again \(wait 1 of 3\)\.$/);
  });

  it("gives up on the day's limit and after three waits", async () => {
    const day = { ok: false, status: 429, error: { code: "rate_limited", message: "Live demos are limited to 400 runs a day.", retryAfterSec: 30_000 } };
    let calls = 0;
    const r = await withRetries(async () => (calls++, day), { pace: false, sleep: async () => {} });
    assert.equal(r, day);
    assert.equal(calls, 1);
    const busy = { ok: false, status: 429, error: { code: "model_busy", message: "busy", retryAfterSec: 20 } };
    calls = 0;
    await withRetries(async () => (calls++, busy), { pace: false, sleep: async () => {} });
    assert.equal(calls, RATE_RETRIES + 1);
  });

  it("stops during a wait without sending the call again", async () => {
    let stopped = false;
    let calls = 0;
    const r = await withRetries(
      async () => {
        calls++;
        return { ok: false, status: 429, error: { code: "rate_limited", message: "wait", retryAfterSec: 50 } };
      },
      {
        pace: false,
        stopped: () => stopped,
        sleep: async () => {
          stopped = true;
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(r.error?.code, "aborted", "a stop reads as a stopped run, so no error box shows");
  });
});

describe("the Mines shell", () => {
  const s0 = initialState("mines") as MinesState;
  const sh = (cmd: string, s: MinesState = s0) => minesShell(s, cmd);

  it("splits lines the way bash does", () => {
    assert.deepEqual(shellPipelines("pwd; whoami && ls ~/ | grep -i d || echo none"), [
      { after: ";", commands: ["pwd"] },
      { after: ";", commands: ["whoami"] },
      { after: "&&", commands: ["ls ~/", "grep -i d"] },
      { after: "||", commands: ["echo none"] },
    ]);
    assert.deepEqual(shellPipelines("echo 'a; b' | cat"), [{ after: ";", commands: ["echo 'a; b'", "cat"] }]);
    assert.deepEqual(shellPipelines("gnome-mines > /dev/null 2>&1 & sleep 1"), [
      { after: ";", commands: ["gnome-mines > /dev/null 2>&1 &"] },
      { after: ";", commands: ["sleep 1"] },
    ]);
  });

  it("answers each part of the compound probes Muse Spark sent in a live run", () => {
    assert.equal(sh("pwd; whoami; ls")[1], "/home/cua\ncua\nDesktop  Documents  Downloads");
    const [, desktop] = sh("cat /usr/share/applications/org.gnome.Mines.desktop; ps aux | grep Mines");
    assert.match(desktop, /^\[Desktop Entry\]\nName=Mines/);
    assert.match(desktop, /Exec=gnome-mines/);
    assert.match(desktop, /grep Mines$/, "ps | grep lists the grep itself, as on Linux");
    const [, probe] = sh("ps aux | grep -i mine; ls ~/; which gnome-mines");
    assert.deepEqual(probe.split("\n").slice(-2), ["Desktop  Documents  Downloads", "/usr/games/gnome-mines"]);
  });

  it("filters with grep, head and wc, and follows && and ||", () => {
    assert.equal(sh("ls /usr/share/applications | grep -i mine")[1], "org.gnome.Mines.desktop");
    assert.equal(sh("find / -iname '*mine*' 2>/dev/null | head -1")[1], "/usr/games/gnome-mines");
    assert.equal(sh("ls /usr/share/applications | wc -l")[1], "5");
    assert.equal(sh("which minesweeper || ls /usr/games")[1], "gnome-mines\nsol");
    assert.equal(sh("which minesweeper && ls /usr/games")[1], "");
    assert.equal(sh("grep -ril mine /usr/share/applications")[1], "/usr/share/applications/org.gnome.Mines.desktop");
  });

  it("keeps errors on stderr: past the pipe, and hidden by 2>/dev/null", () => {
    assert.equal(sh("which wmctrl xdotool; wmctrl -l | grep -i mine; gsettings get org.gnome.Mines board-size 2>/dev/null")[1], "/usr/bin/wmctrl\n/usr/bin/xdotool");
    assert.match(sh("gsettings list-recursively | grep -i mine")[1], /^bash: gsettings: command not found/, "a pipe doesn't filter stderr");
    assert.equal(sh("ls /nope /usr/games 2>&1 | grep nope")[1], "ls: cannot access '/nope': No such file or directory");
    assert.equal(sh("cat /nope 2>/dev/null || echo missing")[1], "missing");
  });

  it("opens the game from the shell, and the process list shows it", () => {
    for (const cmd of ["gnome-mines &", "nohup /usr/games/gnome-mines > /dev/null 2>&1 &", "DISPLAY=:0 gnome-mines & sleep 2", "gtk-launch org.gnome.Mines"]) {
      assert.equal(sh(cmd)[0].open, true, cmd);
    }
    const [open] = sh("gnome-mines &");
    assert.equal(sh("pgrep -a mines", open)[1], "4242 /usr/games/gnome-mines");
    assert.equal(sh("pgrep -a mines")[1], "", "nothing runs before it's launched");
    assert.match(sh("rm -rf /")[1], /command not found/);
  });
});

describe("the error-fix demo's second screenshot", () => {
  it("shows only text that's in the repo, so grep can find the code", () => {
    const source = Object.values(SHOP_FILES).join("\n");
    for (const text of [...Object.values(CART_SHOT_UI), CART_SHOT_CHROME.brand, ...CART_SHOT_CHROME.nav]) assert.ok(source.includes(text), `"${text}" is in the repo`);
    assert.match(SHOP_FILES["components/SummaryBoundary.tsx"], /We couldn't total your order\./);
    assert.match(PLAN_PROMPT_TWO, /second screenshot/);
  });

  it("draws no file names, stack or error text", () => {
    const drawn: string[] = [];
    const noop = () => {};
    const ctx = new Proxy({} as DrawContext, {
      get: (_t, key) => (key === "fillText" ? (text: string) => drawn.push(text) : noop),
      set: () => true,
    });
    drawCartShot(ctx);
    assert.ok(drawn.includes("Order summary") && drawn.includes("We couldn't total your order."), drawn.join(" | "));
    assert.ok(drawn.every((t) => !/\.tsx?|TypeError|undefined|at \w+ \(/.test(t)), drawn.join(" | "));
  });
});

describe("small fixes", () => {
  it("counts clock times as grounded in the alert answer check", () => {
    const d = digestOf(syntheticAlerts());
    const checks = numberCheck("Alerts spike between 02:00 and 04:00; 28 of 42 fire then, and 99 is made up.", d);
    assert.deepEqual(
      checks.map((c) => `${c.text}:${c.grounded}`),
      ["02:00:true", "04:00:true", "28:true", "42:true", "99:false"],
    );
  });

  it("keeps the label the model wrote on each matched bar, for the card's outline", () => {
    const checks = checkBars([{ label: "Cold-brew", value: 340 }], [{ label: "Cold brew", value: 340 }]);
    assert.equal(checks[0].readLabel, "Cold-brew");
    assert.equal(checks[0].known, 340);
  });

  it("numbers the game loop's refinement passes like the recipe, each check with its own screenshots", () => {
    assert.deepEqual(
      GAME_LOOP.refine.map((p) => p.label.split(":")[0]),
      ["Pass 1", "Pass 2", "Pass 3", "Pass 4"],
    );
    for (const pass of [...GAME_LOOP.refine, ...SITE_LOOP.refine]) {
      if (pass.probes) assert.equal(pass.probes.length, pass.probeLabels?.length, pass.label);
    }
    assert.match(GAME_LOOP.refine[2].prompt, /real race circuit/);
    assert.deepEqual(GAME_LOOP.refine[3].probes?.[0][0], { type: "sample", fn: "__sampleCamera", keys: ["ArrowUp", "ArrowLeft"], holdMs: 1500, everyMs: 100 });
    assert.match(GAME_LOOP.refine[3].prompt, /window\.__sampleCamera/);
    // The in-frame player runs the sampling probe.
    assert.match(harnessSources.pageSource(), /p\.type === "sample"/);
    assert.doesNotThrow(() => new Function(harnessSources.pageSource()));
  });
});
