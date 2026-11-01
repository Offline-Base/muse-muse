"use client";

import { type FormEvent, useId, useState } from "react";
import { Icon } from "@/components/icons";

const ERRORS: Record<string, string> = {
  unsafe_address: "That address can't carry a board's token. It needs https, and on this hosted site, a public address.",
  board_unreachable: "The board didn't answer. Check that server.py is running with --tls and that the address is right.",
  key_missing: "HARDWARE_BOARD_KEY isn't set, so boards can't be saved on this site.",
  invalid_name: "Give the board a name of up to 60 characters.",
  invalid_code: "The code is 8 letters and numbers, from the board's screen.",
  wrong_code: "That code is wrong or used up. Run the pair command on the board again for a new one.",
  pair_expired: "That took too long. Start again.",
  not_a_board: "Something answered, but it isn't a muse-device board.",
  too_many_boards: "You have the most boards allowed. Remove one first.",
  too_many_tries: "Too many tries. Wait an hour, then try again.",
};

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { error: "unreachable" } };
  }
}

const problem = (data: Record<string, unknown>) => ERRORS[String(data.error)] ?? (typeof data.error === "string" && data.error.includes(" ") ? data.error : "That didn't work. Try again.");

/** Pairs a person's own board: an address, then the check number to compare, then the board's one-time code. */
export function PairBoard({ onPaired }: { onPaired: () => void }) {
  const id = useId();
  const [ticket, setTicket] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const [matches, setMatches] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setDone(null);
    const { ok, data } = await post("/api/boards/pair", { address: new FormData(event.currentTarget).get("address") });
    setBusy(false);
    setError(ok ? null : problem(data));
    if (ok) {
      setTicket(String(data.ticket));
      setCheck(String(data.checkNumber));
      setMatches(false);
    }
  }

  async function finish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const { ok, data } = await post("/api/boards/pair/finish", { ticket, code: form.get("code"), name: form.get("name"), confirmed: matches });
    setBusy(false);
    setError(ok ? null : problem(data));
    if (ok) {
      setTicket(null);
      setDone(`Paired. It runs ${String(data.target)}${data.simulated ? ", simulated" : ""}. Link it to one of your products below.`);
      onPaired();
    }
  }

  return (
    <div>
      <h3 id={`${id}-title`}>Pair a board</h3>
      {error ? (
        <p className="note train-callout-warn" role="alert">
          {error}
        </p>
      ) : null}
      {done ? <p className="note">{done}</p> : null}
      {!ticket ? (
        <form onSubmit={(e) => void start(e)}>
          <p className="muted small">
            On your board, start <code>python3 server.py --tls</code>, then run <code>python3 server.py pair</code>. It prints a code and a check number.
          </p>
          <label className="field-label" htmlFor={`${id}-address`}>
            Board address
          </label>
          <input id={`${id}-address`} name="address" required placeholder="my-board.example:8765" autoComplete="off" />
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" aria-hidden /> : <Icon name="plug" size={16} />}
              <span>Find the board</span>
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => void finish(e)}>
          <p>
            Check number here: <strong className="pair-check">{check}</strong>
          </p>
          <label>
            <input type="checkbox" checked={matches} onChange={(e) => setMatches(e.target.checked)} /> The board shows the same number
          </label>
          <p className="muted small">If they differ, stop: something between you and the board may be pretending to be it.</p>
          <label className="field-label" htmlFor={`${id}-code`}>
            Code from the board
          </label>
          <input id={`${id}-code`} name="code" required maxLength={8} autoComplete="off" autoCapitalize="characters" />
          <label className="field-label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input id={`${id}-name`} name="name" required maxLength={60} autoComplete="off" />
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !matches}>
              {busy ? <span className="spinner" aria-hidden /> : <Icon name="plug" size={16} />}
              <span>Pair</span>
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setTicket(null)}>
              Start over
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
