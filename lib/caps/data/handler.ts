import { cleanDisplayName, isSignInBind, mintTestUserSession, mintUserSession, readUserCode, testUserSubject } from "@/lib/caps/data/identity";
import { DATA_LIMITS, type DataQuotas } from "@/lib/caps/data/limits";
import { isCursor, newDocId, type DataStore, type QueryOrder, type RowKey, type WriteLimits, type WriteRefusal } from "@/lib/caps/data/store";
import { COLLECTION_NAME, DOC_ID, FIELD_NAME, isDataScope, type DataCollectionRule, type DataScope } from "@/lib/caps/data/types";
import {
  capError,
  dayWindow,
  readJsonBody,
  runCapGate,
  unknownEndpoint,
  unknownKeys,
  type CapContext,
  type CapGateDeps,
  type CapLimit,
  type CapProduct,
  type CapRoute,
  type CapStage,
  type CapToken,
} from "@/lib/caps/gate";
import { subjectKey, type CapCaller } from "@/lib/caps/principal";
import { safeReturnPath } from "@/lib/tools/principal";
import { sameMac } from "@/lib/tools/sign";

/**
 * {GATEWAY_URL}/data and {GATEWAY_URL}/identity/user (docs/CAPABILITIES.md, section 9), behind the cap gate
 * (lib/caps/gate.ts). Rows live in the product's `live` namespace for a live token and in b:<buildId> for a build's,
 * so a build never sees what a real person saved. The routes stay thin wrappers.
 */

export interface DataDeps extends CapGateDeps {
  store: DataStore;
  /** DATA_PRODUCT_ROWS, DATA_PRODUCT_MB and DATA_DAILY_WRITES, for the live namespace. */
  quotas(): DataQuotas;
  /** DATA_SIGN_IN. */
  signInOn(): boolean;
  /**
   * The product's collections: a build's from its brief (the build's own row), a live product's from the brief it
   * shipped with, narrowed by its manifest's `data` block. Null when there is no list: a build may then use any
   * collection, shared ones written by the owner; a live token is refused.
   */
  rules(token: CapToken, product: CapProduct): Promise<DataCollectionRule[] | null>;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  /** Public {PLATFORM_URL}, for the sign-in link. */
  platformUrl: string;
  productSlug(productId: string): Promise<string | null>;
}

const isBuild = (token: CapToken) => token.scope === "build";

function baseLimits(stage: CapStage, prefix: string): CapLimit[] {
  const limits: CapLimit[] = [{ key: `${prefix}:token:${stage.token.id}`, limit: DATA_LIMITS.perTokenPerMinute, window: "minute", who: "this product" }];
  if (stage.caller.ip) limits.push({ key: `${prefix}:ip:${stage.token.productId}:${stage.caller.ip}`, limit: DATA_LIMITS.perIpPerMinute, window: "minute", who: "this user" });
  return limits;
}

/** The subject an owner row is keyed by: the product's one owner, not the holder of the pass. */
const OWNER_SPACE = "product-owner";

/** The subject key a scope's rows of this caller are under, or why there is none. Shared rows have no key. */
function ownerKeyFor(scope: DataScope, caller: CapCaller, productId: string): { key: string | null } | Response {
  switch (scope) {
    case "shared":
      return { key: null };
    case "visitor":
      return caller.visitor ? { key: subjectKey("visitor", productId, caller.visitor) } : capError("sign_in_required", "This browser has no visitor id yet. Reload the page and try again.");
    case "owner":
      // One owner space per product, whoever holds the pass: the owner, or an admin acting as the owner, sees the same
      // items. A build's are in its own namespace anyway.
      return caller.owner ? { key: subjectKey("owner", productId, OWNER_SPACE) } : capError("sign_in_required", "Only the product's owner can use these items. Open it as the owner from Muse Muse.");
    case "user":
      return caller.user ? { key: subjectKey("user", productId, caller.user) } : capError("sign_in_required", "Sign in to use these items.");
  }
}

