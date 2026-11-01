/**
 * Unit tests for lib/sandbox/policy.ts and the Muse Code env in lib/sandbox/muse.ts.
 *   npx tsx --test lib/sandbox/__tests__/policy.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetworkPolicyKeyValueMatcher, NetworkPolicyMatcher, NetworkPolicyRule } from "@vercel/sandbox";
import { museEnv, SANDBOX_ENV } from "@/lib/sandbox/muse";
import {
  BLOB_UPLOAD_HOSTS,
  BROKERED_META_ROUTES,
  builderNetworkPolicy,
  BYPASS_COOKIE_BLOCKED_BODY,
  META_BLOCKED_BODY,
  placeholderKey,
  type PlatformBypass,
  PROTECTION_BYPASS_HEADER,
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
 * claims is forwarded unchanged. A transform sets its headers over the client's, whatever case the client used.
 */
type Req = { method: string; path: string; headers: Record<string, string>; query?: Record<string, string> };
type Outcome = { blocked: number } | { headers: Record<string, string> };

function entriesMatch(matchers: NetworkPolicyKeyValueMatcher[] | undefined, entries: Record<string, string>): boolean {
  return (matchers ?? []).every((h) => Object.entries(entries).some(([k, v]) => matches(h.key, k) && matches(h.value, v)));
}

function transformed(headers: Record<string, string>, set: Record<string, string>): Record<string, string> {
  const names = new Set(Object.keys(set).map((k) => k.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(headers).filter(([k]) => !names.has(k.toLowerCase()))), ...set };
}

