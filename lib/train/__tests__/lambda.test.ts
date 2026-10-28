import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  cacheFilesystemName,
  cacheRegions,
  ensureFilesystem,
  findCacheFilesystem,
  ensureServeFirewall,
  findInstanceByName,
  getInstance,
  LambdaApiError,
  lambdaTiming,
  launchInstance,
  listFilesystems,
  listFirewallRulesets,
  listInstances,
  listInstanceTypes,
  pickGpu,
  serveFirewallName,
  serveFirewallRules,
  terminateInstances,
  type LambdaInstanceType,
} from "@/lib/train/lambda";
import type { GpuChoice } from "@/lib/train/types";

/**
 * The Lambda client against a faked fetch. Nothing here reaches Lambda: every call goes to `serve`'s handler.
 */

const KEY = "secret_fake-test-key_0123456789abcdef";
const realFetch = globalThis.fetch;
const savedKey = process.env.LAMBDA_API_KEY;

interface Call {
  method: string;
  url: URL;
  auth: string | null;
  contentType: string | null;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

let calls: Call[] = [];

/** Replaces fetch with `handler`, which sees each call and its 1-based number. */
function serve(handler: (call: Call, n: number) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      auth: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
}

function lambdaError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, suggestion: "Try again." } }, { status });
}

function rawInstance(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `mm-train-${id}-smoke`,
    ip: "198.51.100.2",
    private_ip: "10.0.2.100",
    status: "active",
    ssh_key_names: ["muse-muse-platform"],
    file_system_names: [],
    region: { name: "us-east-1", description: "Virginia, USA" },
    instance_type: {
      name: "gpu_1x_a10",
      description: "1x A10 (24 GB PCIe)",
      gpu_description: "A10 (24 GB PCIe)",
      price_cents_per_hour: 75,
      specs: { vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1 },
    },
    ...over,
  };
}