/** Who may change a shared collection, and whether this caller is one of them. */
function sharedWriteRefusal(rule: DataCollectionRule | null, caller: CapCaller): Response | null {
  const writes = rule?.writes ?? "owner";
  if (caller.owner) return null;
  if (writes === "anyone" && (caller.visitor || caller.user)) return null;
  if (writes === "signed_in" && caller.user) return null;
  if (writes === "signed_in") return capError("sign_in_required", "Sign in to add to this.");
  if (writes === "anyone") return capError("sign_in_required", "This browser has no visitor id yet. Reload the page and try again.");
  return capError("sign_in_required", "Only the product's owner can change these items.");
}

const QUOTA_WORDS: Record<Exclude<WriteRefusal, "version_conflict">, (q: WriteLimits) => string> = {
  rows: (q) => `This product has saved as many items as it can (${q.rows.toLocaleString("en-US")}). Delete some to save more.`,
  bytes: (q) => `This product has saved as much as it can (${Math.round(q.bytes / 1024 / 1024)} MB). Delete some items to save more.`,
  collections: (q) => `This product already uses ${q.collections} collections, the most it can.`,
  subject: (q) => `You've saved as many items here as one person can (${(q.subjectRows ?? 0).toLocaleString("en-US")}). Delete some to save more.`,
};

function writeLimits(stage: CapStage, scope: DataScope, quotas: DataQuotas): WriteLimits {
  const subjectRows = scope === "visitor" ? DATA_LIMITS.rowsPerVisitor : scope === "user" ? DATA_LIMITS.rowsPerUser : null;
  return isBuild(stage.token)
    ? { rows: DATA_LIMITS.buildRows, bytes: DATA_LIMITS.buildBytes, collections: DATA_LIMITS.collectionsPerProduct, subjectRows }
    : { rows: quotas.productRows, bytes: quotas.productBytes, collections: DATA_LIMITS.collectionsPerProduct, subjectRows };
}

function refusalFor(reason: WriteRefusal, limits: WriteLimits): Response {
  if (reason === "version_conflict") {
    return Response.json(
      { error: { type: "invalid_request_error", code: "version_conflict", message: "Someone changed this item since you opened it. Reload it and try again.", param: null } },
      { status: 409, headers: { "x-should-retry": "false" } },
    );
  }
  return capError("quota_exceeded", QUOTA_WORDS[reason](limits));
}

interface Target {
  collection: string;
  scope: DataScope;
  rule: DataCollectionRule | null;
  ownerKey: string | null;
}

/** The collection and scope a call names (live tickets ask here too, section 13), checked against the product's list, and the caller's key in that scope. */
export async function target(stage: CapStage, deps: Pick<DataDeps, "rules">, collection: string, scopeParam: unknown): Promise<Target | Response> {
  if (!COLLECTION_NAME.test(collection)) return capError("invalid_arguments", "A collection's name is lowercase letters, digits and underscores, up to 32, starting with a letter.");
  if (scopeParam !== undefined && scopeParam !== null && !isDataScope(scopeParam)) return capError("invalid_arguments", "scope is shared, visitor, owner or user.");
  const rules = await deps.rules(stage.token, stage.product);
  // A live product saves only what its brief listed: with no list there is nothing it may use.
  if (!rules && !isBuild(stage.token)) return capError("cap_not_allowed", "This product doesn't list any collections to save to.");
  const rule = rules?.find((r) => r.name === collection) ?? null;
  if (rules && !rule) return capError("cap_not_allowed", `This product doesn't list a collection named ${collection}.`);
  const scope = (scopeParam ?? rule?.scope ?? null) as DataScope | null;
  if (!scope) return capError("invalid_arguments", "Say which scope: shared, visitor, owner or user.");
  if (rule && rule.scope !== scope) return capError("cap_not_allowed", `${collection} is a ${rule.scope} collection.`);
  const key = ownerKeyFor(scope, stage.caller, stage.token.productId);
  if (key instanceof Response) return key;
  return { collection, scope, rule, ownerKey: key.key };
}

function docBytes(data: unknown): number | Response {
  if (!data || typeof data !== "object" || Array.isArray(data)) return capError("invalid_arguments", "An item is a JSON object.");
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  return bytes > DATA_LIMITS.docMaxBytes ? capError("invalid_arguments", `An item can be at most ${DATA_LIMITS.docMaxBytes / 1024} KB.`) : bytes;
}

