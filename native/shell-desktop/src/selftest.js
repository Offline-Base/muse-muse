// --muse-selftest=<dir> loads the product, records it for about 12 s, and writes selftest.json for the device lab.
// It turns no debugging on, so the fuses stay locked.

const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const { originOf } = require("./policy");

const RECORD_MS = 12_000;
const STILL_AT_MS = [1_500, 6_000, 11_500];
const FRAME_EVERY_MS = 100;
const FILL_AFTER_MS = 250;
const STILL_TRIES = 4;
const LOAD_LIMIT_MS = 45_000;
const MAX_CONSOLE_ERRORS = 50;
const MIN_TEXT_LENGTH = 20;

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** The first capture after a window opens can come back empty, so this tries a few times. A miss lowers the count. */
async function captureStill(contents) {
  for (let attempt = 0; attempt < STILL_TRIES; attempt += 1) {
    try {
      const image = await contents.capturePage();
      if (!image.isEmpty()) return image;
    } catch {
      // Try again below.
    }
    await delay(FILL_AFTER_MS);
  }
  return null;
}

/** The directory from --muse-selftest=<dir>, or null. A flag with no directory is treated as absent. */
function selftestDirFrom(argv) {
  const prefix = "--muse-selftest=";
  const arg = argv.find((item) => typeof item === "string" && item.startsWith(prefix));
  const dir = arg?.slice(prefix.length);
  return dir ? resolve(dir) : null;
}

/** The pass rules are the same as the phone shell's, from what the shell saw itself and what the page reported. */
function buildReport(seen, productOrigin, at) {
  const problems = [];
  if (seen.crashed) problems.push("The page crashed.");
  if (seen.loadError) problems.push(`The page didn't load: ${seen.loadError}`);
  if (seen.httpStatus !== null && seen.httpStatus >= 400) problems.push(`The page answered ${seen.httpStatus}.`);
  if (originOf(seen.finalUrl) !== productOrigin) problems.push("The page ended up on another site.");
  if (seen.textLength < MIN_TEXT_LENGTH) problems.push("The page looks blank.");
  if (!seen.handshake) problems.push("The page and the app couldn't talk to each other.");
  return {
    v: 1,
    ok: problems.length === 0,
    problems,
    warnings: seen.consoleErrors,
    at: at.toISOString(),
    ...seen,
  };
}

const PROBE = `(async () => {
  let handshake = false;
  try {
    const hello = await window.MuseNative.hello();
    handshake = hello && hello.version === 1;
  } catch {}
  return {
    handshake,
    title: String(document.title).slice(0, 200),
    textLength: document.body ? document.body.innerText.trim().length : 0,
  };
})()`;

/** Runs the whole selftest on a window, writes its files, and resolves with the exit code. */
async function runSelftest({ win, dir, config, shellVersion, platform }) {
  const contents = win.webContents;
  mkdirSync(join(dir, "frames"), { recursive: true });
  mkdirSync(join(dir, "stills"), { recursive: true });

  const startedAt = Date.now();
  const seen = {
    shellVersion,
    platform,
    url: config.url,
    finalUrl: null,
    httpStatus: null,
    loadMs: null,
    crashed: false,
    loadError: null,
    title: "",
    textLength: 0,
    handshake: false,
    // How long the frames span, so the lab can work out their real rate. They aren't evenly spaced.
    recordMs: RECORD_MS,
    frames: 0,
    stills: 0,
    consoleErrors: [],
  };

  contents.on("console-message", (event) => {
    if (event.level === "error" && seen.consoleErrors.length < MAX_CONSOLE_ERRORS) {
      seen.consoleErrors.push(String(event.message).slice(0, 300));
    }
  });
  contents.on("did-navigate", (_event, url, httpResponseCode) => {
    seen.finalUrl = url;
    seen.httpStatus = httpResponseCode > 0 ? httpResponseCode : null;
  });
  contents.on("did-navigate-in-page", (_event, url) => {
    seen.finalUrl = url;
  });
  contents.on("render-process-gone", () => {
    seen.crashed = true;
  });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    // -3 is a navigation this shell itself stopped, and it isn't a failure of the page.
    if (isMainFrame && code !== -3) seen.loadError = description || `error ${code}`;
  });

  const loaded = new Promise((done) => {
    contents.once("did-finish-load", done);
    contents.once("did-fail-load", done);
    contents.once("render-process-gone", done);
    setTimeout(done, LOAD_LIMIT_MS);
  });

  contents.loadURL(config.url).catch(() => {});
  await loaded;
  if (seen.loadMs === null && !seen.loadError) seen.loadMs = Date.now() - startedAt;
  if (!seen.loadError && !seen.finalUrl && seen.loadMs >= LOAD_LIMIT_MS) seen.loadError = "It took too long.";

  if (!seen.loadError && !seen.crashed) {
    let lastFrame = 0;
    const saveFrame = (image) => {
      lastFrame = Date.now();
      seen.frames += 1;
      writeFileSync(join(dir, "frames", `${String(seen.frames).padStart(5, "0")}.jpg`), image.toJPEG(80));
    };
    contents.beginFrameSubscription(false, (image) => {
      if (Date.now() - lastFrame >= FRAME_EVERY_MS && !image.isEmpty()) saveFrame(image);
    });
    // A page that isn't animating draws no new frames, and the clip still needs some, so capture those by hand.
    const filler = setInterval(() => {
      if (Date.now() - lastFrame < FILL_AFTER_MS) return;
      contents.capturePage().then(
        (image) => {
          if (!image.isEmpty()) saveFrame(image);
        },
        () => {},
      );
    }, FILL_AFTER_MS);

    const stills = STILL_AT_MS.map((at, index) =>
      delay(at)
        .then(() => captureStill(contents))
        .then((image) => {
          if (!image) return;
          seen.stills += 1;
          writeFileSync(join(dir, "stills", `${String(index + 1).padStart(2, "0")}.png`), image.toPNG());
        }),
    );
    await delay(RECORD_MS);
    await Promise.all(stills);
    clearInterval(filler);
    contents.endFrameSubscription();

    try {
      const probe = await contents.executeJavaScript(PROBE, true);
      seen.title = typeof probe?.title === "string" ? probe.title.slice(0, 200) : "";
      seen.textLength = Number.isFinite(probe?.textLength) ? probe.textLength : 0;
      seen.handshake = probe?.handshake === true;
    } catch {
      // The report says the handshake failed.
    }
  }

  const report = buildReport(seen, config.origin, new Date());
  writeFileSync(join(dir, "selftest.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

module.exports = { buildReport, runSelftest, selftestDirFrom };
