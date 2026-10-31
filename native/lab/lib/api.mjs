// The platform's lab API (docs/NATIVE_LAB.md, "HTTP contract"). The lab token goes only to claim, and each job's own
// token to that job's heartbeat, upload and finish.
import { sleep } from "./proc.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const FINISH_ATTEMPTS = 6;

export class ApiError extends Error {
  constructor(message, { status = 0, retryAfterMs = null, code = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

function retryAfterMs(res) {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function bodyOf(res) {
  return res.json().catch(() => ({}));
}

/**
 * @param {object} opts
 * @param {string} opts.platform the platform's origin
 * @param {() => Promise<string>} opts.getLabToken
 * @param {() => Promise<string>} [opts.refreshLabToken] reads the token again, after a 401
 * @param {typeof fetch} [opts.fetch]
 */
export function createApi({ platform, getLabToken, refreshLabToken, fetch: doFetch = fetch }) {
  const base = platform.replace(/\/+$/, "");

  const post = (path, token, body, timeoutMs = REQUEST_TIMEOUT_MS, stop = null) =>
    doFetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs),
    });

  const jobPath = (jobId, action) => `/api/native/agent/jobs/${encodeURIComponent(jobId)}/${action}`;

  return {
    /** The next job, or null when there's nothing to do. Throws ApiError for anything worth backing off from. */
    async claim(body, { signal: stop = null } = {}) {
      const limit = REQUEST_TIMEOUT_MS + (body.waitSeconds ?? 0) * 1000;
      let res = await post("/api/native/agent/claim", await getLabToken(), body, limit, stop);
      if (res.status === 401 && refreshLabToken) {
        res = await post("/api/native/agent/claim", await refreshLabToken(), body, limit, stop);
      }
      if (res.status === 204) return null;
      // The site answers a route it doesn't have with a 200 page, and that mustn't read as "no work".
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && !type.includes("json")) throw new ApiError("claim answered with a page, not JSON", { status: res.status, code: "not_json" });
      const reply = await bodyOf(res);
      if (res.ok) return reply.job ?? null;
      throw new ApiError(`claim answered ${res.status}`, { status: res.status, retryAfterMs: retryAfterMs(res), code: reply.error ?? null });
    },

    /** `{ cancel }`. A job the platform no longer knows counts as canceled. Network trouble doesn't: it just tries again. */
    async heartbeat(jobId, token, body) {
      const res = await post(jobPath(jobId, "heartbeat"), token, body);
      if (res.status === 404 || res.status === 410 || res.status === 401) return { cancel: true };
      const reply = await bodyOf(res);
      if (!res.ok) throw new ApiError(`heartbeat answered ${res.status}`, { status: res.status });
      return { cancel: reply.cancel === true };
    },

    /** The upload slots for these files. */
    async requestUploads(jobId, token, files) {
      const res = await post(jobPath(jobId, "upload"), token, { files });
      const reply = await bodyOf(res);
      if (!res.ok) throw new ApiError(`upload answered ${res.status}`, { status: res.status, code: reply.error ?? null });
      return Array.isArray(reply.uploads) ? reply.uploads : [];
    },

    /**
     * The health report the shell posted to the platform, or null. It's the lab's backup for a shell whose log line
     * didn't reach it. Trouble here only means the report isn't available.
     */
    async fetchSelftest(jobId, token) {
      const res = await post(jobPath(jobId, "selftest"), token, {});
      if (!res.ok) return null;
      const reply = await bodyOf(res);
      return reply.report && typeof reply.report === "object" ? reply.report : null;
    },

    /**
     * Reports the result, with retries, since losing it wastes the check. True when the platform has it, false when it
     * no longer wants it (a 401, 404, 409 or 410: the job expired or already finished).
     */
    async finish(jobId, token, body, { wait = sleep, attempts = FINISH_ATTEMPTS } = {}) {
      let last = null;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const res = await post(jobPath(jobId, "finish"), token, body);
          if (res.ok) return true;
          if ([401, 404, 409, 410].includes(res.status)) return false;
          last = new ApiError(`finish answered ${res.status}`, { status: res.status });
        } catch (err) {
          last = err;
        }
        await wait(1000 * 2 ** attempt);
      }
      throw last ?? new ApiError("finish failed");
    },
  };
}
