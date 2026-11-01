/**
 * Makes a product's phone and desktop downloads and records them, which is what the Get it panel and /p/<slug>/get/<kind>
 * read (docs/NATIVE.md). It runs the packager (docs/NATIVE_PACKAGER.md), writes a native_runs row and one native_artifacts
 * row per package, and tells the build room. A package that fails doesn't stop the others.
 */
import { eq } from "drizzle-orm";
import type { TargetId } from "@/lib/brief/schema";
import { db, schema } from "@/lib/db/client";
import { emit } from "@/lib/events";
import { collectPackaging, pollPackaging, startPackaging, stopPackaging, type CollectedPackages, type PackageRequest, type PackagingHandle, type PackagingState } from "@/lib/native/packager";
import type { ShellTemplateKind } from "@/lib/native/shells";
import type { NativeOrigin, NativeEventBody } from "@/lib/types";

const POLL_MS = 5_000;

/** What a phone or desktop target asks to be made. */
export function packageKinds(targets: readonly TargetId[]): ShellTemplateKind[] {
  return [...(targets.includes("phone") ? (["android"] as const) : []), ...(targets.includes("desktop") ? (["mac", "windows"] as const) : [])];
}

const targetOf = (kind: ShellTemplateKind): TargetId => (kind === "android" ? "phone" : "desktop");
const LABEL: Record<ShellTemplateKind, string> = { android: "Android app", mac: "Mac app", windows: "Windows app" };

export interface PackageRunInput {
  productId: string;
  buildId: string;
  slug: string;
  name: string;
  /** The address the app opens. */
  url: string;
  targets: readonly TargetId[];
  origin: Extract<NativeOrigin, "ship" | "owner" | "refine">;
}

export interface PackageRunDeps {
  start(req: PackageRequest): Promise<PackagingHandle>;
  poll(handle: PackagingHandle): Promise<PackagingState>;
  collect(handle: PackagingHandle, result: Extract<PackagingState, { state: "finished" }>["result"]): Promise<CollectedPackages>;
  stop(handle: PackagingHandle): Promise<void>;
  createRun(input: PackageRunInput): Promise<string>;
  addPackage(input: PackageRunInput, runId: string, file: CollectedPackages["files"][number]): Promise<void>;
  finishRun(runId: string, status: "done" | "partial" | "failed", packaged: CollectedPackages["files"], error: string | null): Promise<void>;
  emit(buildId: string, body: NativeEventBody): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface PackageRunResult {
  runId: string;
  status: "done" | "partial" | "failed";
  files: CollectedPackages["files"];
  failures: CollectedPackages["failures"];
}

export async function runPackaging(input: PackageRunInput, deps: PackageRunDeps = realDeps): Promise<PackageRunResult> {
  const kinds = packageKinds(input.targets);
  const runId = await deps.createRun(input);
  const say = (kind: ShellTemplateKind, state: NativeEventBody["state"], title: string, extra: Partial<NativeEventBody> = {}) =>
    deps.emit(input.buildId, { type: "native", runId, origin: input.origin, item: `package:${kind}`, target: targetOf(kind), state, title, ...extra });

  let files: CollectedPackages["files"] = [];
  let failures: CollectedPackages["failures"] = {};
  let handle: PackagingHandle | null = null;
  try {
    for (const kind of kinds) await say(kind, "running", `Making the ${LABEL[kind]}`);
    handle = await deps.start({ runId, productId: input.productId, slug: input.slug, name: input.name, url: input.url, kinds });
    let state = await deps.poll(handle);
    while (state.state === "running") {
      await deps.sleep(POLL_MS);
      state = await deps.poll(handle);
    }
    if (state.state === "failed") throw new Error(state.reason);
    ({ files, failures } = await deps.collect(handle, state.result));
    for (const file of files) await deps.addPackage(input, runId, file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    for (const kind of kinds) if (!files.some((f) => f.kind === kind)) failures[kind] ??= why;
  } finally {
    if (handle) await deps.stop(handle).catch(() => {});
  }

  for (const file of files) {
    await say(file.kind, "done", `Packaged the ${LABEL[file.kind]} (${Math.round(file.bytes / 1e6)} MB)`, { artifact: { kind: file.artifactKind, url: file.url, bytes: file.bytes } });
  }
  for (const [kind, why] of Object.entries(failures) as Array<[ShellTemplateKind, string]>) {
    await say(kind, "failed", `The ${LABEL[kind]} wasn't made`, { detail: why });
  }
  const status = !files.length ? "failed" : Object.keys(failures).length ? "partial" : "done";
  const error = Object.values(failures).join(" ").slice(0, 500) || null;
  await deps.finishRun(runId, status, files, error);
  return { runId, status, files, failures };
}

const realDeps: PackageRunDeps = {
  start: (req) => startPackaging(req),
  poll: (handle) => pollPackaging(handle),
  collect: (handle, result) => collectPackaging(handle, result),
  stop: (handle) => stopPackaging(handle),
  async createRun(input) {
    const [run] = await db()
      .insert(schema.nativeRuns)
      .values({ productId: input.productId, buildId: input.buildId, origin: input.origin, targets: [...input.targets], status: "running" })
      .returning({ id: schema.nativeRuns.id });
    return run.id;
  },
  async addPackage(input, runId, file) {
    await db().insert(schema.nativeArtifacts).values({
      productId: input.productId,
      runId,
      kind: file.artifactKind,
      platform: file.kind,
      url: file.url,
      pathname: file.pathname,
      bytes: file.bytes,
      sha256: file.sha256,
      shellVersion: file.shellVersion,
    });
  },
  async finishRun(runId, status, packaged, error) {
    await db()
      .update(schema.nativeRuns)
      .set({ status, error, finishedAt: new Date(), summary: { packaged: packaged.map((f) => f.artifactKind), checks: [] } })
      .where(eq(schema.nativeRuns.id, runId));
  },
  emit: (buildId, body) => emit(buildId, body),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