async function rejection(promise: Promise<unknown>): Promise<LambdaApiError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof LambdaApiError, `expected a LambdaApiError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to throw");
}

beforeEach(() => {
  process.env.LAMBDA_API_KEY = KEY;
  lambdaTiming.retryWaitMs = 1;
  lambdaTiming.timeoutMs = 20_000;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.LAMBDA_API_KEY;
  else process.env.LAMBDA_API_KEY = savedKey;
  lambdaTiming.retryWaitMs = 2_000;
  lambdaTiming.timeoutMs = 20_000;
});

describe("listInstanceTypes", () => {
  it("maps Lambda's map of types to a list with price, GPU count and us- regions first", async () => {
    serve(() =>
      Response.json({
        data: {
          gpu_1x_a10: {
            instance_type: {
              name: "gpu_1x_a10",
              description: "1x A10 (24 GB PCIe)",
              gpu_description: "A10 (24 GB PCIe)",
              price_cents_per_hour: 75,
              specs: { vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1 },
              architecture: "x86_64",
            },
            regions_with_capacity_available: [
              { name: "europe-central-1", description: "Germany" },
              { name: "us-west-1", description: "California, USA" },
              { name: "asia-south-1", description: "India" },
              { name: "us-east-1", description: "Virginia, USA" },
            ],
          },
          gpu_8x_h100_sxm5: {
            instance_type: {
              name: "gpu_8x_h100_sxm5",
              description: "",
              gpu_description: "H100 (80 GB SXM5)",
              price_cents_per_hour: 3592,
              specs: { vcpus: 208, memory_gib: 1800, storage_gib: 24780, gpus: 8 },
              architecture: "x86_64",
            },
            regions_with_capacity_available: [],
          },
        },
      }),
    );
    const types = await listInstanceTypes();
    assert.deepEqual(types, [
      {
        name: "gpu_1x_a10",
        description: "1x A10 (24 GB PCIe)",
        priceCentsPerHour: 75,
        gpus: 1,
        regionsWithCapacity: ["us-west-1", "us-east-1", "europe-central-1", "asia-south-1"],
      },
      { name: "gpu_8x_h100_sxm5", description: "H100 (80 GB SXM5)", priceCentsPerHour: 3592, gpus: 8, regionsWithCapacity: [] },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url.href, "https://cloud.lambda.ai/api/v1/instance-types");
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
    assert.ok(calls[0].signal instanceof AbortSignal, "every call carries a timeout signal");
  });

  it("reads the key on every call, so a rotated key is used without a restart", async () => {
    serve(() => Response.json({ data: {} }));
    await listInstanceTypes();
    process.env.LAMBDA_API_KEY = "secret_rotated_key_fedcba9876543210";
    await listInstanceTypes();
    assert.deepEqual(
      calls.map((c) => c.auth),
      [`Bearer ${KEY}`, "Bearer secret_rotated_key_fedcba9876543210"],
    );
  });

  it("throws before calling Lambda when LAMBDA_API_KEY is missing", async () => {
    serve(() => Response.json({ data: {} }));
    delete process.env.LAMBDA_API_KEY;
    await assert.rejects(listInstanceTypes(), /LAMBDA_API_KEY is not set/);
    assert.equal(calls.length, 0);
  });
});

describe("listInstances and getInstance", () => {
  it("maps instances and follows page_token until it is null", async () => {
    serve((call) => {
      if (!call.url.searchParams.get("page_token")) {
        return Response.json({ data: [rawInstance("aaa"), rawInstance("bbb", { name: "", ip: undefined, status: "booting" })], page_token: "next-1" });
      }
      return Response.json({ data: [rawInstance("ccc", { region: { name: "europe-central-1", description: "Germany" } })], page_token: null });
    });
    const instances = await listInstances();
    assert.deepEqual(instances, [
      { id: "aaa", name: "mm-train-aaa-smoke", status: "active", ip: "198.51.100.2", instanceType: "gpu_1x_a10", region: "us-east-1" },
      { id: "bbb", name: null, status: "booting", ip: null, instanceType: "gpu_1x_a10", region: "us-east-1" },
      { id: "ccc", name: "mm-train-ccc-smoke", status: "active", ip: "198.51.100.2", instanceType: "gpu_1x_a10", region: "europe-central-1" },
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.pathname, "/api/v1/instances");
    assert.equal(calls[0].url.searchParams.get("page_size"), "100");
    assert.equal(calls[1].url.searchParams.get("page_token"), "next-1");
  });

  it("treats a response with no page_token as the last page", async () => {
    serve(() => Response.json({ data: [rawInstance("aaa")] }));
    assert.equal((await listInstances()).length, 1);
    assert.equal(calls.length, 1);
  });

  it("refuses an endless page_token loop instead of returning a partial list", async () => {
    serve((_, n) => Response.json({ data: [rawInstance(`i${n}`)], page_token: `p${n}` }));
    const err = await rejection(listInstances());
    assert.equal(err.code, "too-many-pages");
    assert.equal(calls.length, 20);
  });

  it("gets one instance by id", async () => {
    serve(() => Response.json({ data: rawInstance("abc123", { status: "unhealthy" }) }));
    const instance = await getInstance("abc123");
    assert.equal(instance?.status, "unhealthy");
    assert.equal(calls[0].url.href, "https://cloud.lambda.ai/api/v1/instances/abc123");
  });

  it("passes the instance's tags through, keeping only string key and value pairs", async () => {
    const tags = [{ key: "muse-muse", value: "train" }, { key: "muse-muse-job", value: "job-1" }, { key: 3, value: "x" }, null, { key: "k" }];
    serve(() => Response.json({ data: [rawInstance("aaa", { tags }), rawInstance("bbb", { tags: [] })], page_token: null }));
    const [tagged, untagged] = await listInstances();
    assert.deepEqual(tagged?.tags, [
      { key: "muse-muse", value: "train" },
      { key: "muse-muse-job", value: "job-1" },
    ]);
    assert.equal(untagged && "tags" in untagged, false, "no tags, no field");
  });

  it("returns null when Lambda answers 404 for the id", async () => {
    serve(() => lambdaError(404, "global/object-does-not-exist", "Specified instance does not exist."));
    assert.equal(await getInstance("gone"), null);
    assert.equal(calls.length, 1, "a 404 is not retried");
  });

  it("throws LambdaApiError with Lambda's status, code and message on other errors", async () => {
    serve(() => lambdaError(403, "global/account-inactive", "Your account is inactive."));
    const err = await rejection(getInstance("abc"));
    assert.equal(err.status, 403);
    assert.equal(err.code, "global/account-inactive");
    assert.match(err.message, /GET \/instances\/abc failed \(403 global\/account-inactive\): Your account is inactive\./);
  });
});

describe("findInstanceByName", () => {
  it("skips terminated and terminating instances with the same name", async () => {
    const name = "mm-train-12345678-smoke";
    serve(() =>
      Response.json({
        data: [
          rawInstance("old", { name, status: "terminated" }),
          rawInstance("dying", { name, status: "terminating" }),
          rawInstance("other", { name: "mm-train-87654321-smoke" }),
          rawInstance("live", { name, status: "booting" }),
        ],
        page_token: null,
      }),
    );
    assert.equal((await findInstanceByName(name))?.id, "live");
  });

  it("returns null when only gone instances have the name", async () => {
    serve(() => Response.json({ data: [rawInstance("old", { name: "x-1", status: "terminated" })], page_token: null }));
    assert.equal(await findInstanceByName("x-1"), null);
  });
});

describe("launchInstance", () => {
  const input = {
    name: "mm-train-12345678-smoke",
    instanceType: "gpu_1x_a10",
    region: "us-east-1",
    userData: "#cloud-config\nruncmd:\n  - echo hi\n",
    sshKeyName: "muse-muse-platform",
    tags: [
      { key: "muse-muse", value: "train" },
      { key: "muse-muse-job", value: "12345678-aaaa-bbbb-cccc-1234567890ab" },
    ],
  };

  it("posts Lambda's launch body with exactly one SSH key and returns the instance id", async () => {
    serve(() => Response.json({ data: { instance_ids: ["0920582c7ff041399e34823a0be62549"] } }));
    assert.equal(await launchInstance(input), "0920582c7ff041399e34823a0be62549");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url.href, "https://cloud.lambda.ai/api/v1/instance-operations/launch");
    assert.equal(calls[0].contentType, "application/json");
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(calls[0].body, {
      region_name: "us-east-1",
      instance_type_name: "gpu_1x_a10",
      ssh_key_names: ["muse-muse-platform"],
      name: "mm-train-12345678-smoke",
      user_data: input.userData,
      tags: input.tags,
    });
  });

  it("refuses input Lambda would reject without sending anything", async () => {
    serve(() => Response.json({ data: { instance_ids: ["x"] } }));
    for (const bad of [
      { ...input, tags: [{ key: "Muse", value: "x" }] },
      { ...input, tags: [{ key: "lambda-ai-x", value: "x" }] },
      { ...input, tags: [{ key: "muse-muse", value: "v".repeat(129) }] },
      { ...input, name: "n".repeat(65) },
      { ...input, sshKeyName: "" },
      { ...input, userData: "x".repeat(1_000_001) },
    ]) {
      const err = await rejection(launchInstance(bad));
      assert.equal(err.status, 400);
      assert.equal(err.code, "invalid-input");
    }
    assert.equal(calls.length, 0);
  });

  it("retries a 429 once", async () => {
    serve((_, n) => (n === 1 ? lambdaError(429, "global/rate-limited", "Too many requests.") : Response.json({ data: { instance_ids: ["id-2"] } })));
    assert.equal(await launchInstance(input), "id-2");
    assert.equal(calls.length, 2);
  });

  it("does not retry a 5xx, since the instance may have launched anyway", async () => {
    serve(() => lambdaError(500, "global/internal-error", "An internal server error occurred."));
    const err = await rejection(launchInstance(input));
    assert.equal(err.status, 500);
    assert.equal(calls.length, 1);
  });

  it("passes Lambda's capacity error through with its code", async () => {
    serve(() => lambdaError(400, "instance-operations/launch/insufficient-capacity", "Not enough capacity to fulfill launch request."));
    const err = await rejection(launchInstance(input));
    assert.equal(err.code, "instance-operations/launch/insufficient-capacity");
    assert.equal(calls.length, 1);
  });

  it("mounts the named filesystems, and refuses a name Lambda would reject", async () => {
    serve(() => Response.json({ data: { instance_ids: ["id-3"] } }));
    assert.equal(await launchInstance({ ...input, fileSystemNames: ["muse-muse-cache-us-east-1"] }), "id-3");
    assert.deepEqual((calls[0].body as { file_system_names: string[] }).file_system_names, ["muse-muse-cache-us-east-1"]);
    for (const bad of ["9cache", "cache_fs", "c".repeat(61)]) {
      const err = await rejection(launchInstance({ ...input, fileSystemNames: [bad] }));
      assert.equal(err.code, "invalid-input");
    }
    assert.equal(calls.length, 1);
  });

  it("attaches the named firewall rulesets, and refuses an id Lambda would reject", async () => {
    serve(() => Response.json({ data: { instance_ids: ["id-4"] } }));
    assert.equal(await launchInstance({ ...input, firewallRulesetIds: ["c4d291f47f9d436fa39f58493ce3b50d"] }), "id-4");
    assert.deepEqual((calls[0].body as { firewall_rulesets: unknown }).firewall_rulesets, [{ id: "c4d291f47f9d436fa39f58493ce3b50d" }]);
    assert.equal(await launchInstance({ ...input, firewallRulesetIds: [] }), "id-4");
    assert.ok(!("firewall_rulesets" in (calls[1].body as object)), "sent only when non-empty");
    for (const bad of ["", "a/b", "x".repeat(65)]) {
      assert.equal((await rejection(launchInstance({ ...input, firewallRulesetIds: [bad] }))).code, "invalid-input");
    }
    assert.equal(calls.length, 2);
  });

  it("throws when Lambda accepts the launch but sends no id", async () => {
    serve(() => Response.json({ data: { instance_ids: [] } }));
    assert.equal((await rejection(launchInstance(input))).code, "no-instance-id");
  });
});

function rawFilesystem(name: string, region: string, over: Record<string, unknown> = {}) {
  return {
    id: `fs-${name}`,
    name,
    mount_point: `/lambda/nfs/${name}`,
    created: "2026-10-01T00:00:00Z",
    created_by: { id: "u1", email: "owner@example.com", status: "active" },
    is_in_use: false,
    region: { name: region, description: region },
    bytes_used: 1234,
    ...over,
  };
}

describe("filesystems", () => {
  it("lists filesystems with their region and mount point", async () => {
    serve(() =>
      Response.json({ data: [rawFilesystem("muse-muse-cache-us-east-1", "us-east-1"), rawFilesystem("other", "us-west-1", { mount_point: null, bytes_used: undefined })] }),
    );
    assert.deepEqual(await listFilesystems(), [
      { id: "fs-muse-muse-cache-us-east-1", name: "muse-muse-cache-us-east-1", region: "us-east-1", mountPoint: "/lambda/nfs/muse-muse-cache-us-east-1", inUse: false, bytesUsed: 1234 },
      { id: "fs-other", name: "other", region: "us-west-1", mountPoint: "/lambda/nfs/other", inUse: false, bytesUsed: null },
    ]);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url.href, "https://cloud.lambda.ai/api/v1/filesystems");
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
  });

  it("names the cache after its region", () => {
    assert.equal(cacheFilesystemName("us-east-1"), "muse-muse-cache-us-east-1");
  });

  it("ensureFilesystem returns the existing cache without creating anything", async () => {
    serve(() => Response.json({ data: [rawFilesystem("muse-muse-cache-us-west-1", "us-west-1"), rawFilesystem("muse-muse-cache-us-east-1", "us-east-1")] }));
    const fs = await ensureFilesystem("us-east-1");
    assert.equal(fs.name, "muse-muse-cache-us-east-1");
    assert.equal(fs.mountPoint, "/lambda/nfs/muse-muse-cache-us-east-1");
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  it("ensureFilesystem creates a missing cache with exactly Lambda's create body", async () => {
    serve((call) =>
      call.method === "GET" ? Response.json({ data: [rawFilesystem("other", "us-east-1")] }) : Response.json({ data: rawFilesystem("muse-muse-cache-us-east-1", "us-east-1") }),
    );
    const fs = await ensureFilesystem("us-east-1");
    assert.equal(fs.id, "fs-muse-muse-cache-us-east-1");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), ["GET /api/v1/filesystems", "POST /api/v1/filesystems"]);
    assert.deepEqual(calls[1].body, { name: "muse-muse-cache-us-east-1", region: "us-east-1" });
    assert.equal(calls[1].contentType, "application/json");
  });

  it("ensureFilesystem takes the one another caller made when the create is a duplicate", async () => {
    let listed = 0;
    serve((call) => {
      if (call.method === "POST") return lambdaError(400, "global/duplicate", "A filesystem with that name already exists.");
      listed += 1;
      return Response.json({ data: listed === 1 ? [] : [rawFilesystem("muse-muse-cache-us-east-1", "us-east-1")] });
    });
    assert.equal((await ensureFilesystem("us-east-1")).name, "muse-muse-cache-us-east-1");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1, "one create, never a loop");
  });

  it("ensureFilesystem never sends a second create after a 5xx, and finds one that was made anyway", async () => {
    let listed = 0;
    serve((call) => {
      if (call.method === "POST") return lambdaError(500, "global/internal-error", "An internal server error occurred.");
      listed += 1;
      return Response.json({ data: listed === 1 ? [] : [rawFilesystem("muse-muse-cache-us-east-1", "us-east-1")] });
    });
    assert.equal((await ensureFilesystem("us-east-1")).name, "muse-muse-cache-us-east-1");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);

    serve((call) => (call.method === "POST" ? lambdaError(502, "global/internal-error", "Bad gateway.") : Response.json({ data: [] })));
    const err = await rejection(ensureFilesystem("us-east-1"));
    assert.equal(err.status, 502);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  });

  it("ensureFilesystem passes a quota refusal through with one create and no second listing", async () => {
    serve((call) => (call.method === "POST" ? lambdaError(400, "global/quota-exceeded", "Quota exceeded.") : Response.json({ data: [] })));
    const err = await rejection(ensureFilesystem("us-east-1"));
    assert.equal(err.code, "global/quota-exceeded");
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  });

  it("ensureFilesystem retries a 429 on the create once, since nothing was made", async () => {
    let posts = 0;
    serve((call) => {
      if (call.method === "GET") return Response.json({ data: [] });
      posts += 1;
      return posts === 1 ? lambdaError(429, "global/rate-limited", "Too many requests.") : Response.json({ data: rawFilesystem("muse-muse-cache-us-east-1", "us-east-1") });
    });
    assert.equal((await ensureFilesystem("us-east-1")).name, "muse-muse-cache-us-east-1");
    assert.equal(posts, 2);
  });

  it("ensureFilesystem refuses a bad region and a cache name found in another region", async () => {
    serve(() => Response.json({ data: [rawFilesystem("muse-muse-cache-us-east-1", "us-west-1")] }));
    assert.equal((await rejection(ensureFilesystem(""))).code, "invalid-input");
    assert.equal((await rejection(ensureFilesystem("us_east_1"))).code, "invalid-input");
    assert.equal(calls.length, 0, "nothing sent for a bad region");
    assert.equal((await rejection(ensureFilesystem("us-east-1"))).code, "filesystem-in-wrong-region");
    assert.ok(!calls.some((c) => c.method === "POST"));
  });

  it("cacheRegions lists the regions that already have a cache, once each", async () => {
    serve(() =>
      Response.json({
        data: [
          rawFilesystem("muse-muse-cache-us-east-1", "us-east-1"),
          rawFilesystem("someone-else", "us-south-1"),
          rawFilesystem("muse-muse-cache-us-west-1", "us-west-3"),
          rawFilesystem("muse-muse-cache-europe-central-1", "europe-central-1"),
        ],
      }),
    );
    assert.deepEqual(await cacheRegions(), ["us-east-1", "europe-central-1"]);
  });

  it("findCacheFilesystem only lists: the region's cache, or null, never a create", async () => {
    serve(() => Response.json({ data: [rawFilesystem("muse-muse-cache-us-east-1", "us-east-1"), rawFilesystem("muse-muse-cache-us-west-1", "us-east-3")] }));
    assert.equal((await findCacheFilesystem("us-east-1"))?.name, "muse-muse-cache-us-east-1");
    assert.equal(await findCacheFilesystem("us-south-1"), null);
    assert.equal((await rejection(findCacheFilesystem("us-west-1"))).code, "filesystem-in-wrong-region");
    assert.ok(calls.every((c) => c.method === "GET"), "never a POST");
    calls.length = 0;
    assert.equal((await rejection(findCacheFilesystem("us_east_1"))).code, "invalid-input");
    assert.equal(calls.length, 0, "nothing sent for a bad region");
  });

  it("cacheRegions throws when Lambda doesn't answer", async () => {
    serve(() => lambdaError(403, "global/account-inactive", "Account inactive."));
    assert.equal((await rejection(cacheRegions())).status, 403);
  });
});

function rawRuleset(name: string, region: string, over: Record<string, unknown> = {}) {
  return {
    id: `fw-${name}`,
    name,
    region: { name: region, description: region },
    rules: serveFirewallRules(),
    created: "2026-10-27T00:00:00Z",
    instance_ids: ["inst-1"],
    ...over,
  };
}

describe("firewall rulesets", () => {
  const NAME = "muse-muse-serve-us-east-1";

  it("lets in only the demo's HTTPS port from everywhere, named after the region, and leaves SSH to the global rules", () => {
    assert.equal(serveFirewallName("us-east-1"), NAME);
    assert.deepEqual(
      serveFirewallRules().map((r) => [r.protocol, r.port_range, r.source_network]),
      [["tcp", [8443, 8443], "0.0.0.0/0"]],
    );
    assert.ok(!serveFirewallRules().some((r) => r.port_range?.[0] === 22), "SSH stays as the owner set it in the global ruleset");
    for (const rule of serveFirewallRules()) assert.ok(rule.description.length <= 128, "Lambda's limit on a description");
  });

  it("lists rulesets with their region, rules and instances", async () => {
    serve(() => Response.json({ data: [rawRuleset(NAME, "us-east-1"), rawRuleset("other", "us-west-1", { rules: [{ protocol: "icmp", source_network: "0.0.0.0/0", description: "ping" }, { protocol: "bogus" }] })] }));
    const listed = await listFirewallRulesets();
    assert.deepEqual(listed[0], { id: `fw-${NAME}`, name: NAME, region: "us-east-1", rules: serveFirewallRules(), instanceIds: ["inst-1"] });
    assert.deepEqual(listed[1]!.rules, [{ protocol: "icmp", source_network: "0.0.0.0/0", description: "ping" }], "a rule Lambda can't mean is dropped");
    assert.equal(calls[0].url.href, "https://cloud.lambda.ai/api/v1/firewall-rulesets");
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
  });

  it("ensureServeFirewall reuses the region's ruleset without changing anything", async () => {
    serve(() => Response.json({ data: [rawRuleset(NAME, "us-west-1"), rawRuleset(NAME, "us-east-1", { id: "fw-east" })] }));
    assert.equal((await ensureServeFirewall("us-east-1")).id, "fw-east");
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  it("ensureServeFirewall creates a missing ruleset with exactly Lambda's create body", async () => {
    serve((call) =>
      call.method === "GET"
        ? Response.json({ data: [rawRuleset(NAME, "us-west-1"), rawRuleset("someone-else", "us-east-1")] })
        : Response.json({ data: rawRuleset(NAME, "us-east-1", { id: "fw-new", instance_ids: [] }) }),
    );
    const made = await ensureServeFirewall("us-east-1");
    assert.equal(made.id, "fw-new");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), ["GET /api/v1/firewall-rulesets", "POST /api/v1/firewall-rulesets"]);
    assert.deepEqual(calls[1].body, { name: NAME, region: "us-east-1", rules: serveFirewallRules() });
    assert.equal(calls[1].contentType, "application/json");
  });

  it("ensureServeFirewall adds the demo's rule back once when someone edited it away, keeping the owner's own rules", async () => {
    const ownSsh = { protocol: "tcp", port_range: [22, 22], source_network: "198.51.100.7/32", description: "SSH from the office" };
    const edited = rawRuleset(NAME, "us-east-1", { id: "fw-east", rules: [ownSsh] });
    const patchedRules = [ownSsh, ...serveFirewallRules()];
    serve((call) => (call.method === "GET" ? Response.json({ data: [edited] }) : Response.json({ data: { ...edited, rules: patchedRules } })));
    const fixed = await ensureServeFirewall("us-east-1");
    assert.deepEqual(fixed.rules, patchedRules);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), ["GET /api/v1/firewall-rulesets", "PATCH /api/v1/firewall-rulesets/fw-east"]);
    assert.deepEqual(calls[1].body, { rules: patchedRules }, "the owner's SSH rule stays as they narrowed it, and nothing opens 22 to everyone");

    // A ruleset the owner narrowed (SSH from one address) that still lets the demo port in from everywhere is left alone.
    const narrowedSsh = rawRuleset(NAME, "us-east-1", { rules: [ownSsh, ...serveFirewallRules()] });
    serve(() => Response.json({ data: [narrowedSsh] }));
    assert.deepEqual((await ensureServeFirewall("us-east-1")).rules, [ownSsh, ...serveFirewallRules()]);
    assert.deepEqual(calls.map((c) => c.method), ["GET"], "no PATCH undoes the owner's change");

    // A rule that already lets in more (every TCP port from everywhere) counts as covering it.
    const wide = rawRuleset(NAME, "us-east-1", { rules: [{ protocol: "tcp", port_range: [1, 65535], source_network: "0.0.0.0/0", description: "all" }] });
    serve(() => Response.json({ data: [wide] }));
    await ensureServeFirewall("us-east-1");
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);

    // One open to a single address doesn't: the proxy runs on Vercel, whose addresses aren't fixed. The narrow rule
    // stays, and the demo's is added after it.
    const narrowRules = serveFirewallRules().map((r) => ({ ...r, source_network: "198.51.100.7/32" }));
    const narrow = rawRuleset(NAME, "us-east-1", { rules: narrowRules });
    serve((call) => (call.method === "GET" ? Response.json({ data: [narrow] }) : Response.json({ data: rawRuleset(NAME, "us-east-1") })));
    await ensureServeFirewall("us-east-1");
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PATCH"]);
    assert.deepEqual(calls[1].body, { rules: [...narrowRules, ...serveFirewallRules()] });
  });

  it("ensureServeFirewall takes the one another caller made when the create is a duplicate or a conflict", async () => {
    for (const refusal of [lambdaError(400, "global/duplicate", "Already exists."), lambdaError(409, "global/internal-error", "Conflict.")]) {
      let listed = 0;
      serve((call) => {
        if (call.method === "POST") return refusal.clone();
        listed += 1;
        return Response.json({ data: listed === 1 ? [] : [rawRuleset(NAME, "us-east-1")] });
      });
      assert.equal((await ensureServeFirewall("us-east-1")).name, NAME);
      assert.equal(calls.filter((c) => c.method === "POST").length, 1, "one create, never a loop");
    }
  });

  it("ensureServeFirewall never sends a second create after a 5xx, and finds one that was made anyway", async () => {
    let listed = 0;
    serve((call) => {
      if (call.method === "POST") return lambdaError(500, "global/internal-error", "An internal server error occurred.");
      listed += 1;
      return Response.json({ data: listed === 1 ? [] : [rawRuleset(NAME, "us-east-1")] });
    });
    assert.equal((await ensureServeFirewall("us-east-1")).name, NAME);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);

    serve((call) => (call.method === "POST" ? lambdaError(502, "global/internal-error", "Bad gateway.") : Response.json({ data: [] })));
    const err = await rejection(ensureServeFirewall("us-east-1"));
    assert.equal(err.status, 502);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  });

  it("ensureServeFirewall passes a quota refusal through, retries a 429 once, and refuses a bad region unsent", async () => {
    serve((call) => (call.method === "POST" ? lambdaError(400, "global/quota-exceeded", "Quota exceeded.") : Response.json({ data: [] })));
    assert.equal((await rejection(ensureServeFirewall("us-east-1"))).code, "global/quota-exceeded");
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);

    let posts = 0;
    serve((call) => {
      if (call.method === "GET") return Response.json({ data: [] });
      posts += 1;
      return posts === 1 ? lambdaError(429, "global/rate-limited", "Too many requests.") : Response.json({ data: rawRuleset(NAME, "us-east-1") });
    });
    assert.equal((await ensureServeFirewall("us-east-1")).name, NAME);
    assert.equal(posts, 2);

    serve(() => Response.json({ data: [] }));
    for (const bad of ["", "us_east_1", "US-EAST-1", "x".repeat(60)]) {
      assert.equal((await rejection(ensureServeFirewall(bad))).code, "invalid-input", bad);
    }
    assert.equal(calls.length, 0);
  });
});

describe("retries and failures", () => {
  it("retries a 5xx on a read once after the wait, then succeeds", async () => {
    serve((_, n) => (n === 1 ? new Response("<html>Bad gateway</html>", { status: 502 }) : Response.json({ data: {} })));
    assert.deepEqual(await listInstanceTypes(), []);
    assert.equal(calls.length, 2);
  });

  it("retries a 429 on a read once", async () => {
    serve((_, n) => (n === 1 ? lambdaError(429, "global/rate-limited", "Too many requests.") : Response.json({ data: {} })));
    await listInstanceTypes();
    assert.equal(calls.length, 2);
  });

  it("gives up after the one retry and reports the second failure", async () => {
    serve(() => new Response("upstream down", { status: 503 }));
    const err = await rejection(listInstanceTypes());
    assert.equal(err.status, 503);
    assert.equal(err.code, null);
    assert.match(err.message, /failed \(503\): upstream down/);
    assert.equal(calls.length, 2);
  });

  it("does not retry other 4xx errors", async () => {
    serve(() => lambdaError(400, "global/invalid-parameters", "Invalid request data."));
    await rejection(listInstanceTypes());
    assert.equal(calls.length, 1);
  });

  it("waits about retryWaitMs before the retry", async () => {
    lambdaTiming.retryWaitMs = 60;
    const at: number[] = [];
    serve((_, n) => {
      at.push(Date.now());
      return n === 1 ? new Response("", { status: 500 }) : Response.json({ data: {} });
    });
    await listInstanceTypes();
    assert.ok(at[1] - at[0] >= 50, `waited ${at[1] - at[0]} ms`);
  });

  it("reports a timeout as status 0, code timeout", async () => {
    lambdaTiming.timeoutMs = 20;
    serve(
      (call) =>
        new Promise<Response>((_, reject) => {
          // AbortSignal.timeout's timer is unref'd, so hold the event loop open like a slow server would.
          const keepAlive = setTimeout(() => {}, 5_000);
          call.signal?.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(call.signal!.reason);
          });
        }),
    );
    const err = await rejection(listInstanceTypes());
    assert.equal(err.status, 0);
    assert.equal(err.code, "timeout");
    assert.equal(calls.length, 1);
  });

  it("reports an unreachable Lambda as status 0, code network", async () => {
    serve(() => Promise.reject(new TypeError("fetch failed")));
    const err = await rejection(listInstances());
    assert.equal(err.status, 0);
    assert.equal(err.code, "network");
    assert.match(err.message, /could not reach Lambda: fetch failed/);
  });

  it("never puts the key in an error message, even when Lambda or the network echoes it", async () => {
    serve((call) => lambdaError(401, "global/invalid-api-key", `API key ${call.auth} was invalid, expired, or deleted.`));
    const err = await rejection(listInstanceTypes());
    assert.equal(calls[0].auth, `Bearer ${KEY}`, "the key is sent");
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes(KEY), err.message);
    assert.ok(!String(err.stack).includes(KEY));
    assert.match(err.message, /\[redacted\]/);

    serve((call) => new Response(`proxy saw ${call.auth}`, { status: 500 }));
    assert.ok(!(await rejection(getInstance("abc"))).message.includes(KEY));

    serve(() => Promise.reject(new Error(`socket closed while sending Bearer ${KEY}`)));
    assert.ok(!(await rejection(listInstances())).message.includes(KEY));
  });
});

describe("terminateInstances", () => {
  it("does nothing for an empty list", async () => {
    serve(() => Response.json({ data: { terminated_instances: [] } }));
    await terminateInstances([]);
    await terminateInstances(["", ""]);
    assert.equal(calls.length, 0);
  });

  it("posts the ids once each", async () => {
    serve(() => Response.json({ data: { terminated_instances: [rawInstance("a", { status: "terminating" })] } }));
    await terminateInstances(["a", "b", "a"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url.href, "https://cloud.lambda.ai/api/v1/instance-operations/terminate");
    assert.deepEqual(calls[0].body, { instance_ids: ["a", "b"] });
  });

  it("counts a 404 as already terminated", async () => {
    serve(() => lambdaError(404, "global/object-does-not-exist", "Specified instance does not exist."));
    await terminateInstances(["gone"]);
    assert.equal(calls.length, 1);
  });

  it("counts an already-terminated error as success", async () => {
    serve(() => lambdaError(400, "global/invalid-parameters", "Instance gone is already terminated."));
    await terminateInstances(["gone"]);
    serve(() => lambdaError(409, "global/conflict", "The instance has already been terminated."));
    await terminateInstances(["gone"]);
  });

  it("is idempotent: terminating twice succeeds both times", async () => {
    let terminated = false;
    serve(() => {
      if (terminated) return lambdaError(404, "global/object-does-not-exist", "Specified instance does not exist.");
      terminated = true;
      return Response.json({ data: { terminated_instances: [rawInstance("a", { status: "terminating" })] } });
    });
    await terminateInstances(["a"]);
    await terminateInstances(["a"]);
    assert.equal(calls.length, 2);
  });

  it("terminates the rest one by one when Lambda refuses a batch over one gone instance", async () => {
    serve((call) => {
      const ids = (call.body as { instance_ids: string[] }).instance_ids;
      if (ids.includes("gone")) return lambdaError(404, "global/object-does-not-exist", "Specified instance does not exist.");
      return Response.json({ data: { terminated_instances: ids.map((id) => rawInstance(id, { status: "terminating" })) } });
    });
    await terminateInstances(["live", "gone", "live-2"]);
    assert.deepEqual(
      calls.map((c) => (c.body as { instance_ids: string[] }).instance_ids),
      [["live", "gone", "live-2"], ["live"], ["gone"], ["live-2"]],
    );
  });

  it("still tries every instance when one fails in the one-by-one pass, then throws", async () => {
    serve((call) => {
      const ids = (call.body as { instance_ids: string[] }).instance_ids;
      if (ids.length > 1) return lambdaError(404, "global/object-does-not-exist", "Specified instance does not exist.");
      if (ids[0] === "stuck") return lambdaError(403, "global/forbidden", "Not allowed.");
      return Response.json({ data: { terminated_instances: [] } });
    });
    const err = await rejection(terminateInstances(["stuck", "live"]));
    assert.equal(err.status, 403);
    assert.deepEqual(
      calls.map((c) => (c.body as { instance_ids: string[] }).instance_ids),
      [["stuck", "live"], ["stuck"], ["live"]],
    );
  });

  it("throws on errors that don't mean the instance is gone", async () => {
    serve(() => lambdaError(401, "global/invalid-api-key", "API key was invalid, expired, or deleted."));
    assert.equal((await rejection(terminateInstances(["a"]))).status, 401);
    serve(() => lambdaError(400, "global/invalid-parameters", "Invalid request data."));
    assert.equal((await rejection(terminateInstances(["a"]))).status, 400);
  });

  it("retries a 5xx once, since terminating twice is safe", async () => {
    serve((_, n) => (n === 1 ? new Response("", { status: 500 }) : Response.json({ data: { terminated_instances: [] } })));
    await terminateInstances(["a"]);
    assert.equal(calls.length, 2);
  });
});

describe("pickGpu", () => {
  const choices: GpuChoice[] = [
    { instanceType: "gpu_1x_a10", label: "A10" },
    { instanceType: "gpu_1x_a6000", label: "A6000" },
    { instanceType: "gpu_1x_a100", label: "A100" },
  ];
  const type = (name: string, regions: string[], price = 100): LambdaInstanceType => ({
    name,
    description: name,
    priceCentsPerHour: price,
    gpus: 1,
    regionsWithCapacity: regions,
  });

  it("takes the asked type when it is a choice and has capacity", () => {
    const types = [type("gpu_1x_a10", ["us-east-1"], 75), type("gpu_1x_a100", ["us-west-1"], 129)];
    assert.deepEqual(pickGpu(choices, types, "gpu_1x_a100"), { instanceType: "gpu_1x_a100", region: "us-west-1", priceCentsPerHour: 129 });
  });

  it("falls back to the first choice with capacity when the asked one has none", () => {
    const types = [type("gpu_1x_a10", []), type("gpu_1x_a6000", ["us-south-1"], 80), type("gpu_1x_a100", [])];
    assert.deepEqual(pickGpu(choices, types, "gpu_1x_a100"), { instanceType: "gpu_1x_a6000", region: "us-south-1", priceCentsPerHour: 80 });
  });

  it("ignores an asked type that isn't one of the recipe's choices, even with capacity", () => {
    const types = [type("gpu_8x_h100_sxm5", ["us-east-1"], 3592), type("gpu_1x_a6000", ["us-east-1"], 80)];
    assert.equal(pickGpu(choices, types, "gpu_8x_h100_sxm5")?.instanceType, "gpu_1x_a6000");
  });

  it("follows the recipe's order, not Lambda's or the price", () => {
    const types = [type("gpu_1x_a100", ["us-east-1"], 50), type("gpu_1x_a6000", ["us-east-1"], 80)];
    assert.equal(pickGpu(choices, types)?.instanceType, "gpu_1x_a6000");
  });

  it("prefers a us- region and otherwise keeps Lambda's order", () => {
    assert.equal(pickGpu(choices, [type("gpu_1x_a10", ["europe-central-1", "asia-south-1", "us-west-3", "us-east-1"])])?.region, "us-west-3");
    assert.equal(pickGpu(choices, [type("gpu_1x_a10", ["europe-central-1", "asia-south-1"])])?.region, "europe-central-1");
  });

  it("skips a type with no price, since the dollar limit and the daily cap are worked out from it", () => {
    const types = [type("gpu_1x_a10", ["us-east-1"], 0), type("gpu_1x_a6000", ["us-east-1"], 80)];
    assert.equal(pickGpu(choices, types, "gpu_1x_a10")?.instanceType, "gpu_1x_a6000");
    assert.equal(pickGpu(choices, [type("gpu_1x_a10", ["us-east-1"], 0)]), null);
  });

  it("prefers a cache region over the recipe's order, but not over the asked type", () => {
    const types = [type("gpu_1x_a10", ["us-west-1"], 75), type("gpu_1x_a6000", ["us-east-1", "us-west-1"], 80)];
    assert.deepEqual(pickGpu(choices, types, undefined, ["us-east-1"]), { instanceType: "gpu_1x_a6000", region: "us-east-1", priceCentsPerHour: 80 });
    assert.deepEqual(pickGpu(choices, types, "gpu_1x_a10", ["us-east-1"]), { instanceType: "gpu_1x_a10", region: "us-west-1", priceCentsPerHour: 75 });
    assert.equal(pickGpu(choices, types, "gpu_1x_a6000", ["us-east-1"])?.region, "us-east-1", "the asked type goes to its cache region");
  });

  it("puts a cache region ahead of us- regions within a type, and falls back when no cache region has capacity", () => {
    const types = [type("gpu_1x_a10", ["us-west-1", "europe-central-1"], 75)];
    assert.equal(pickGpu(choices, types, undefined, ["europe-central-1"])?.region, "europe-central-1");
    assert.equal(pickGpu(choices, types, undefined, ["asia-south-1"])?.region, "us-west-1");
    assert.equal(pickGpu(choices, [type("gpu_1x_a10", ["us-east-1"], 0)], undefined, ["us-east-1"]), null, "a type with no price is still skipped");
  });

  it("counts only capacity in the one region a glimmer-serve job must launch in", () => {
    const types = [type("gpu_1x_a10", ["us-east-1"], 75), type("gpu_1x_a6000", ["us-west-1", "us-east-1"], 80), type("gpu_1x_a100", ["us-west-1"], 129)];
    assert.deepEqual(pickGpu(choices, types, undefined, [], "us-west-1"), { instanceType: "gpu_1x_a6000", region: "us-west-1", priceCentsPerHour: 80 });
    assert.deepEqual(pickGpu(choices, types, "gpu_1x_a100", [], "us-west-1"), { instanceType: "gpu_1x_a100", region: "us-west-1", priceCentsPerHour: 129 });
    assert.equal(pickGpu(choices, types, "gpu_1x_a10", [], "us-west-1")?.instanceType, "gpu_1x_a6000", "the asked type has no capacity there");
    assert.equal(pickGpu(choices, types, undefined, [], "europe-central-1"), null, "capacity elsewhere doesn't count");
    assert.deepEqual(types[0]!.regionsWithCapacity, ["us-east-1"], "the listing isn't changed");
  });

  it("skips choices Lambda doesn't list and returns null when nothing is free", () => {
    assert.equal(pickGpu(choices, [type("gpu_1x_a6000", [])]), null);
    assert.equal(pickGpu(choices, []), null);
    assert.equal(pickGpu([], [type("gpu_1x_a10", ["us-east-1"])]), null);
  });
});
