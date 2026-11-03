import { caveatsFor, reportColumns, reportRows } from "@/lib/train/sam/logic";
import type { SamReport as SamReportData } from "@/lib/train/sam/types";

/** What a report page shows: the whole report, or the public one without the worker's name. */
export type SamReportShown = Omit<SamReportData, "workerId"> & { workerId?: string };

const isShowableImage = (i: SamReportShown["images"][number]) => Boolean(i?.url) && (i.license === null || Boolean(i.credit));

/**
 * A SAM 3.1 tune run's report (SAM_TUNE), in the Meta AI app look of the Nov 3 report.html: the verdict line the server
 * wrote (lib/train/sam/logic.ts verdictFor), the column table (Meta's SAM 3.1 asked the new word, the generic words and
 * "toy", the Nov 3 tune when scored, then the tune) with each row's single best value in blue, the side by sides with
 * their credits, the caveats, which always show, and links to the board's scores.json and per_image.json. Only numbers
 * come from the board; every sentence here is written by the server or this file.
 */
export function SamReport({ report, heading = true }: { report: SamReportShown; heading?: boolean }) {
  const columns = reportColumns(report);
  const rows = reportRows(report);
  const tuned = report.settings.tuned_word;
  const images = report.images.filter(isShowableImage);
  const w = report.word;
  // The caveats always show: a report saved without them gets the server's standing ones.
  const caveats = report.caveats?.length ? report.caveats : caveatsFor(report);
  return (
    <section className="sam-report" aria-label={`Report: teaching SAM 3.1 "${w}"`}>
      {heading ? (
        <>
          <h2 className="sam-title">
            SAM 3.1, tuned on a Jetson, asked &quot;{w}&quot;
            <span className="sam-ai">AI</span>
          </h2>
          <p className="sam-sub">
            {tuned
              ? `Set B: ${tuned.B.n} photos with ${w} among other things. Set A: ${tuned.A.n} photos with no ${w}.`
              : `Meta's SAM 3.1 against the tune.`}
            {report.setsSource === "nov3" ? " The same test photos as the Nov 3 run." : ""}
          </p>
        </>
      ) : null}

      <div className="sam-card sam-verdict" data-verdict={report.verdict.code}>
        <p className="sam-verdict-label">Verdict</p>
        <p className="sam-verdict-text">{report.verdict.text}</p>
      </div>

      <div className="sam-card">
        <div className="sam-table-wrap">
          <table className="sam-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">What it measures</span>
                </th>
                {columns.map((c) => (
                  <th key={c.id} scope="col" data-col={c.id} className={c.id === "tuned_word" ? "sam-tuned" : undefined}>
                    {c.weights}
                    <span>{c.prompt}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-row={r.key}>
                  <th scope="row">{r.label}</th>
                  {r.cells.map((cell, i) => {
                    const col = columns[i]!.id;
                    const cls = [col === "tuned_word" ? "sam-tuned" : "", cell.best ? "is-best" : ""].filter(Boolean).join(" ");
                    return (
                      <td key={col} data-col={col} className={cls || undefined}>
                        {cell.text}
                        {cell.best ? <span className="sr-only"> (best)</span> : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sam-note">
          Blue marks the single best value in each row; a tie gets none. For &quot;Fires on photos with no {w}&quot;, fewer is
          better. Meta&apos;s SAM 3.1 asked &quot;{w}&quot; is never marked: the word is new to it.{" "}
          {report.apFrom === 0.5
            ? "AP counts only boxes scored 0.5 or more (the service kept no lower ones), so it is a lower bound."
            : `AP counts every box scored ${report.apFrom} or more.`}
        </p>
      </div>

      {images.length ? (
        <div className="sam-card">
          <h3 className="sam-card-title">Side by side</h3>
          {images.map((image) => (
            <figure key={image.url} className="sam-sbs" data-rule={image.rule}>
              {/* A board-drawn picture from this run's own uploads (checked on the server). next/image would need the host set up. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt={image.caption} loading="lazy" />
              <figcaption>
                {image.caption}
                {image.credit ? <span className="sam-credit">{image.credit}</span> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      <div className="sam-card">
        <h3 className="sam-card-title">What this does and doesn&apos;t show</h3>
        <ul className="sam-caveats">
          {caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>

      <p className="sam-links">
        <a href={report.files.scores} target="_blank" rel="noreferrer">
          Scores (scores.json)
        </a>
        <a href={report.files.perImage} target="_blank" rel="noreferrer">
          Per photo (per_image.json)
        </a>
      </p>
    </section>
  );
}
