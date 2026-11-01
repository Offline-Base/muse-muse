/** What the Code page shows about GitHub. Never holds a token. */
import type { SessionUser } from "@/lib/auth";
import { currentConnectionOwner } from "@/lib/connected/owner";
import { findConnection } from "@/lib/connected/store";
import { githubConfig } from "@/lib/github/api";
import { findExport, pushableCommits } from "@/lib/github/export";
import type { Commit } from "@/lib/versions/policy";

export type GitHubExportView =
  | { state: "not_set_up" }
  | { state: "sign_in" }
  | { state: "connect"; guest: boolean }
  | { state: "connected"; guest: boolean; login: string; ready: number; exported: null | { repo: string; url: string; isPrivate: boolean; lastVersion: number | null; newVersions: number; sameAccount: boolean } };

export async function githubExportView(user: SessionUser | null, productId: string, commits: readonly Commit[]): Promise<GitHubExportView> {
  const config = githubConfig();
  if (!config) return { state: "not_set_up" };
  if (!user) return { state: "sign_in" };
  const guest = Boolean(user.openAccess);
  const owner = await currentConnectionOwner(user);
  const connection = owner ? await findConnection("github", owner) : null;
  if (!owner || !connection) return { state: "connect", guest };
  const ready = pushableCommits(commits);
  const row = await findExport(productId, owner);
  return {
    state: "connected",
    guest,
    login: connection.externalLogin,
    ready: ready.length,
    exported: row && {
      repo: row.repoFullName,
      url: `${config.webUrl}/${row.repoFullName}`,
      isPrivate: row.isPrivate,
      lastVersion: row.lastVersionNumber,
      newVersions: ready.filter((c) => row.lastVersionNumber === null || c.number > row.lastVersionNumber).length,
      sameAccount: row.externalId === connection.externalId,
    },
  };
}
