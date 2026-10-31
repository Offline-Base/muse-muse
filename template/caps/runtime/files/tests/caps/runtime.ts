// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
// expectPythonAction calls one of the product's actions through its route and checks that a Python function ran for it:
// the build's server notes every Python call in test-results/caps/runtime-calls.jsonl (lib/platform/python.ts). It
// records the check for verify's caps step, which then runs that function again on the same input.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import { recordCapCheck } from "./index";

const CALL_LOG = path.join(process.cwd(), "test-results", "caps", "runtime-calls.jsonl");

/** The Python calls the build's server has noted so far in this run. */
export function pythonCalls(): Array<{ name: string; input: unknown; output: unknown }> {
  if (!existsSync(CALL_LOG)) return [];
  return readFileSync(CALL_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { name: string; input: unknown; output: unknown }];
      } catch {
        return [];
      }
    });
}

/**
 * POSTs `input` to /api/actions/<action> and expects a JSON reply that came through a Python function. Returns the
 * reply. Assert its shape in the test, never exact numbers a model or a library version could change.
 */
export async function expectPythonAction<T = unknown>(request: APIRequestContext, action: string, input: unknown): Promise<T> {
  const before = pythonCalls().length;
  const res = await request.post(`/api/actions/${action}`, { data: input as Record<string, unknown> });
  const status = res.status();
  const reply = (await res.json().catch(() => undefined)) as T | undefined;
  const calls = pythonCalls().slice(before);
  const ok = res.ok() && reply !== undefined && calls.length > 0;
  recordCapCheck("runtime", {
    id: "python-action",
    ok,
    detail: ok
      ? `${action} answered through the Python function ${calls[0]!.name}`
      : !res.ok()
        ? `${action} answered HTTP ${status}`
        : reply === undefined
          ? `${action} didn't answer with JSON`
          : `${action} answered, but no Python function ran for it`,
  });
  expect(res.ok(), `${action} answered HTTP ${status}`).toBeTruthy();
  expect(reply, `${action} didn't answer with JSON`).not.toBeUndefined();
  expect(calls.length, `${action} answered, but no Python function ran for it`).toBeGreaterThan(0);
  return reply as T;
}
