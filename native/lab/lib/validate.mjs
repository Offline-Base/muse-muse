// Job input validation (docs/NATIVE_LAB.md, "Job inputs"). The platform builds these inputs, so a problem here is a bug
// or a tampered job, and the job finishes as failed with code invalid_input. Everything is pure. The rules are strict
// because the values end up as arguments to simctl, adb and the apps under test.

export const KINDS = ["ios_sim", "android_emu", "desktop_mac", "desktop_windows", "glasses_sim"];

export const LANE_OF = {
  ios_sim: "mac",
  android_emu: "mac",
  desktop_mac: "mac",
  glasses_sim: "mac",
  desktop_windows: "windows",
};

/** What each kind needs to itself. Two jobs that share a resource never run at once. */
export const RESOURCE_OF = {
  ios_sim: "simulator",
  glasses_sim: "simulator",
  android_emu: "emulator",
  desktop_mac: "desktop",
  desktop_windows: "desktop",
};

export const LIMITS = {
  limitSeconds: { min: 30, max: 900 },
  recordSeconds: { min: 6, max: 25, fallback: 15 },
  shots: { min: 1, max: 4, fallback: 2 },
  selftestSeconds: { min: 8, max: 20, fallback: 12 },
};

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";
const SHA256 = /^[a-f0-9]{64}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/;
const EXE_NAME = /^[^\\/:*?"<>|\r\n]{1,120}\.exe$/i;
const DEVICE_NAME = /^[A-Za-z0-9 ._()-]{1,60}$/;
const SCENARIOS = ["capture-and-ask"];
const APP_KINDS = {
  ios_sim: "ios_sim_app",
  glasses_sim: "ios_sim_app",
  android_emu: "apk",
  desktop_mac: "mac_zip",
  desktop_windows: "windows_zip",
};
const VARIANTS = {
  ios_sim: ["lab"],
  glasses_sim: ["glasses"],
  android_emu: ["lab", "product"],
  desktop_mac: ["lab", "product"],
  desktop_windows: ["lab", "product"],
};

class Invalid extends Error {}

function fail(message) {
  throw new Invalid(message);
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** A whole number inside its limits, or the limit's fallback when it's missing. */
function bounded(value, name, { min, max, fallback }) {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(`${name} is required.`);
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** Why `raw` can't be opened as a page under test, or null. */
export function targetUrlProblem(raw, { allowInsecure = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0) return "is missing";
  if (raw.length > 2048) return "is too long";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "isn't a valid URL";
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (allowInsecure && local && (url.protocol === "http:" || url.protocol === "https:")) return null;
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "can't carry a user name or password";
  if (url.port) return "can't name a port";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return "can't be an IP address";
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") {
    return "must be a public host";
  }
  return null;
}

/** Why the lab won't download from `raw`, or null. Only Vercel Blob and the platform itself. */
export function downloadUrlProblem(raw, { platformOrigin = null, allowInsecure = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0) return "is missing";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "isn't a valid URL";
  }
  if (platformOrigin && url.origin === platformOrigin) return null;
  if (allowInsecure && ["localhost", "127.0.0.1"].includes(url.hostname)) return null;
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "can't carry a user name or password";
  if (!url.hostname.toLowerCase().endsWith(BLOB_HOST_SUFFIX)) return "must be on Vercel Blob or the platform";
  return null;
}

function checkTarget(input, opts) {
  if (!isObject(input.target)) fail("input.target is required.");
  const problem = targetUrlProblem(input.target.url, opts);
  if (problem) fail(`input.target.url ${problem}.`);
  return { url: input.target.url, origin: new URL(input.target.url).origin };
}

function checkDownload(spec, name, opts, { sha = true } = {}) {
  if (!isObject(spec)) fail(`${name} is required.`);
  const problem = downloadUrlProblem(spec.url, opts);
  if (problem) fail(`${name}.url ${problem}.`);
  if (sha && (typeof spec.sha256 !== "string" || !SHA256.test(spec.sha256))) fail(`${name}.sha256 must be 64 hex characters.`);
  if (spec.sha256 !== undefined && (typeof spec.sha256 !== "string" || !SHA256.test(spec.sha256))) {
    fail(`${name}.sha256 must be 64 hex characters.`);
  }
  if (spec.bytes !== undefined && (!Number.isInteger(spec.bytes) || spec.bytes <= 0)) fail(`${name}.bytes must be a positive number.`);
  return { url: spec.url, sha256: spec.sha256 ?? null, bytes: spec.bytes ?? null };
}

function checkApp(kind, input, opts) {
  const app = input.app;
  if (!isObject(app)) fail("input.app is required.");
  if (app.kind !== APP_KINDS[kind]) fail(`input.app.kind must be ${APP_KINDS[kind]}.`);
  if (!VARIANTS[kind].includes(app.variant)) fail(`input.app.variant must be one of ${VARIANTS[kind].join(", ")}.`);
  if (typeof app.version !== "string" || !VERSION.test(app.version)) fail("input.app.version isn't valid.");
  const out = { kind: app.kind, variant: app.variant, version: app.version, ...checkDownload(app, "input.app", opts) };
  if (kind === "ios_sim" || kind === "glasses_sim") {
    if (typeof app.bundleId !== "string" || !BUNDLE_ID.test(app.bundleId)) fail("input.app.bundleId isn't valid.");
    out.bundleId = app.bundleId;
  }
  if (kind === "android_emu") {
    if (typeof app.packageName !== "string" || !PACKAGE_NAME.test(app.packageName)) fail("input.app.packageName isn't valid.");
    out.packageName = app.packageName;
  }
  if (kind === "desktop_windows" && app.exeName !== undefined) {
    if (typeof app.exeName !== "string" || !EXE_NAME.test(app.exeName)) fail("input.app.exeName isn't valid.");
    out.exeName = app.exeName;
  }
  return out;
}

function checkSelftest(input, opts) {
  const selftest = input.selftest;
  if (selftest === undefined || selftest === null) return null;
  if (!isObject(selftest)) fail("input.selftest isn't valid.");
  if (typeof selftest.token !== "string" || !TOKEN.test(selftest.token)) fail("input.selftest.token isn't valid.");
  let platformUrl = null;
  if (selftest.platformUrl !== undefined && selftest.platformUrl !== null) {
    const problem = targetUrlProblem(selftest.platformUrl, opts);
    if (problem) fail(`input.selftest.platformUrl ${problem}.`);
    platformUrl = selftest.platformUrl;
  }
  return { token: selftest.token, platformUrl };
}

function checkDevice(input) {
  const device = input.device;
  if (device === undefined || device === null) return {};
  if (!isObject(device)) fail("input.device isn't valid.");
  const out = {};
  for (const key of ["name", "runtime"]) {
    if (device[key] === undefined || device[key] === null) continue;
    if (typeof device[key] !== "string" || !DEVICE_NAME.test(device[key])) fail(`input.device.${key} isn't valid.`);
    out[key] = device[key];
  }
  return out;
}

function checkProduct(input) {
  const product = input.product;
  if (!isObject(product)) return { name: "", slug: null };
  return {
    name: typeof product.name === "string" ? product.name.slice(0, 80) : "",
    slug: typeof product.slug === "string" ? product.slug.slice(0, 80) : null,
  };
}

function checkMedia(input, opts) {
  const media = input.media;
  if (!isObject(media)) fail("input.media is required.");
  const out = { photo: checkDownload(media.photo, "input.media.photo", opts, { sha: false }) };
  for (const key of ["feed", "question"]) {
    if (media[key] !== undefined && media[key] !== null) {
      out[key] = checkDownload(media[key], `input.media.${key}`, opts, { sha: false });
    }
  }
  return out;
}

function checkInput(kind, input, opts) {
  if (!isObject(input)) fail("input is required.");
  if (input.v !== 1) fail("input.v must be 1.");
  const out = {
    v: 1,
    limitSeconds: bounded(input.limitSeconds, "input.limitSeconds", LIMITS.limitSeconds),
    target: checkTarget(input, opts),
    product: checkProduct(input),
    recordSeconds: bounded(input.recordSeconds, "input.recordSeconds", LIMITS.recordSeconds),
    shots: bounded(input.shots, "input.shots", LIMITS.shots),
    selftest: checkSelftest(input, opts),
    app: checkApp(kind, input, opts),
    device: checkDevice(input),
  };
  if (kind === "desktop_mac" || kind === "desktop_windows") {
    out.selftestSeconds = bounded(input.selftestSeconds, "input.selftestSeconds", LIMITS.selftestSeconds);
  }
  if (kind === "glasses_sim") {
    out.media = checkMedia(input, opts);
    const scenario = input.scenario ?? SCENARIOS[0];
    if (!SCENARIOS.includes(scenario)) fail(`input.scenario must be one of ${SCENARIOS.join(", ")}.`);
    out.scenario = scenario;
  }
  return out;
}

/**
 * Checks a claimed job for this lane. Returns `{ ok: true, job }` with the input's defaults filled in, or
 * `{ ok: false, error }` with a plain sentence.
 *
 * @param {unknown} job the `job` object from the claim response
 * @param {{ lane: string, platformOrigin?: string | null, allowInsecure?: boolean }} opts
 */
export function validateJob(job, opts) {
  try {
    if (!isObject(job)) fail("The job is missing.");
    if (typeof job.id !== "string" || !JOB_ID.test(job.id)) fail("job.id isn't valid.");
    if (!KINDS.includes(job.kind)) fail(`job.kind must be one of ${KINDS.join(", ")}.`);
    if (LANE_OF[job.kind] !== opts.lane) fail(`A ${job.kind} job can't run on the ${opts.lane} lab.`);
    if (typeof job.token !== "string" || !TOKEN.test(job.token)) fail("job.token isn't valid.");
    const urlOpts = { platformOrigin: opts.platformOrigin ?? null, allowInsecure: !!opts.allowInsecure };
    return {
      ok: true,
      job: {
        id: job.id,
        kind: job.kind,
        lane: opts.lane,
        token: job.token,
        attempt: Number.isInteger(job.attempt) ? job.attempt : 1,
        runId: typeof job.runId === "string" ? job.runId : null,
        input: checkInput(job.kind, job.input, urlOpts),
      },
    };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

/** The kinds the agent can take right now: enabled ones whose resource is free and with a slot open. */
export function claimableKinds(enabled, running, slots) {
  if (running.length >= slots) return [];
  const busy = new Set(running.map((kind) => RESOURCE_OF[kind]));
  return enabled.filter((kind) => !busy.has(RESOURCE_OF[kind]));
}
