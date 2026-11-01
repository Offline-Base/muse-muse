// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   fireJob(request, "digest", input)      the platform's test token, then this product's own job route. Call it again and
//                                          the run goes on from its checkpoint, if it left one. Records "job-fired"
//   fireWebhook(request, "log", payload)   posts the payload to a test webhook address, then runs the job that queued.
//                                          Records "webhook-run"
//   checkResultShown(page, text)           the result shows on the screen already open. Takes the judge screenshot
//                                          "12-job-result" and records "result-shown"
//
// Nothing runs on a clock in a build. Rows go to the build's test space, and notices and held sends reach no one. The demo
// recordings replay this test on what the smoke run saved, so fireJob and fireWebhook fire nothing there.
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

const CAP = "jobs";
const JOB_HEADER = "x-musemuse-job";

function gatewaySettings(): { base: string; token: string } {
  let base = process.env.GATEWAY_URL;
  let token = process.env.PRODUCT_TOKEN;
  if (!base || !token) {
    try {
      for (const line of readFileSync(".env.local", "utf8").split("\n")) {
        const [k, ...v] = line.split("=");
        if (k === "GATEWAY_URL" && !base) base = v.join("=").trim();
        if (k === "PRODUCT_TOKEN" && !token) token = v.join("=").trim();
      }
    } catch {
      // No .env.local: the error below says what's missing.
    }
  }
  if (!base || !token) throw new Error("fireJob needs GATEWAY_URL and PRODUCT_TOKEN, which the platform writes into .env.local for a build.");
  return { base: base.replace(/\/+$/, ""), token };
}

async function testFire<T>(body: Record<string, unknown>): Promise<T> {
  const { base, token } = gatewaySettings();
  const res = await fetch(`${base}/jobs/test-fire`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const reply = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`The gateway's test-fire failed: ${reply.error?.message ?? `HTTP ${res.status}`}`);
  return reply;
}

async function checked(id: string, okDetail: string, shot: string | undefined, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    recordCapCheck(CAP, { id, ok: true, detail: okDetail, ...(shot ? { shot: `${shot}.png` } : {}) });
  } catch (err) {
    recordCapCheck(CAP, { id, ok: false, detail: `${okDetail}: no. ${String((err as Error)?.message ?? err).split("\n")[0]}`.slice(0, 280) });
    throw err;
  }
}

export interface FiredJob {
  ok: boolean;
  /** "done" when the run finished, "queued" when it left a checkpoint for the next fire. */
  status: string;
  tick: number;
}

async function callRoute(request: APIRequestContext, name: string, token: string): Promise<FiredJob> {
  const res = await request.post(`/api/jobs/${name}`, { headers: { [JOB_HEADER]: token, "content-type": "application/json" }, data: {}, timeout: 120_000 });
  const reply = (await res.json().catch(() => ({}))) as Partial<FiredJob> & { error?: string };
  if (!res.ok()) throw new Error(`/api/jobs/${name} answered ${res.status()}: ${reply.error ?? "no message"}`);
  return { ok: true, status: String(reply.status ?? ""), tick: Number(reply.tick ?? 0) };
}

/** True in the demo recordings: a replay, whose jobs the smoke run already ran. */
function inDemo(): boolean {
  try {
    return ["demo", "studio"].includes(test.info().project.name);
  } catch {
    return false;
  }
}

const REPLAYED: FiredJob = { ok: true, status: "done", tick: 0 };

/** Runs one tick of a job: the platform's token, then this product's own route, as the cron does. */
export async function fireJob(request: APIRequestContext, name: string, input?: unknown): Promise<FiredJob> {
  if (inDemo()) return REPLAYED;
  let fired: FiredJob | undefined;
  await checked("job-fired", `The job ${name} ran`, undefined, async () => {
    const { token } = await testFire<{ token: string }>({ name, ...(input === undefined ? {} : { input }) });
    fired = await callRoute(request, name, token);
  });
  return fired!;
}

/** Posts a sample payload to a test webhook address, then runs the job it queued. */
export async function fireWebhook(request: APIRequestContext, name: string, payload: unknown): Promise<FiredJob> {
  if (inDemo()) return REPLAYED;
  let fired: FiredJob | undefined;
  await checked("webhook-run", `A sample payload started the job ${name}`, undefined, async () => {
    const { hook } = await testFire<{ hook: { url: string } }>({ name, hook: true });
    const res = await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (res.status !== 202) throw new Error(`the webhook answered ${res.status}`);
    const { token } = await testFire<{ token: string }>({ name });
    fired = await callRoute(request, name, token);
  });
  return fired!;
}

/** The platform's check that a job's result shows on the screen already open. */
export async function checkResultShown(page: Page, text: string): Promise<void> {
  await checked("result-shown", "A job's result shows on a screen", "12-job-result", async () => {
    if (String(text).trim().length < 2) throw new Error("give checkResultShown the text to look for");
    await expect(page.getByText(text.trim().slice(0, 120), { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await judgeShot(page, "12-job-result");
  });
}