function firewall(req: Req, rules: NetworkPolicyRule[] = metaRules()): Outcome {
  for (const rule of rules) {
    const m = rule.match;
    if (m?.method && !m.method.includes(req.method)) continue;
    if (m?.path && !matches(m.path, req.path)) continue;
    if (!entriesMatch(m?.headers, req.headers) || !entriesMatch(m?.queryString, req.query ?? {})) continue;
    if (rule.response) return { blocked: rule.response.statusCode };
    if (rule.transform) return { headers: rule.transform.reduce((h, t) => transformed(h, t.headers ?? {}), req.headers) };
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

const PREVIEW_HOST = "muse-muse-git-tg-preview-db-team.vercel.app";
const BYPASS = "bypass-secret-value-for-tests";

function platformRules(platformHost = PREVIEW_HOST, platformBypass: PlatformBypass | null = { host: PREVIEW_HOST, secret: BYPASS }): NetworkPolicyRule[] {
  const policy = builderNetworkPolicy({ modelApiKey: KEY, placeholderKey: PLACEHOLDER, platformHost, blobUploads: true, platformBypass });
  assert.ok(typeof policy === "object" && policy.allow && !Array.isArray(policy.allow));
  assert.ok(platformHost === PREVIEW_HOST || !JSON.stringify(policy).includes(BYPASS), "the secret goes to its own host or nowhere");
  return policy.allow[platformHost];
}

const bypassed = (r: Outcome) => "headers" in r && Object.values(r.headers).some((v) => v.includes(BYPASS));
const hostOf = (r: Outcome) => ("headers" in r ? Object.entries(r.headers).filter(([k]) => k.toLowerCase() === "host").map(([, v]) => v) : []);

test("on a preview, requests to the platform carry the protection bypass header, added by the firewall", () => {
  const gateway = { method: "POST", path: "/api/gateway/v1/responses", headers: { Host: PREVIEW_HOST, Authorization: "Bearer mm_build_x" } };
  const out = firewall(gateway, platformRules());
  assert.ok("headers" in out);
  assert.equal(out.headers[PROTECTION_BYPASS_HEADER], BYPASS);
  assert.equal(out.headers.Authorization, "Bearer mm_build_x", "the build token goes through as sent");
  assert.deepEqual(hostOf(out), [PREVIEW_HOST]);
  const query = firewall({ method: "GET", path: "/api/build-mcp", headers: {}, query: { model: "muse-spark-1.3-contributor", q: "a%20b" } }, platformRules());
  assert.ok(bypassed(query), "ordinary query strings, encoded values included, still get through");
});

test("the bypass rule pins Host to the platform, so domain fronting can't carry the secret to another site", () => {
  const fronted: Record<string, string>[] = [{ Host: "attacker-project.vercel.app" }, { host: "attacker-project.vercel.app" }, { HOST: "evil.example" }, {}];
  for (const headers of fronted) {
    const out = firewall({ method: "GET", path: "/", headers }, platformRules());
    assert.ok(bypassed(out), JSON.stringify(headers));
    assert.deepEqual(hostOf(out), [PREVIEW_HOST], JSON.stringify(headers));
  }
  // Whatever rule adds the secret also sets Host to the platform's host.
  for (const rule of platformRules()) {
    for (const t of rule.transform ?? []) {
      if (t.headers?.[PROTECTION_BYPASS_HEADER] !== undefined) assert.equal(t.headers.Host, PREVIEW_HOST);
    }
  }
});

test("a sandbox can't ask the platform for a bypass cookie, as a header or a query parameter, in any spelling", () => {
  const asks: Req[] = [
    { method: "GET", path: "/", headers: { "x-vercel-set-bypass-cookie": "true" } },
    { method: "GET", path: "/", headers: { "X-Vercel-Set-Bypass-Cookie": "samesitenone" } },
    { method: "POST", path: "/api/gateway/v1/responses", headers: { "X-VERCEL-SET-BYPASS-COOKIE": "" } },
    { method: "GET", path: "/", headers: {}, query: { "x-vercel-set-bypass-cookie": "true" } },
    { method: "GET", path: "/", headers: {}, query: { "X-Vercel-Set-Bypass-Cookie": "samesitenone" } },
    { method: "GET", path: "/", headers: {}, query: { "x-vercel-set-bypass%2Dcookie": "true" } },
    { method: "GET", path: "/", headers: {}, query: { "%78-vercel-set-bypass-cookie": "true" } },
    { method: "GET", path: "/", headers: {}, query: { model: "x", "x-vercel-set-bypass-cookie": "1" } },
  ];
  for (const req of asks) {
    const out = firewall(req, platformRules());
    assert.deepEqual(out, { blocked: 403 }, JSON.stringify(req));
    assert.equal(bypassed(out), false);
  }
  // The refusals come first and the secret's rule is last with no match, so nothing skips the refusals or the pin.
  const rules = platformRules();
  assert.equal(rules.length, 3);
  for (const rule of rules.slice(0, -1)) {
    assert.ok(rule.match && rule.response, "a refusal");
    assert.deepEqual(rule.response, { statusCode: 403, body: BYPASS_COOKIE_BLOCKED_BODY, contentType: "text/plain" });
  }
  const last = rules[rules.length - 1];
  assert.equal(last.match, undefined);
  assert.ok(last.transform);
  for (const rule of rules.slice(0, -1)) assert.ok(!JSON.stringify(rule).includes(BYPASS), "the secret is in no matcher or body");
});

test("without a bypass secret the platform host is allowed exactly as before", () => {
  for (const platformBypass of [undefined, null, { host: "muse-muse.vercel.app", secret: "" }]) {
    const policy = builderNetworkPolicy({ modelApiKey: "k", placeholderKey: "p", platformHost: "muse-muse.vercel.app", platformBypass });
    assert.deepEqual((policy as { allow: Record<string, unknown[]> }).allow["muse-muse.vercel.app"], []);
  }
});

test("the secret goes only to the host it is for, never to another platformHost", () => {
  // Production's host on a preview without its own database, or a caller's --site in Prove it's copy.
  for (const other of ["muse-muse.vercel.app", "some-other-site.example", `${PREVIEW_HOST}.evil.example`, `x.${PREVIEW_HOST}`]) {
    assert.deepEqual(platformRules(other, { host: PREVIEW_HOST, secret: BYPASS }), [], other);
    assert.equal(bypassed(firewall({ method: "GET", path: "/", headers: {} }, platformRules(other))), false, other);
  }
  assert.equal(platformRules(PREVIEW_HOST, { host: PREVIEW_HOST.toUpperCase(), secret: BYPASS }).length, 3, "hosts compare in any case");
});