const rowKey = (ctx: CapContext<{ target: Target }>, docId: string): RowKey => ({
  productId: ctx.token.productId,
  namespace: ctx.namespace,
  collection: ctx.args.target.collection,
  scope: ctx.args.target.scope,
  ownerKey: ctx.args.target.ownerKey,
  docId,
});

/** The limits of a write: every call's, the live product's daily writes, and a shared collection anyone writes. */
function writeLimitsFor(stage: CapStage, t: Target, deps: DataDeps): CapLimit[] {
  const limits = baseLimits(stage, "data");
  if (!isBuild(stage.token)) limits.push({ key: `data:writes:${stage.token.productId}`, limit: deps.quotas().dailyWrites, window: "day", who: "this product's saves" });
  const anyone = t.scope === "shared" && (t.rule?.writes ?? "owner") === "anyone" && !stage.caller.owner;
  if (anyone) {
    if (stage.caller.ip) limits.push({ key: `data:anyone-ip:${stage.token.productId}:${stage.caller.ip}`, limit: DATA_LIMITS.anyoneWritesPerIpPerMinute, window: "minute", who: "this user" });
    const who = stage.caller.visitor ? subjectKey("visitor", stage.token.productId, stage.caller.visitor) : stage.caller.user ? subjectKey("user", stage.token.productId, stage.caller.user) : null;
    if (who) limits.push({ key: `data:anyone-visitor:${stage.token.productId}:${who}`, limit: DATA_LIMITS.anyoneWritesPerVisitorPerDay, window: "day", who: "your saves here" });
  }
  return limits;
}

const docAnswer = (doc: { id: string; version: number; createdAt: string; updatedAt: string; data?: unknown }, status = 200) =>
  Response.json(doc, { status, headers: { "cache-control": "no-store" } });

/** Serves everything under {GATEWAY_URL}/data. With DATA_ENABLED off, or CAP_READY false, every path answers 404. */
export async function handleData(req: Request, path: readonly string[], deps: DataDeps): Promise<Response> {
  const route = `${req.method} ${path.length}`;
  const [first, second] = path;
  const what = "/data";
  if (route === "GET 0") return runCapGate(req, deps, collectionsRoute(deps));
  if (route === "DELETE 1" && first === "_mine") return runCapGate(req, deps, deleteMineRoute(deps));
  if (route === "POST 1" && first) return runCapGate(req, deps, createRoute(deps, first));
  if (route === "POST 2" && first && second === "query") return runCapGate(req, deps, queryRoute(deps, first));
  if (path.length === 2 && first && second && ["GET", "PUT", "DELETE"].includes(req.method)) return runCapGate(req, deps, docRoute(deps, first, second, req.method as "GET" | "PUT" | "DELETE"));
  // Anything else is a 404 with the flag off or on, and touches nothing.
  return unknownEndpoint(what);
}

function createRoute(deps: DataDeps, collection: string): CapRoute<{ target: Target; data: unknown; bytes: number }> {
  return {
    cap: "data",
    what: "/data",
    async args(stage) {
      const body = await readJsonBody(stage.req, DATA_LIMITS.bodyMaxBytes);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["data"]);
      if (extra) return extra;
      const t = await target(stage, deps, collection, new URL(stage.req.url).searchParams.get("scope") ?? undefined);
      if (t instanceof Response) return t;
      if (t.scope === "shared") {
        const refused = sharedWriteRefusal(t.rule, stage.caller);
        if (refused) return refused;
      }
      const bytes = docBytes(body.data);
      if (bytes instanceof Response) return bytes;
      return { target: t, data: body.data, bytes };
    },
    limits: (stage) => writeLimitsFor(stage, stage.args.target, deps),
    async work(ctx) {
      const limits = writeLimits(ctx, ctx.args.target.scope, deps.quotas());
      const result = await deps.store.create(rowKey(ctx, newDocId()), ctx.args.data, ctx.args.bytes, limits);
      if (!result.ok) return refusalFor(result.reason, limits);
      const { data: _data, ...doc } = result.doc;
      return docAnswer(doc, 201);
    },
  };
}

