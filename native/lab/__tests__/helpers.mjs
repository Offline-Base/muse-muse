// Shared test helpers: a valid job for each kind, and a logger that keeps its lines.
export const TOKEN = "job-token-abcdefghijklmnop";
export const SELFTEST_TOKEN = "selftest-token-abcdefghijkl";
export const SHA = "a".repeat(64);
export const BLOB = "https://abc123.public.blob.vercel-storage.com";

const APPS = {
  ios_sim: { kind: "ios_sim_app", variant: "lab", version: "1.0.0", url: `${BLOB}/ios.tgz`, sha256: SHA, bundleId: "ai.musemuse.lab" },
  glasses_sim: { kind: "ios_sim_app", variant: "glasses", version: "1.0.0", url: `${BLOB}/glasses.tgz`, sha256: SHA, bundleId: "app.musemuse.glasses" },
  android_emu: { kind: "apk", variant: "lab", version: "1.0.0", url: `${BLOB}/lab.apk`, sha256: SHA, packageName: "ai.musemuse.lab" },
  desktop_mac: { kind: "mac_zip", variant: "product", version: "1.0.0", url: `${BLOB}/mac.zip`, sha256: SHA },
  desktop_windows: { kind: "windows_zip", variant: "product", version: "1.0.0", url: `${BLOB}/win.zip`, sha256: SHA },
};

export function makeJob(kind, overrides = {}) {
  const { input = {}, ...rest } = overrides;
  return {
    id: "job_1",
    kind,
    token: TOKEN,
    attempt: 1,
    runId: "run_1",
    input: {
      v: 1,
      limitSeconds: 300,
      target: { url: "https://demo-product.vercel.app/" },
      product: { name: "Demo", slug: "demo" },
      recordSeconds: 10,
      shots: 2,
      selftest: { token: SELFTEST_TOKEN, platformUrl: "https://muse-muse.vercel.app" },
      app: APPS[kind],
      ...(kind === "glasses_sim" ? { media: { photo: { url: `${BLOB}/pov.jpg` } } } : {}),
      ...input,
    },
    ...rest,
  };
}

export function memoryLogger() {
  const lines = [];
  const secrets = new Set();
  const redact = (text) => {
    let out = String(text);
    for (const secret of secrets) if (secret) out = out.split(secret).join("[hidden]");
    return out;
  };
  const push = (level) => (message, fields = {}) => lines.push(redact(JSON.stringify({ level, message, ...fields })));
  return {
    lines,
    addSecret: (s) => s && secrets.add(s),
    removeSecret: (s) => secrets.delete(s),
    redact,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}
