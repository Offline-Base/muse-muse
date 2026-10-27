/**
 * Unit tests for lib/sandbox/policy.ts and the Muse Code env in lib/sandbox/muse.ts.
 *   npx tsx --test lib/sandbox/__tests__/policy.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetworkPolicyMatcher, NetworkPolicyRule } from "@vercel/sandbox";
import { museEnv, SANDBOX_ENV } from "@/lib/sandbox/muse";
import {
  BLOB_UPLOAD_HOSTS,
  BROKERED_META_ROUTES,
  builderNetworkPolicy,
  META_BLOCKED_BODY,
  placeholderKey,
} from "@/lib/sandbox/policy";

const KEY = "sk-meta-real-key-0123456789";
const PLACEHOLDER = placeholderKey(KEY, "product-bird-finder");

function metaRules(): NetworkPolicyRule[] {
  const policy = builderNetworkPolicy({ modelApiKey: KEY, placeholderKey: PLACEHOLDER, platformHost: "muse-muse.vercel.app", blobUploads: true });
  assert.ok(typeof policy === "object" && policy.allow && !Array.isArray(policy.allow));
  return policy.allow["api.meta.ai"];
}

function matches(m: NetworkPolicyMatcher | undefined, value: string): boolean {
  if (!m) return true;
  if ("exact" in m && m.exact !== undefined) return value === m.exact;
  if ("startsWith" in m && m.startsWith !== undefined) return value.startsWith(m.startsWith);
  if ("regex" in m && m.regex !== undefined) {
    const insensitive = m.regex.startsWith("(?i)");
    return new RegExp(insensitive ? m.regex.slice(4) : m.regex, insensitive ? "i" : "").test(value);
  }
  return true;
}

/**
 * The firewall's documented semantics: rules run in order, the first whose match fits wins, and a request no rule
 * claims is forwarded unchanged.
 */
type Req = { method: string; path: string; headers: Record<string, string> };
type Outcome = { blocked: number } | { headers: Record<string, string> };

function firewall(req: Req): Outcome {
  for (const rule of metaRules()) {
    const m = rule.match;
    if (m?.method && !m.method.includes(req.method)) continue;
    if (m?.path && !matches(m.path, req.path)) continue;
    const headerOk = (m?.headers ?? []).every((h) =>
      Object.entries(req.headers).some(([k, v]) => matches(h.key, k) && matches(h.value, v)),
    );
    if (!headerOk) continue;
    if (rule.response) return { blocked: rule.response.statusCode };
    if (rule.transform) return { headers: Object.assign({}, req.headers, ...rule.transform.map((t) => t.headers ?? {})) };
    return { headers: req.headers };
  }
  return { headers: req.headers };
}

const signed = (r: Outcome) => "headers" in r && Object.values(r.headers).some((v) => v.includes(KEY));

test("the real key is added only to Muse Code's routes with the sandbox's placeholder", () => {
  for (const route of BROKERED_META_ROUTES) {
    for (const method of route.methods) {
      for (const name of ["Authorization", "authorization"]) {
        const out = firewall({ method, path: route.path, headers: { [name]: `Bearer ${PLACEHOLDER}` } });
        assert.ok(signed(out), `${method} ${route.path} with ${name}`);
      }
    }
  }
  const muse = ["POST /v1/responses", "GET /muse-code/models", "POST /v1/files"];
  for (const call of muse) {
    const [method, p] = call.split(" ");
    assert.ok(signed(firewall({ method, path: p, headers: { Authorization: `Bearer ${PLACEHOLDER}` } })), call);
  }
});