function docRoute(deps: DataDeps, collection: string, docId: string, method: "GET" | "PUT" | "DELETE"): CapRoute<{ target: Target; data?: unknown; bytes?: number; ifVersion: number | null }> {
  return {
    cap: "data",
    what: "/data",
    async args(stage) {
      if (!DOC_ID.test(docId)) return capError("invalid_arguments", "An item's id is up to 64 letters, digits, dashes and underscores.");
      let body: Record<string, unknown> = {};
      if (method === "PUT") {
        const read = await readJsonBody(stage.req, DATA_LIMITS.bodyMaxBytes);
        if (read instanceof Response) return read;
        const extra = unknownKeys(read, ["data", "ifVersion"]);
        if (extra) return extra;
        body = read;
      }
      const t = await target(stage, deps, collection, new URL(stage.req.url).searchParams.get("scope") ?? undefined);
      if (t instanceof Response) return t;
      if (method !== "GET" && t.scope === "shared") {
        const refused = sharedWriteRefusal(t.rule, stage.caller);
        if (refused) return refused;
      }
      if (method !== "PUT") return { target: t, ifVersion: null };
      const ifVersion = body.ifVersion === undefined || body.ifVersion === null ? null : body.ifVersion;
      if (ifVersion !== null && !(Number.isInteger(ifVersion) && (ifVersion as number) > 0)) return capError("invalid_arguments", "ifVersion is the version you read, a whole number.");
      const bytes = docBytes(body.data);
      if (bytes instanceof Response) return bytes;
      return { target: t, data: body.data, bytes, ifVersion: ifVersion as number | null };
    },
    limits: (stage) => (method === "GET" ? baseLimits(stage, "data") : writeLimitsFor(stage, stage.args.target, deps)),
    async work(ctx) {
      const key = rowKey(ctx, docId);
      if (method === "GET") {
        const doc = await deps.store.get(key);
        return doc ? docAnswer(doc) : notFound();
      }
      if (method === "DELETE") return Response.json({ deleted: await deps.store.remove(key) }, { headers: { "cache-control": "no-store" } });
      const limits = writeLimits(ctx, ctx.args.target.scope, deps.quotas());
      const result = await deps.store.put(key, ctx.args.data, ctx.args.bytes!, ctx.args.ifVersion, limits);
      if (!result.ok) return refusalFor(result.reason, limits);
      const { data: _data, ...doc } = result.doc;
      return docAnswer(doc);
    },
  };
}

const notFound = () =>
  Response.json({ error: { type: "not_found_error", code: "not_found", message: "There's no item with that id here.", param: null } }, { status: 404, headers: { "x-should-retry": "false" } });

const ORDERS: readonly QueryOrder[] = ["newest", "oldest", "recent"];

function queryRoute(deps: DataDeps, collection: string): CapRoute<{ target: Target; where: Record<string, string | number | boolean | null> | null; order: QueryOrder; limit: number; after: string | null }> {
  return {
    cap: "data",
    what: "/data",
    async args(stage) {
      const body = await readJsonBody(stage.req, 16 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["scope", "where", "order", "limit", "after"]);
      if (extra) return extra;
      const t = await target(stage, deps, collection, body.scope);
      if (t instanceof Response) return t;
      let where: Record<string, string | number | boolean | null> | null = null;
      if (body.where !== undefined && body.where !== null) {
        if (typeof body.where !== "object" || Array.isArray(body.where)) return capError("invalid_arguments", "where is an object of top-level fields and the values they must equal.");
        const entries = Object.entries(body.where as Record<string, unknown>);
        if (entries.length > DATA_LIMITS.whereMaxFields) return capError("invalid_arguments", `where can name at most ${DATA_LIMITS.whereMaxFields} fields.`);
        for (const [k, v] of entries) {
          if (!FIELD_NAME.test(k)) return capError("invalid_arguments", `where names a field that isn't a plain name: ${k.slice(0, 40)}.`);
          if (v !== null && !["string", "number", "boolean"].includes(typeof v)) return capError("invalid_arguments", "where compares top-level fields to a string, a number, true, false or null.");
        }
        where = Object.fromEntries(entries) as Record<string, string | number | boolean | null>;
      }
      const order = body.order === undefined ? "newest" : body.order;
      if (!ORDERS.includes(order as QueryOrder)) return capError("invalid_arguments", "order is newest, oldest or recent.");
      const limit = body.limit === undefined ? DATA_LIMITS.pageDefault : body.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > DATA_LIMITS.pageMax) return capError("invalid_arguments", `limit is 1 to ${DATA_LIMITS.pageMax}.`);
      const after = body.after === undefined || body.after === null ? null : body.after;
      if (after !== null && (typeof after !== "string" || after.length > 200 || !isCursor(after))) return capError("invalid_arguments", "after is the next value a page gave.");
      return { target: t, where, order: order as QueryOrder, limit: limit as number, after: after as string | null };
    },
    limits: (stage) => baseLimits(stage, "data"),
    async work(ctx) {
      const page = await deps.store.query({
        productId: ctx.token.productId,
        namespace: ctx.namespace,
        collection: ctx.args.target.collection,
        scope: ctx.args.target.scope,
        ownerKey: ctx.args.target.ownerKey,
        where: ctx.args.where,
        order: ctx.args.order,
        limit: ctx.args.limit,
        after: ctx.args.after,
      });
      return Response.json(page, { headers: { "cache-control": "no-store" } });
    },
  };
}

