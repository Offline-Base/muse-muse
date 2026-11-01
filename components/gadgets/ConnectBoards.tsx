"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { PairBoard } from "@/components/gadgets/PairBoard";
import type { BoardView } from "@/lib/caps/hardware/store";

interface Reply {
  boards: BoardView[];
  products: Array<{ slug: string; name: string }>;
}

const STATUS: Record<BoardView["status"], string> = { ok: "Online", unreachable: "Not answering", unknown: "Not checked yet" };

async function send(url: string, method: string, body?: unknown): Promise<Record<string, unknown> & { ok: boolean }> {
  try {
    const res = await fetch(url, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    return { ...((await res.json().catch(() => ({}))) as Record<string, unknown>), ok: res.ok };
  } catch {
    return { ok: false };
  }
}

function Row({ board, products, reload, say }: { board: BoardView; products: Reply["products"]; reload: () => void; say: (line: string) => void }) {
  const id = useId();
  const [slug, setSlug] = useState("");
  const [visitors, setVisitors] = useState(false);

  async function stop(clear: boolean) {
    const reply = await send(`/api/boards/${board.id}/stop`, "POST", clear ? { clear: true } : {});
    if (!reply.ok) say(clear ? "The board didn't answer, so the hard stop stays on." : "That didn't work. Cut the board's power.");
    else if (!clear) say(reply.reachedBoard ? "Hard stop is on." : "Hard stop is saved, but the board didn't answer. Cut its power.");
    else say("Hard stop cleared.");
    reload();
  }

  return (
    <li className="small">
      <strong>{board.name}</strong> <span className="muted">{STATUS[board.status]}</span>
      {board.paired ? (
        <span className="muted">
          {" "}
          {board.paired.target}
          {board.paired.simulated ? ", simulated board" : ""}
        </span>
      ) : null}
      {board.products.map((p) => (
        <div key={p.slug} className="row-actions">
          <span>
            {p.name}: {p.visitors ? "you and visitors" : "you only"}
          </span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void send(`/api/products/${encodeURIComponent(p.slug)}/board`, "DELETE").then(reload)}>
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
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={!slug}
          onClick={() =>
            void send(`/api/products/${encodeURIComponent(slug)}/board`, "POST", { boardId: board.id, visitors }).then(() => {
              setSlug("");
              setVisitors(false);
              reload();
            })
          }
        >
          Link
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void send(`/api/boards/${board.id}`, "DELETE").then(reload)}>
          Remove
        </button>
        {board.paired?.simulated ? (
          board.paired.stopped ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void stop(true)}>
              Clear hard stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void stop(false)}>
              Hard stop
            </button>
          )
        ) : null}
      </div>
    </li>
  );
}

/** A signed-in person's boards on /gadgets, with GADGET_CONNECT on. Status words only: never an address or a token. */
export function ConnectBoards() {
  const [reply, setReply] = useState<Reply | null>(null);
  const [line, setLine] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/boards", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setReply((await res.json()) as Reply);
    else setLine("Your boards can't be shown right now.");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once from the server.
    void load();
  }, [load]);

  return (
    <section className="card section-card" aria-labelledby="boards-title">
      <h2 id="boards-title">Your boards</h2>
      <p className="muted small">
        A paired board belongs to your account. A product reaches it only after you link it, and only you can use it there unless you open it to visitors. Each board kind is set to one model: one-bit Muse Glimmer on a Jetson Orin Nano, a small Llama on anything else. Neither has been measured on a real board yet.
      </p>
      <p className="muted small">Robot actions run on simulated boards only for now. You confirm every action on Muse Muse, and the hard stop needs no confirmation.</p>
      {line ? (
        <p className="note" role="status">
          {line}
        </p>
      ) : null}
      {reply?.boards.length ? (
        <ul>
          {reply.boards.map((b) => (
            <Row key={b.id} board={b} products={reply.products} reload={() => void load()} say={setLine} />
          ))}
        </ul>
      ) : reply ? (
        <p className="small muted">You haven&apos;t paired a board yet.</p>
      ) : null}
      <PairBoard onPaired={() => void load()} />
    </section>
  );
}
