"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usd } from "@/lib/format";
import { runEstimateUsd, type PartnerOffers } from "@/lib/train/partner/logic";
import type { PartnerProvider } from "@/lib/train/types";

/**
 * PARTNER_EVALS, admins only: pick one partner, several or all, see each one's most at list price and why one can't go,
 * then start them in turn (POST /api/train/jobs/{id}/partner-eval with providers). It reads and starts through Muse
 * Muse's own route only, so no provider's address or key reaches the page. With the flag off the route answers 404 and
 * this shows nothing.
 */
export function PartnerEvalPicker({ jobId, hostTuned = false, onStarted }: { jobId: string; hostTuned?: boolean; onStarted?: () => void }) {
  const route = `/api/train/jobs/${jobId}/partner-eval`;
  const [offers, setOffers] = useState<PartnerOffers | null>(null);
  const [picked, setPicked] = useState<PartnerProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    fetch(route, { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { offers?: PartnerOffers | null }) : null))
      .then((body) => {
        if (gone || !body?.offers) return;
        setOffers(body.offers);
        setPicked(body.offers.offers.filter((o) => o.available && !o.done).map((o) => o.provider));
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [route]);

  if (!offers || !offers.offers.length) return null;
  const chosen = offers.offers.filter((o) => picked.includes(o.provider) && o.available);
  const most = runEstimateUsd(chosen, offers.runMaxUsd);

  async function start() {
    if (!chosen.length || busy) return;
    setBusy(true);
    setSaid(null);
    try {
      const res = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers: chosen.map((o) => o.provider), ...(chosen.some((o) => o.done) ? { again: true } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as { reason?: unknown } | null;
      if (!res.ok) {
        setSaid(typeof body?.reason === "string" ? body.reason : "That didn't start. Try again.");
        return;
      }
      setSaid(`Started on ${chosen.map((o) => o.label).join(", then ")}. Each one's card shows here as it goes.`);
      onStarted?.();
    } catch {
      setSaid("Couldn't reach Muse Muse. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tune-partner-pick">
      <p>
        <strong>Evaluate on partners</strong>
      </p>
      <p className="muted small">
        Each partner hosts the tuned model on its own GPU, answers the same held-out prompts, and is torn down before judging. They run one after another, each stopped by
        its own stop time. Each is at most {usd(offers.maxUsd)}
        {offers.runMaxUsd !== null ? `, and a run of several at most ${usd(offers.runMaxUsd)} in all` : ""}, at list prices.
      </p>
      <ul className="link-list">
        {offers.offers.map((o) => (
          <li key={o.provider}>
            <label>
              <input
                type="checkbox"
                disabled={!o.available || busy}
                checked={o.available && picked.includes(o.provider)}
                onChange={(e) => setPicked((now) => (e.target.checked ? [...now, o.provider] : now.filter((p) => p !== o.provider)))}
              />{" "}
              {o.label}
            </label>{" "}
            <span className="muted small">
              {o.available
                ? `${o.gpu ?? "GPU"} at about ${usd(o.hourlyUsd ?? 0)} an hour, stops within ${o.minutes} minutes, at most ${usd(o.maxUsd ?? 0)}.${o.baseFromJob ? " Only the tuned model runs there; the base answers are the job's own." : ""}${o.done ? " Already evaluated: picking it runs it again." : ""}`
                : `Can't go there: ${o.reason}`}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" disabled={!chosen.length || busy} onClick={start}>
        {busy ? "Starting" : chosen.length > 1 ? `Evaluate on ${chosen.length} partners, at most ${usd(most)}` : chosen.length ? `Evaluate on ${chosen[0]!.label}, at most ${usd(most)}` : "Pick a partner"}
      </button>
      {said ? (
        <p role="status" className="muted small">
          {said}
        </p>
      ) : null}
      {hostTuned ? (
        <p className="muted small">
          To host it for a demo without an eval, use Run it on <Link href={`/models/${jobId}#run-it-title`}>its model page</Link>: pick the partner and how long it stays up.
        </p>
      ) : null}
    </div>
  );
}