function deleteMineRoute(deps: DataDeps): CapRoute<{ keys: string[] }> {
  return {
    cap: "data",
    what: "/data",
    allow: ({ caller }) => (caller.visitor || caller.user ? null : capError("sign_in_required", "Nothing here is yours yet: this browser has no visitor id and nobody is signed in.")),
    async args({ caller, token }) {
      const keys = [
        ...(caller.visitor ? [subjectKey("visitor", token.productId, caller.visitor)] : []),
        ...(caller.user ? [subjectKey("user", token.productId, caller.user)] : []),
      ];
      return { keys };
    },
    limits: (stage) => baseLimits(stage, "data"),
    async work(ctx) {
      return Response.json({ deleted: await deps.store.deleteMine(ctx.token.productId, ctx.namespace, ctx.args.keys) }, { headers: { "cache-control": "no-store" } });
    },
  };
}

function collectionsRoute(deps: DataDeps): CapRoute<Record<string, never>> {
  return {
    cap: "data",
    what: "/data",
    allow: ({ caller }) => (caller.owner ? null : capError("sign_in_required", "Only the product's owner can list its collections.")),
    async args() {
      return {};
    },
    limits: (stage) => baseLimits(stage, "data"),
    async work(ctx) {
      const rows = await deps.store.collections(ctx.token.productId, ctx.namespace);
      return Response.json({ collections: rows.map((r) => ({ name: r.collection, scope: r.scope, rows: r.rows, bytes: r.bytes })) }, { headers: { "cache-control": "no-store" } });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// {GATEWAY_URL}/identity/user: end users who signed in with a passkey through Muse Muse

/**
 * POST {GATEWAY_URL}/identity/user with {code, bind}: a live product trades the code /u/sign-in sent to its live origin
 * for a 30-day session (`us1`), kept in its HttpOnly mm_user cookie. The code is for one product, works once, and only
 * with the `bind` value from the cookie of the browser that started the sign-in.
 */
export function handleIdentityUser(req: Request, deps: DataDeps): Promise<Response> {
  return runCapGate<{ code: string; bind: string }>(req, deps, {
    cap: "data",
    what: "/identity/user",
    enabled: deps.signInOn,
    scopes: ["live"],
    async args({ req: r }) {
      if (r.method !== "POST") return capError("invalid_arguments", "Use POST.");
      const body = await readJsonBody(r, 4 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["code", "bind"]);
      if (extra) return extra;
      if (typeof body.code !== "string" || body.code.length > 1024) return capError("invalid_arguments", "Send the sign-in code as code.");
      return isSignInBind(body.bind) ? { code: body.code, bind: body.bind } : capError("sign_in_required", "This browser didn't start this sign-in. Sign in again.");
    },
    limits: (stage) => [
      ...baseLimits(stage, "data-identity"),
      ...(stage.caller.ip ? [{ key: `data-identity:exchange:${stage.caller.ip}`, limit: DATA_LIMITS.exchangesPerIpPerMinute, window: "minute" as const, who: "this user" }] : []),
    ],
    async work(ctx) {
      const code = readUserCode(ctx.args.code, ctx.now);
      if (!code || code.productId !== ctx.token.productId) return capError("sign_in_required", "This sign-in link is no good. Sign in again.");
      if (!sameMac(code.bind, ctx.args.bind)) return capError("sign_in_required", "This browser didn't start this sign-in. Sign in again.");
      if ((await deps.reserveCounter(`user-code:${code.nonce}`, code.exp, 1, 1)) === null) return capError("sign_in_required", "This sign-in link was already used. Sign in again.");
      const { session, expiresAt } = mintUserSession({ productId: ctx.token.productId, subject: code.subject }, ctx.now);
      return Response.json({ session, expiresAt: expiresAt.toISOString(), user: { id: code.subject, name: code.name } }, { headers: { "cache-control": "no-store" } });
    },
  });
}

/** POST {GATEWAY_URL}/identity/user/test with {name}: a build's made-up person, the same one for the same name. */
export function handleIdentityUserTest(req: Request, deps: DataDeps): Promise<Response> {
  return runCapGate<{ name: string }>(req, deps, {
    cap: "data",
    what: "/identity/user/test",
    enabled: deps.signInOn,
    scopes: ["build"],
    async args({ req: r }) {
      if (r.method !== "POST") return capError("invalid_arguments", "Use POST.");
      const body = await readJsonBody(r, 4 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["name"]);
      if (extra) return extra;
      const name = cleanDisplayName(body.name);
      return name ? { name } : capError("invalid_arguments", "Give the made-up person a name, up to 40 characters.");
    },
    limits: (stage) => baseLimits(stage, "data-identity"),
    async work(ctx) {
      const buildId = ctx.token.buildId!;
      // Two days ahead, so the hourly prune of old windows keeps the count for the whole build.
      const window = new Date(dayWindow(ctx.now).getTime() + 86_400_000);
      if ((await deps.reserveCounter(`data-test-users:${buildId}`, window, 1, DATA_LIMITS.testUsersPerBuild)) === null) {
        return capError("rate_limited", `A build can sign in made-up people ${DATA_LIMITS.testUsersPerBuild} times.`);
      }
      const subject = testUserSubject(buildId, ctx.args.name);
      const { session, expiresAt } = mintTestUserSession({ productId: ctx.token.productId, buildId, subject }, ctx.now);
      return Response.json({ session, expiresAt: expiresAt.toISOString(), user: { id: subject, name: ctx.args.name }, simulated: true }, { headers: { "cache-control": "no-store" } });
    },
  });
}

/**
 * POST {GATEWAY_URL}/identity/user/link with {returnTo, bind}: the platform's passkey page for this product. A product
 * doesn't know its own slug, so its "Sign in" asks here. `bind` is the value the product just put in this browser's
 * mm_signin cookie; the page carries it into the code. A build gets the link too, marked simulated: the page refuses a
 * product that isn't live, and the build's tests sign in made-up people instead.
 */
export function handleIdentityUserLink(req: Request, deps: DataDeps): Promise<Response> {
  return runCapGate<{ returnTo: string; bind: string }>(req, deps, {
    cap: "data",
    what: "/identity/user/link",
    enabled: deps.signInOn,
    async args({ req: r }) {
      if (r.method !== "POST") return capError("invalid_arguments", "Use POST.");
      const body = await readJsonBody(r, 4 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["returnTo", "bind"]);
      if (extra) return extra;
      const returnTo = safeReturnPath(body.returnTo);
      if (!returnTo) return capError("invalid_arguments", "returnTo is a path on the product's own site.");
      return isSignInBind(body.bind) ? { returnTo, bind: body.bind } : capError("invalid_arguments", "bind is the sign-in value this browser's cookie holds.");
    },
    limits: (stage) => baseLimits(stage, "data-identity"),
    async work(ctx) {
      const slug = await deps.productSlug(ctx.token.productId);
      if (!slug) return capError("cap_failed", "The product couldn't be found. Try again.");
      const url = new URL("/u/sign-in", deps.platformUrl);
      url.searchParams.set("product", slug);
      url.searchParams.set("returnTo", ctx.args.returnTo);
      url.searchParams.set("bind", ctx.args.bind);
      return Response.json({ url: url.toString(), ...(isBuild(ctx.token) ? { simulated: true } : {}) }, { headers: { "cache-control": "no-store" } });
    },
  });
}
