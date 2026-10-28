import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  findInstanceByName,
  getInstance,
  LambdaApiError,
  lambdaTiming,
  launchInstance,
  listInstances,
  listInstanceTypes,
  pickGpu,
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

  it("throws when Lambda accepts the launch but sends no id", async () => {
    serve(() => Response.json({ data: { instance_ids: [] } }));
    assert.equal((await rejection(launchInstance(input))).code, "no-instance-id");
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

  it("skips choices Lambda doesn't list and returns null when nothing is free", () => {
    assert.equal(pickGpu(choices, [type("gpu_1x_a6000", [])]), null);
    assert.equal(pickGpu(choices, []), null);
    assert.equal(pickGpu([], [type("gpu_1x_a10", ["us-east-1"])]), null);
  });
});
