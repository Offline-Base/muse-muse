"use client";

import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/icons";
import type { BoardView } from "@/lib/caps/hardware/store";

const ERRORS: Record<string, string> = {
  invalid_name: "Give the board a name of up to 60 characters.",
  invalid_token: "That token is too short. It's the one in ~/.muse-device/token on the board, 32 characters or more.",
  unsafe_address: "The address must be https and public, with nothing after the path. A token can't travel anywhere else.",
  board_unreachable: "The board didn't answer. Check that its server and tunnel are up, and that the token is right.",
  not_a_board: "Something answered, but it isn't a muse-device board.",
  too_many_boards: "You have the most boards allowed. Remove one first.",
  key_missing: "HARDWARE_BOARD_KEY isn't set, so boards can't be saved on this site.",
  board_not_found: "That board isn't there any more.",
  not_your_product: "You can link a board only to your own product.",
};

const STATUS: Record<BoardView["status"], string> = { ok: "Online", unreachable: "Not answering", unknown: "Not checked yet" };

interface Reply {
  boards: BoardView[];
  products: Array<{ slug: string; name: string }>;
}

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (res.ok) return null;
    const failure = (await res.json().catch(() => ({}))) as { error?: string };
    return ERRORS[failure.error ?? ""] ?? "That didn't work. Try again.";
  } catch {
    return "Muse Muse couldn't be reached. Try again.";
  }
}

/** One board's row: its status, its links, and linking it to one of the admin's products. */
function BoardRow({ board, products, onChange }: { board: BoardView; products: Reply["products"]; onChange: (error: string | null) => void }) {
  const id = useId();
  const [slug, setSlug] = useState("");
  const [visitors, setVisitors] = useState(false);

  async function link() {
    if (!slug) return;
    onChange(await send(`/api/products/${encodeURIComponent(slug)}/board`, "POST", { boardId: board.id, visitors }));
    setSlug("");
    setVisitors(false);
  }

  return (
    <li className="small">
      <strong>{board.name}</strong> <span className="muted">{STATUS[board.status]}</span>
      {board.products.map((p) => (
        <div key={p.slug} className="row-actions">
          <span>
            {p.name}: {p.visitors ? "the owner and visitors" : "the owner only"}
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={async () => onChange(await send(`/api/products/${encodeURIComponent(p.slug)}/board`, "DELETE"))}>
            Unlink
          </button>
        </div>
      ))}
      <div className="row-actions">
        <label className="field-label" htmlFor={`${id}-product`}>
          Link to
        </label>
        <select id={`${id}-product`} className="train-select" value={slug} onChange={(e) => setSlug(e.target.value)}>
          <option value="">Pick one of your products</option>
          {products.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={visitors} onChange={(e) => setVisitors(e.target.checked)} /> Visitors can use it too
        </label>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void link()} disabled={!slug}>
          Link
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={async () => onChange(await send(`/api/boards/${board.id}`, "DELETE"))}>
          Remove
        </button>
      </div>
    </li>
  );
}

/**
 * Admins add their own muse-device boards here (docs/CAPABILITIES.md, section 19, decision 16). The address and token go to
 * the server once, sealed there, and never come back to a browser.
 */
export function DeviceBoards() {
  const id = useId();
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/boards", { cache: "no-store" });
      if (res.ok) setReply((await res.json()) as Reply);
      else setError("Your boards can't be shown right now.");
    } catch {
      setError("Your boards can't be shown right now.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once from the server.
    void load();
  }, [load]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    const problem = await send("/api/boards", "POST", { name: data.get("name"), mcpUrl: data.get("mcpUrl"), token: data.get("token") });
    setBusy(false);
    setError(problem);
    if (!problem) {
      form.reset();
      await load();
    }
  }

  async function changed(problem: string | null) {
    setError(problem);
    await load();
  }

  return (
    <section className="card section-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Your boards</h2>
      <p className="muted small">A product reaches a board only after you link it, and only you can use it there unless you open it to visitors. To use it yourself, open the product with Open as owner on its Muse Muse page, in its own tab.</p>
      <p className="muted small">Opening a board to visitors also lets them use its camera and microphone, if the product uses those. A product that only takes photos or records sound, with no board tools, can&apos;t tell that it&apos;s you, so it needs visitors on to reach the board at all.</p>
      {error ? (
        <p className="note train-callout-warn" role="alert">
          {error}
        </p>
      ) : null}
      {reply?.boards.length ? (
        <ul>
          {reply.boards.map((b) => (
            <BoardRow key={b.id} board={b} products={reply.products} onChange={(problem) => void changed(problem)} />
          ))}
        </ul>
      ) : reply ? (
        <p className="small muted">You haven&apos;t added a board yet.</p>
      ) : null}
      <form onSubmit={(e) => void add(e)}>
        <label className="field-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input id={`${id}-name`} name="name" required maxLength={60} autoComplete="off" />
        <label className="field-label" htmlFor={`${id}-url`}>
          Board address
        </label>
        <input id={`${id}-url`} name="mcpUrl" type="url" required placeholder="https://your-tunnel.example/mcp" autoComplete="off" />
        <label className="field-label" htmlFor={`${id}-token`}>
          Board token
        </label>
        <input id={`${id}-token`} name="token" type="password" required minLength={32} autoComplete="off" />
        <p className="muted small">The muse-device token from ~/.muse-device/token on the board. Never a Gadget SDK token: this form doesn&apos;t take those.</p>
        <div className="row-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="plug" size={16} />}
            <span>Check and add</span>
          </button>
        </div>
      </form>
    </section>
  );
}
