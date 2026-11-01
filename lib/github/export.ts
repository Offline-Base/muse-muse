/**
 * Export to GitHub and push new versions (docs/GITHUB_EXPORT.md). The route has already checked that the person may read
 * the code. This only ever writes to a repo it made for this owner, and never forces.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { openConnection, revokeConnection, type Connection } from "@/lib/connected/store";
import type { ConnectionOwner } from "@/lib/connected/owner";
import { TERMINAL_STATUSES, type BuildStatus } from "@/lib/types";
import { commitsFrom, type Commit, type VersionFile } from "@/lib/versions/policy";
import { keptBuildIds, productCommitBuilds, readVersionFile } from "@/lib/versions/store";
import { createRepo, hasRepoScope, repoState, type GitHubConfig } from "@/lib/github/api";
import { GitPushError, pushPack, remoteRefs, type Remote } from "@/lib/github/git";
import { buildHistory, TooBigToPush, type HistoryVersion } from "@/lib/github/history";

export type ExportRow = typeof schema.codeExports.$inferSelect;

export type ExportResult =
  | { ok: true; repo: string; url: string; lastVersion: number | null; pushed: number; skipped: number; isPrivate: boolean; upToDate?: boolean }
  | { ok: false; status: number; error: string; message: string };

const fail = (status: number, error: string, message: string): ExportResult => ({ ok: false, status, error, message });

const commitTitle = (c: Commit) => (c.kind === "build" ? "First build" : (c.message ?? "Change"));

/** A saved version can be pushed once its build has ended: a commit can't be amended later. */
export const pushableCommits = (commits: readonly Commit[]) => commits.filter((c) => c.kept && TERMINAL_STATUSES.includes(c.status as BuildStatus)).sort((a, b) => a.number - b.number);

export async function productCommits(productId: string): Promise<Commit[]> {
  return commitsFrom(await productCommitBuilds(productId), await keptBuildIds(productId));
}

async function savedVersions(productId: string, commits: readonly Commit[]): Promise<HistoryVersion[]> {
  if (!commits.length) return [];
  const rows = await db()
    .select({ buildId: schema.productVersions.buildId, files: schema.productVersions.files })
    .from(schema.productVersions)
    .where(and(eq(schema.productVersions.productId, productId), inArray(schema.productVersions.buildId, commits.map((c) => c.id))));
  const files = new Map(rows.map((r) => [r.buildId, r.files as VersionFile[]]));
  return commits.filter((c) => files.has(c.id)).map((c) => ({ number: c.number, title: commitTitle(c), status: c.status, at: c.startedAt, files: files.get(c.id)! }));
}

export async function findExport(productId: string, owner: ConnectionOwner): Promise<ExportRow | null> {
  const [row] = await db()
    .select()
    .from(schema.codeExports)
    .where(and(eq(schema.codeExports.productId, productId), eq(schema.codeExports.provider, "github"), eq(schema.codeExports.ownerKind, owner.kind), eq(schema.codeExports.ownerKey, owner.key)))
    .orderBy(asc(schema.codeExports.createdAt))
    .limit(1);
  return row ?? null;
}

const authorOf = (c: Connection) => ({ name: c.externalLogin, email: `${c.externalId}+${c.externalLogin}@users.noreply.github.com` });

export const repoUrl = (config: GitHubConfig, fullName: string) => `${config.webUrl}/${fullName}`;

