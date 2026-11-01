import type { HostFacts, HostEndpoint } from "@/lib/train/host/types";

export const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
export const ID = "bbbbbbbb-0000-4000-8000-000000000001";

export function facts(over: Partial<HostFacts> = {}): HostFacts {
  return {
    adapterJobId: JOB,
    family: "glimmer",
    sparkOpen: true,
    rank: 16,
    trainChannel: 1,
    hubRepo: "OfflineBase/tuned",
    hubCommit: "c".repeat(40),
    servingBase: { repo: "OfflineBase/Glimmer-30B-2026-Knowledge", revision: "d".repeat(40) },
    lambdaProblem: null,
    duties: { family: "glimmer", line: "Built with Muse Spark Open", namePrefix: "", license: "The Muse Model License and its Usage Policy apply.", points: ["18 or older."] },
    problem: null,
    ...over,
  };
}

export function row(over: Partial<HostEndpoint> = {}): HostEndpoint {
  const createdAt = over.createdAt ?? new Date("2026-11-03T11:30:00Z");
  return {
    id: ID,
    adapterJobId: JOB,
    provider: "modal",
    status: "live",
    slot: 1,
    name: "mm-host-bbbbbbbb00004000",
    ref: { url: "https://secret-host--x.modal.run", endpointId: ID, family: "glimmer", sparkOpen: "1" },
    hourlyUsd: 4,
    reservedUsd: 8,
    costUsd: null,
    reservationId: "r1",
    ownerTokenHash: "hash",
    createdBy: "u1",
    stopReason: null,
    stopsAt: new Date(createdAt.getTime() + 2 * 3_600_000),
    readyAt: new Date(createdAt.getTime() + 25 * 60_000),
    lastUsedAt: null,
    createdAt,
    stoppedAt: null,
    ...over,
  };
}

/** Records calls and answers from a script, by "METHOD path" prefix. */
export function fakeFetch(answers: [string, () => Response][]) {
  const calls: { key: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${input}`;
    calls.push({ key, init });
    const hit = answers.find(([k]) => key.includes(k));
    if (!hit) throw new Error(`unexpected ${key}`);
    return hit[1]();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
