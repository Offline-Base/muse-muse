"use client";

import Link from "next/link";
import { useId } from "react";
import { Icon } from "@/components/icons";
import type { QuantLevel } from "@/lib/train/local-files";
import {
  DOWNLOAD_SPEEDS,
  LONG_DOWNLOAD_MINUTES,
  diskNeedGb,
  downloadMinutes,
  downloadText,
  gbText,
  mbpsText,
  speedText,
  type Verdict,
} from "@/lib/vibe/device";

/** Where Try it live is: open on this page right now, or on the model's page while a live demo runs. */
export interface TryLiveWhere {
  open: boolean;
  modelHref: string;
}

export interface VerdictCardProps {
  /** The verdict for the build being set up, or null until the person confirms their memory. */
  verdict: Verdict | null;
  /** The build pickBuild chose, which the list marks as picked. */
  pickedLevel: QuantLevel | null;
  /** Every build rated for this computer, smallest first. */
  rated: Verdict[] | null;
  onLevel: (level: QuantLevel) => void;
  mbps: number;
  onMbps: (mbps: number) => void;
  diskOk: boolean;
  onDiskOk: (ok: boolean) => void;
  live: TryLiveWhere;
  /** The flash drive request for this model, offered on a long download (Feature 6), or null while drives are off. */
  driveHref?: string | null;
  /** False on the flash drive request, where the download's time, the other builds and the free disk don't apply. */
  download?: boolean;
}

const FIT_LABEL: Record<Verdict["fit"], string> = {
  well: "Runs well",
  tight: "Close other apps",
  slow: "Slow",
  no: "Too big here",
};

const WHERE_TEXT: Record<NonNullable<Verdict["where"]>, string> = {
  gpu: "",
  split: ", with part of it on the processor",
  cpu: ", on the processor",
};

export function TryLiveNote({ live }: { live: TryLiveWhere }) {
  return (
    <div className="vibe-trylive">
      <span className="vibe-trylive-icon" aria-hidden>
        <Icon name="play" size={16} />
      </span>
      <p>
        {live.open ? (
          <>
            Try it live is open on this page right now: <a href="#try-live">ask both models</a> from your browser.
          </>
        ) : (
          <>
            No live demo is running right now. <Link href={live.modelHref}>The model&apos;s page</Link> shows how it
            answered its test prompts, and Try it live opens there while a demo runs.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The verdict (docs/VIBE_TUNING.md, Features 2 and 5): "Runs well", "Runs slowly" or "Won't run here", with the build,
 * a speed range and the download time at a speed the person can change, with the flash drive offered when that is long
 * and drives are on. The other builds that run are offered too, then the box for free disk. When it won't run, or runs
 * only on the processor, Try it live is the way.
 */
export function VerdictCard({ verdict, pickedLevel, rated, onLevel, mbps, onMbps, diskOk, onDiskOk, live, driveHref = null, download = true }: VerdictCardProps) {
  const id = useId();
  const file = verdict?.file ?? null;
  const tone = !verdict ? "wait" : verdict.fit === "well" ? "ok" : verdict.fit === "no" ? "bad" : "warn";
  const long = file ? downloadMinutes(file.bytes, mbps) > LONG_DOWNLOAD_MINUTES : false;
  const runs = (rated ?? []).filter((v) => v.file);

  return (
    <section className="card section-card vibe-verdict" aria-labelledby={`${id}-title`}>
      <div className="vibe-verdict-head">
        <span className={`vibe-verdict-icon vibe-tone-${tone}`} aria-hidden>
          <Icon name={tone === "bad" ? "alert" : tone === "wait" ? "monitor" : "check"} size={20} />
        </span>
        <div>
          <p className="vibe-eyebrow">Will it run?</p>
          <h2 id={`${id}-title`} aria-live="polite">
            {verdict ? verdict.title : "Confirm your memory to see"}
          </h2>
        </div>
      </div>

      {!verdict ? (
        <p className="muted">
          Once you confirm how much memory your computer has, this says which build fits
          {download ? ", about how fast it answers and how long the download takes." : " and about how fast it answers."}
        </p>
      ) : (
        <>
          <p className="vibe-verdict-why">{verdict.why}</p>
          {file ? (
            <>
              <dl className="kv">
                <div>
                  <dt>Build</dt>
                  <dd>
                    {file.level} · {gbText(file.bytes)} file · about {Math.round(verdict.needGb ?? 0)} GB in use
                  </dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>
                    {verdict.speed ? speedText(verdict.speed) : "Depends on the card"}
                    {verdict.where ? WHERE_TEXT[verdict.where] : ""}
                  </dd>
                </div>
                {download ? (
                  <div>
                    <dt>Download</dt>
                    <dd className="vibe-download">
                      <span>{downloadText(file.bytes, mbps)}</span>
                      <select
                        className="select"
                        aria-label="Your connection's speed"
                        value={mbps}
                        onChange={(e) => onMbps(Number(e.target.value))}
                      >
                        {DOWNLOAD_SPEEDS.map((s) => (
                          <option key={s} value={s}>
                            {mbpsText(s)}
                          </option>
                        ))}
                      </select>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {verdict.measured ? <p className="train-help">{verdict.measured}</p> : null}
              {download && long ? (
                <p className="train-help">
                  That&apos;s a long download. Start it when the computer can stay on and plugged in
                  {driveHref ? (
                    <>
                      , or <Link href={driveHref}>get it on a flash drive</Link> instead
                    </>
                  ) : null}
                  .
                </p>
              ) : null}

              {download && runs.length > 1 ? (
                <fieldset className="vibe-field">
                  <legend className="train-label">Builds that run here</legend>
                  <div className="vibe-builds">
                    {(rated ?? []).map((v) => {
                      const f = v.file;
                      if (!f) return null;
                      return (
                        <label key={f.level} className="vibe-build">
                          <input type="radio" name={`${id}-build`} checked={file.level === f.level} onChange={() => onLevel(f.level)} />
                          <span className="vibe-build-name">{f.level}</span>
                          <span className="vibe-build-size">{gbText(f.bytes)}</span>
                          <span className="vibe-build-fit">
                            {FIT_LABEL[v.fit]}
                            {f.level === pickedLevel ? " · picked for you" : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ) : null}

              {download ? (
                <label className="vibe-check">
                  <input type="checkbox" checked={diskOk} onChange={(e) => onDiskOk(e.target.checked)} />
                  <span>I have at least {diskNeedGb(file)} GB free on this computer: the file plus 5 GB.</span>
                </label>
              ) : null}
            </>
          ) : null}
          {verdict.tryLive ? <TryLiveNote live={live} /> : null}
        </>
      )}
    </section>
  );
}
