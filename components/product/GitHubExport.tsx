"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GitHubExportView } from "@/lib/github/view";

const NOTICES: Record<string, string> = {
  connected: "GitHub is connected.",
  denied: "GitHub wasn't connected, because the request was declined.",
  failed: "GitHub didn't finish connecting. Try again.",
  scope: "GitHub didn't grant repo access, so nothing was connected.",
  signin: "Sign in to connect GitHub.",
  off: "GitHub export isn't set up on this site yet.",
};

const GUEST_NOTE = "You're a guest, so this connection belongs to this browser alone. Clearing its cookies ends your access to it here.";

/** Connect GitHub, name a repo, push. The token never reaches this page: every step is a server call. */
export function GitHubExport({ slug, defaultName, view, notice }: { slug: string; defaultName: string; view: GitHubExportView; notice: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/products/${slug}/github-export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as { message?: string; pushed?: number; skipped?: number; repo?: string; upToDate?: boolean };
      if (!res.ok) setError(data.message ?? "That didn't work. Try again, or download the source.");
      else if (data.upToDate) setMessage("This repo already has every saved version.");
      else setMessage(`Pushed ${data.pushed === 1 ? "1 version" : `${data.pushed} versions`} to ${data.repo}.${data.skipped ? ` ${data.skipped} older ${data.skipped === 1 ? "version was" : "versions were"} too big to include.` : ""}`);
      router.refresh();
    } catch {
      setError("That didn't finish. Check GitHub before trying again, or download the source.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!isPrivate && !window.confirm("Anyone will be able to read this repo and every saved version in it. Known key formats are held back, but a password typed into the code would be readable. Make it public?")) return;
    await send({ action: "create", name: name.trim(), private: isPrivate });
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/connect/github/disconnect", { method: "POST" });
      const data = (await res.json()) as { revokedOnGitHub?: boolean };
      if (!res.ok) setError("That didn't save. Try again.");
      else {
        setMessage(data.revokedOnGitHub ? "Disconnected, and GitHub's access is ended." : "Disconnected here. To be sure, also remove Muse Muse under Applications in your GitHub settings.");
        router.refresh();
      }
    } catch {
      setError("That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const noticeText = (notice && NOTICES[notice]) || null;

  return (
    <section className="code-github" aria-label="GitHub">
      <h2 className="panel-label">GitHub</h2>
      {noticeText && !message && !error ? <p role="status">{noticeText}</p> : null}
      {view.state === "not_set_up" ? <p className="muted">GitHub export isn&apos;t set up on this site yet. Download source still works.</p> : null}
      {view.state === "sign_in" ? <p className="muted">Sign in to export this code to GitHub. Download source still works.</p> : null}
      {view.state === "connect" ? (
        <>
          <p className="muted">Connect your account to put this code in a repo of your own, with every saved version as a commit. GitHub will ask for access to your repositories, since that is the only way to make a private one. This site writes only to repos it makes for you.</p>
          {view.guest ? <p className="muted small">{GUEST_NOTE}</p> : null}
          <div className="code-actions">
            <a className="btn" href={`/api/connect/github/start?slug=${slug}`}>
              Connect GitHub
            </a>
          </div>
        </>
      ) : null}
      {view.state === "connected" ? (
        <>
          <p className="muted">
            Connected as <strong>{view.login}</strong>.{" "}
            <button type="button" className="btn" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </p>
          {view.guest ? <p className="muted small">{GUEST_NOTE}</p> : null}
          {view.exported ? (
            <>
              <p>
                <a href={view.exported.url} target="_blank" rel="noreferrer">
                  {view.exported.repo}
                </a>{" "}
                <span className="muted small">
                  {view.exported.isPrivate ? "Private" : "Public"}
                  {view.exported.lastVersion ? ` · has version ${view.exported.lastVersion}` : " · nothing pushed yet"}
                </span>
              </p>
              {!view.exported.sameAccount ? (
                <p className="muted small">This repo belongs to another GitHub account. Connect that account to push to it.</p>
              ) : view.exported.newVersions > 0 ? (
                <div className="code-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => send({ action: "push" })}>
                    {busy ? "Pushing..." : `Push ${view.exported.newVersions === 1 ? "new version" : `${view.exported.newVersions} new versions`}`}
                  </button>
                </div>
              ) : (
                <p className="muted small">Every saved version is there.</p>
              )}
            </>
          ) : view.ready === 0 ? (
            <p className="muted small">There&apos;s no finished version with saved source to export yet.</p>
          ) : (
            <div className="code-github-form">
              <label>
                <span>Repo name</span>
                <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="code-github-check">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                <span>Private</span>
              </label>
              <button type="button" className="btn" disabled={busy || !name.trim()} onClick={create}>
                {busy ? "Exporting..." : "Export to GitHub"}
              </button>
            </div>
          )}
        </>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="code-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