test("every other api.meta.ai request is blocked and never signed", () => {
  const bearer = { Authorization: `Bearer ${PLACEHOLDER}` };
  const cases: Req[] = [
    { method: "GET", path: "/v1/files", headers: bearer },
    { method: "GET", path: "/v1/files/file-abc/content", headers: bearer },
    { method: "DELETE", path: "/v1/files/x", headers: bearer },
    { method: "POST", path: "/v1/files", headers: { Authorization: "Bearer brokered" } },
    { method: "POST", path: "/v1/images/generations", headers: bearer },
    { method: "POST", path: "/muse-code/telemetry/traces", headers: bearer },
    { method: "POST", path: "/muse-code/search", headers: bearer },
    { method: "POST", path: "/muse-code/browser_open", headers: bearer },
    { method: "DELETE", path: "/muse-code/models", headers: bearer },
    { method: "POST", path: "/v1/asr/transcribe", headers: bearer },
    { method: "GET", path: "/v1/responses/resp_123", headers: bearer },
    { method: "POST", path: "/v1/responses/resp_123/cancel", headers: bearer },
    { method: "DELETE", path: "/v1/responses", headers: bearer },
    { method: "POST", path: "/v1/responses", headers: { Authorization: "Bearer brokered" } },
    { method: "POST", path: "/v1/responses", headers: { Authorization: `Bearer ${placeholderKey(KEY, "product-other")}` } },
    { method: "POST", path: "/v1/responses", headers: {} },
    { method: "GET", path: "/v1/models", headers: { "x-api-key": PLACEHOLDER } },
  ];
  for (const req of cases) {
    const out = firewall(req);
    assert.equal(signed(out), false, `${req.method} ${req.path}`);
    assert.deepEqual(out, { blocked: 403 }, `${req.method} ${req.path}`);
  }
});

test("the rule list ends with a catch-all 403 and keeps the key out of matchers and bodies", () => {
  const rules = metaRules();
  const last = rules[rules.length - 1];
  assert.equal(last.match, undefined);
  assert.deepEqual(last.response, { statusCode: 403, body: META_BLOCKED_BODY, contentType: "text/plain" });
  for (const rule of rules.slice(0, -1)) {
    assert.ok(rule.match?.method?.length && rule.match.path && rule.match.headers?.length, "every signing rule has a full match");
    assert.ok(!JSON.stringify(rule.match).includes(KEY));
  }
});

test("other hosts keep their plain allow rules", () => {
  const policy = builderNetworkPolicy({ modelApiKey: KEY, placeholderKey: PLACEHOLDER, platformHost: "muse-muse.vercel.app", blobUploads: true });
  assert.ok(typeof policy === "object" && policy.allow && !Array.isArray(policy.allow));
  assert.deepEqual(policy.allow["registry.npmjs.org"], []);
  assert.deepEqual(policy.allow["muse-muse.vercel.app"], []);
  for (const host of BLOB_UPLOAD_HOSTS) assert.deepEqual(policy.allow[host], []);
  const bare = builderNetworkPolicy({ modelApiKey: KEY, placeholderKey: PLACEHOLDER, platformHost: null });
  assert.ok(typeof bare === "object" && bare.allow && !Array.isArray(bare.allow));
  assert.deepEqual(Object.keys(bare.allow).sort(), ["api.meta.ai", "registry.npmjs.org"]);
});

test("placeholders are stable per sandbox, differ between sandboxes and reveal nothing about the key", () => {
  assert.equal(placeholderKey(KEY, "product-bird-finder"), PLACEHOLDER);
  assert.notEqual(placeholderKey(KEY, "product-other"), PLACEHOLDER);
  assert.notEqual(placeholderKey("another-key", "product-bird-finder"), PLACEHOLDER);
  assert.match(PLACEHOLDER, /^mm_sandbox_[0-9a-f]{40}$/);
  assert.ok(!PLACEHOLDER.includes(KEY.slice(0, 8)));
});

test("only the Muse Code env carries the placeholder", () => {
  assert.equal("META_API_KEY" in SANDBOX_ENV, false);
  assert.deepEqual(museEnv(PLACEHOLDER), { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0", META_API_KEY: PLACEHOLDER });
});