async function pushNew(config: GitHubConfig, row: ExportRow, connection: Connection & { token: string }, owner: ConnectionOwner): Promise<ExportResult> {
  const state = await repoState(config, connection.token, row.repoFullName);
  if (state === "bad_token") {
    await revokeConnection("github", owner);
    return fail(409, "reconnect", "GitHub no longer accepts this connection. Connect your account again.");
  }
  if (state === "gone") {
    await db().delete(schema.codeExports).where(eq(schema.codeExports.id, row.id));
    return fail(410, "repo_gone", "That repo isn't on your GitHub any more. Export again to make a new one.");
  }
  if (state === "unknown") return fail(502, "github_unavailable", "GitHub didn't answer as expected. Nothing was pushed. Try again, or download the source.");

  const commits = pushableCommits(await productCommits(row.productId));
  const fresh = commits.filter((c) => row.lastVersionNumber === null || c.number > row.lastVersionNumber);
  const url = repoUrl(config, row.repoFullName);
  const done = (over: Partial<Extract<ExportResult, { ok: true }>>): ExportResult => ({ ok: true, repo: row.repoFullName, url, lastVersion: row.lastVersionNumber, pushed: 0, skipped: 0, isPrivate: row.isPrivate, ...over });
  if (!fresh.length) return row.lastCommitSha ? done({ upToDate: true }) : fail(409, "no_versions", "This product has no finished version with saved source yet.");

  const remote: Remote = { url: `${url}.git`, token: connection.token, fetch: config.fetch };
  const ref = `refs/heads/${row.branch}`;
  try {
    const { refs, caps } = await remoteRefs(remote);
    if (!caps.has("report-status")) return fail(502, "github_unavailable", "GitHub didn't answer as expected. Nothing was pushed.");
    const head = refs.get(ref) ?? null;
    const previous = row.lastVersionNumber === null ? null : ((await savedVersions(row.productId, commits.filter((c) => c.number === row.lastVersionNumber)))[0] ?? null);
    const history = await buildHistory({
      versions: await savedVersions(row.productId, fresh),
      parent: row.lastCommitSha,
      previous,
      author: authorOf(connection),
      readFile: readVersionFile,
    });
    // A push that landed before its row was saved makes the same commit again, so it's only recorded this time.
    if (head !== history.head) {
      if (head !== row.lastCommitSha) return fail(409, "repo_changed", "That repo has changes that didn't come from here, so nothing was pushed. Your changes are safe. Export to a new repo, or download the source.");
      await pushPack(remote, { ref, oldId: row.lastCommitSha, newId: history.head, objects: history.objects });
    }
    const conditions = row.lastCommitSha ? eq(schema.codeExports.lastCommitSha, row.lastCommitSha) : isNull(schema.codeExports.lastCommitSha);
    await db()
      .update(schema.codeExports)
      .set({ lastCommitSha: history.head, lastVersionNumber: history.lastNumber, updatedAt: sql`now()` })
      .where(and(eq(schema.codeExports.id, row.id), conditions));
    return done({ lastVersion: history.lastNumber, pushed: fresh.length - history.skipped, skipped: history.skipped });
  } catch (err) {
    if (err instanceof TooBigToPush) return fail(413, "too_big", "This version is too big to push from here. Download the source instead.");
    if (err instanceof GitPushError) {
      console.error(`[github] push to a repo failed: ${err.kind}`);
      if (err.kind === "auth") return fail(403, "github_refused", "GitHub refused the push. Check this account can still write to the repo.");
      if (err.kind === "rejected") return fail(409, "push_rejected", `GitHub rejected the push: ${err.detail ?? "no reason given"}`);
      return fail(502, "github_unavailable", "The push didn't finish. Try again, or download the source.");
    }
    console.error("[github] push failed:", err instanceof Error ? err.name : "unknown");
    return fail(502, "push_failed", "The push didn't finish. Try again, or download the source.");
  }
}

async function usableConnection(owner: ConnectionOwner): Promise<(Connection & { token: string }) | ExportResult> {
  const connection = await openConnection("github", owner);
  if (!connection) return fail(409, "not_connected", "Connect your GitHub account first.");
  return connection;
}

/** Makes the repo the person named, then pushes every saved version as commits. */
export async function exportProduct(input: { config: GitHubConfig; owner: ConnectionOwner; product: { id: string; name: string }; name: string; isPrivate: boolean }): Promise<ExportResult> {
  const connection = await usableConnection(input.owner);
  if ("ok" in connection) return connection;
  if (await findExport(input.product.id, input.owner)) return fail(409, "already_exported", "This product already has a repo. Push the new version to it instead.");
  if (!pushableCommits(await productCommits(input.product.id)).length) return fail(409, "no_versions", "This product has no finished version with saved source yet.");
  if (!hasRepoScope(connection.scopes)) return fail(409, "reconnect", "This connection can't create repos. Connect your account again.");

  const made = await createRepo(input.config, connection.token, { name: input.name, isPrivate: input.isPrivate, description: `${input.product.name} (made with Muse Muse)` });
  if (!made.ok) {
    if (made.why === "bad_token") {
      await revokeConnection("github", input.owner);
      return fail(409, "reconnect", "GitHub no longer accepts this connection. Connect your account again.");
    }
    return made.why === "name_taken" ? fail(409, "name_taken", "You already have a repo with that name. Pick another.") : fail(502, "github_unavailable", "GitHub didn't make the repo. Try again, or download the source.");
  }
  const [row] = await db()
    .insert(schema.codeExports)
    .values({ productId: input.product.id, provider: "github", ownerKind: input.owner.kind, ownerKey: input.owner.key, externalId: connection.externalId, repoFullName: made.fullName, branch: made.branch, isPrivate: made.isPrivate })
    .onConflictDoNothing()
    .returning();
  if (!row) return fail(409, "already_exported", `This product already has a repo, so ${made.fullName} stayed empty. You can delete it on GitHub.`);
  return pushNew(input.config, row, connection, input.owner);
}

/** Pushes the versions saved since the last push, or finishes an export whose first push failed. */
export async function pushNewVersions(input: { config: GitHubConfig; owner: ConnectionOwner; productId: string }): Promise<ExportResult> {
  const connection = await usableConnection(input.owner);
  if ("ok" in connection) return connection;
  const row = await findExport(input.productId, input.owner);
  if (!row) return fail(404, "not_exported", "Export this product first.");
  if (row.externalId !== connection.externalId) return fail(409, "wrong_account", "This repo belongs to another GitHub account. Connect that account to push to it.");
  return pushNew(input.config, row, connection, input.owner);
}
