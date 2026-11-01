import { LongText } from "@/components/train/LongText";
import {
  calibrationText,
  decisionHeadline,
  decisionNotes,
  decisionSummaryText,
  eceText,
  intervalText,
  labelName,
  percentText,
  reliabilityPoints,
  twoPlaces,
  type DecisionState,
  type WrongAnswer,
} from "@/components/train/format";
import { groupThousands, plural } from "@/lib/format";
import type { DecisionSideSummary, DecisionSummary } from "@/lib/decide/types";

/*
 * A decide job's results (docs/DECISION_MODELS.md "The results page"): the strip, per label scores, the confusion
 * matrix, the reliability chart, the baselines and the health numbers, and for admins only, the test rows the model
 * missed. No hooks, so the public result page renders it on the server and the admin job page in the browser. The
 * public page passes no `wrong`: a person's inputs may be private, so it shows numbers only.
 */

export interface WrongAnswers {
  /** Whose misses these are: the tuned model's, or base Glimmer's for a job that scored only the base. */
  model: "tuned" | "base";
  total: number;
  shown: WrongAnswer[];
}

export interface DecisionResultsProps {
  summary: DecisionSummary;
  /** False for a job that didn't succeed: its numbers are only the scores its GPU sent before it stopped. */
  succeeded?: boolean;
  /** The dataset's train rows, for the sentence on what the tuned model learned from. */
  trainRows?: number | null;
  /** Admins only: the test rows the model missed, with their inputs. */
  wrong?: WrongAnswers | null;
}

type Side = { name: string; key: "tuned" | "base"; s: DecisionSideSummary };

/** A side as a sentence names it mid-line: "tuned", "base Glimmer". */
const inLine = (side: Side) => (side.key === "tuned" ? "tuned" : "base Glimmer");

function sidesOf(summary: DecisionSummary): Side[] {
  const base: Side = { name: "Base Glimmer", key: "base", s: summary.base };
  return summary.tuned ? [{ name: "Tuned", key: "tuned", s: summary.tuned }, base] : [base];
}

export function DecisionResults({ summary: s, succeeded = true, trainRows = null, wrong = null }: DecisionResultsProps) {
  const sides = sidesOf(s);
  return (
    <section className="train-eval decide-results" id="decision-results" aria-labelledby="decide-results-title">
      <div className="train-log-head">
        <h2 id="decide-results-title">Decision results</h2>
        <span className="muted small">
          {plural(s.testRows, "held-out test row")} · scored, no judge
        </span>
      </div>
      <p className="sr-only">{decisionSummaryText(s)}</p>
      <Strip summary={s} sides={sides} succeeded={succeeded} trainRows={trainRows} />
      <PerLabel summary={s} sides={sides} />
      <Confusion summary={s} sides={sides} />
      <Reliability summary={s} sides={sides} />
      <Baselines summary={s} sides={sides} />
      <Health summary={s} sides={sides} />
      {wrong ? <WrongList summary={s} wrong={wrong} /> : null}
    </section>
  );
}

/**
 * The admin job page's results for a decide job: a line while the GPU runs or scoring is under way, why there are no
 * numbers, or the results.
 */
export function DecisionStatus({
  state,
  succeeded,
  trainRows = null,
  wrong = null,
}: {
  state: DecisionState;
  succeeded: boolean;
  trainRows?: number | null;
  wrong?: WrongAnswers | null;
}) {
  if (state.state === "scored") return <DecisionResults summary={state.summary} succeeded={succeeded} trainRows={trainRows} wrong={wrong} />;
  return (
    <section className="train-eval decide-results" id="decision-results" aria-labelledby="decide-results-title">
      <div className="train-log-head">
        <h2 id="decide-results-title">Decision results</h2>
      </div>
      <div aria-live="polite">
        {state.state === "running" ? (
          <p className="muted small">
            The GPU scores base Glimmer on the dev and test rows, trains, then scores the tuned model on the same rows. The
            numbers show here once its GPU shuts down.
          </p>
        ) : state.state === "scoring" ? (
          <p className="turn turn-working train-working">
            <span className="working-dot" aria-hidden />
            <span>Scoring...</span>
            <span className="muted">no judge, nothing spent</span>
          </p>
        ) : (
          <p className="muted small">{state.reason}</p>
        )}
      </div>
    </section>
  );
}

function Strip({ summary: s, sides, succeeded, trainRows }: { summary: DecisionSummary; sides: Side[]; succeeded: boolean; trainRows: number | null }) {
  const main = sides[0]!;
  const notes = decisionNotes(s, { trainRows, succeeded });
  return (
    <div className="card totals decide-strip">
      <div className="decide-tiles">
        {sides.map((side) => (
          <div className="decide-tile" key={side.key}>
            <p className="decide-tile-label">
              <span className={`decide-swatch decide-swatch-${side.key}`} aria-hidden />
              {side.key === "tuned" ? "Tuned accuracy" : "Base Glimmer accuracy"}
            </p>
            <p className="stat-num">{percentText(side.s.accuracy.rate)}</p>
            <p className="stat-sub">
              {groupThousands(side.s.accuracy.right)} of {groupThousands(side.s.accuracy.total)} · 95% interval{" "}
              {intervalText(side.s.accuracy)}
            </p>
          </div>
        ))}
        <div className="decide-tile">
          <p className="decide-tile-label">Macro F1</p>
          <p className="stat-num">{twoPlaces(main.s.macroF1)}</p>
          <p className="stat-sub">
            {s.tuned ? `base ${twoPlaces(s.base.macroF1)} · ` : ""}each label counts the same
          </p>
        </div>
        <div className="decide-tile">
          <p className="decide-tile-label">Calibration error</p>
          <p className="stat-num">{eceText(main.s.ece.withT)}</p>
          <p className="stat-sub">
            {eceText(main.s.ece.raw)} before T = {main.s.T.toFixed(2)}
          </p>
        </div>
      </div>
      <p className="train-eval-sub">{decisionHeadline(s)}</p>
      <p className="muted small">{calibrationText(main.s, s.devRows)}</p>
      <ul className="decide-notes">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

function PerLabel({ summary: s, sides }: { summary: DecisionSummary; sides: Side[] }) {
  const main = sides[0]!;
  const other = sides[1] ?? null;
  const pair = (pick: (x: DecisionSideSummary["perLabel"][number]) => number, i: number) => (
    <>
      <strong>{twoPlaces(pick(main.s.perLabel[i]!))}</strong>
      {other && other.s.perLabel[i] ? <span className="muted"> · {twoPlaces(pick(other.s.perLabel[i]!))}</span> : null}
    </>
  );
  return (
    <section className="section" aria-labelledby="decide-labels-title">
      <div className="section-head">
        <h3 id="decide-labels-title" className="decide-h3">
          Per label
        </h3>
        <span className="muted small">{other ? "Tuned · base Glimmer" : "Base Glimmer"}</span>
      </div>
      <div className="table-wrap">
        <table className="data decide-table">
          <caption className="sr-only">
            Precision, recall and F1 for each label on the test rows{other ? ", tuned then base Glimmer" : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col" className="num">
                Test rows
              </th>
              <th scope="col" className="num">
                Precision
              </th>
              <th scope="col" className="num">
                Recall
              </th>
              <th scope="col" className="num">
                F1
              </th>
            </tr>
          </thead>
          <tbody>
            {main.s.perLabel.map((l, i) => (
              <tr key={l.id}>
                <th scope="row">{l.name || labelName(s.labels, l.id)}</th>
                <td className="num">{groupThousands(l.support)}</td>
                <td className="num">{pair((x) => x.precision, i)}</td>
                <td className="num">{pair((x) => x.recall, i)}</td>
                <td className="num">{pair((x) => x.f1, i)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Matrix({ summary: s, side }: { summary: DecisionSummary; side: Side }) {
  const cols = [...s.labels.map((l) => l.name), "None"];
  return (
    <div className="table-wrap">
      <table className="data decide-table decide-matrix">
        <caption className="sr-only">
          {side.name}&apos;s picks on the test rows: each row is the right label, each column what it picked
        </caption>
        <thead>
          <tr>
            <th scope="col">Right label</th>
            {cols.map((c) => (
              <th scope="col" className="num" key={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.labels.map((l, i) => {
            const row = side.s.confusion[i] ?? [];
            const total = row.reduce((a, b) => a + b, 0);
            return (
              <tr key={l.id}>
                <th scope="row">{l.name}</th>
                {cols.map((c, j) => {
                  const n = row[j] ?? 0;
                  const share = total ? n / total : 0;
                  return (
                    <td
                      key={c}
                      className={`num${i === j ? " decide-diag" : ""}`}
                      style={n ? { background: `color-mix(in srgb, var(--decide-${side.key}) ${Math.round(8 + share * 40)}%, transparent)` } : undefined}
                      title={`${l.name} rows picked as ${c}: ${n} of ${total}`}
                    >
                      {n}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Confusion({ summary: s, sides }: { summary: DecisionSummary; sides: Side[] }) {
  const [main, other] = sides;
  return (
    <section className="section" aria-labelledby="decide-confusion-title">
      <div className="section-head">
        <h3 id="decide-confusion-title" className="decide-h3">
          Confusion matrix
        </h3>
        <span className="muted small">{main!.name}: rows are the right label, columns the pick</span>
      </div>
      <Matrix summary={s} side={main!} />
      {other ? (
        <details className="decide-more">
          <summary>Base Glimmer&apos;s matrix</summary>
          <Matrix summary={s} side={other} />
        </details>
      ) : null}
    </section>
  );
}

/** The reliability chart's frame, in SVG units. */
const W = 320;
const H = 240;
const PAD = { left: 44, right: 12, top: 12, bottom: 36 };
const px = (x: number) => PAD.left + x * (W - PAD.left - PAD.right);
const py = (y: number) => H - PAD.bottom - y * (H - PAD.top - PAD.bottom);

function Reliability({ summary: s, sides }: { summary: DecisionSummary; sides: Side[] }) {
  const series = sides.map((side) => ({ side, points: reliabilityPoints(side.s.reliability) }));
  const ticks = [0, 0.5, 1];
  return (
    <section className="section" aria-labelledby="decide-reliability-title">
      <div className="section-head">
        <h3 id="decide-reliability-title" className="decide-h3">
          Reliability
        </h3>
        <span className="muted small">After T, on the test rows</span>
      </div>
      <div className="card decide-chart-card">
        <ul className="decide-legend" aria-label="Series">
          {sides.map((side) => (
            <li key={side.key}>
              <span className={`decide-swatch decide-swatch-${side.key}`} aria-hidden />
              {side.name} (T = {side.s.T.toFixed(2)})
            </li>
          ))}
          <li>
            <span className="decide-swatch decide-swatch-ideal" aria-hidden />
            Right as often as it says
          </li>
        </ul>
        <svg
          className="decide-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Reliability: ${sides
            .map((side) => `${side.name}, calibration error ${eceText(side.s.ece.withT)} with T, ${eceText(side.s.ece.raw)} before`)
            .join("; ")}.`}
        >
          {ticks.map((t) => (
            <g key={`t${t}`}>
              <line className="decide-grid" x1={px(0)} x2={px(1)} y1={py(t)} y2={py(t)} />
              <text className="decide-tick" x={PAD.left - 6} y={py(t) + 4} textAnchor="end">
                {percentText(t)}
              </text>
              <text className="decide-tick" x={px(t)} y={H - PAD.bottom + 16} textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"}>
                {percentText(t)}
              </text>
            </g>
          ))}
          <text className="decide-axis" x={(px(0) + px(1)) / 2} y={H - 4} textAnchor="middle">
            Confidence
          </text>
          <text className="decide-axis" x={12} y={(py(0) + py(1)) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(py(0) + py(1)) / 2})`}>
            Share right
          </text>
          <line className="decide-ideal" x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} />
          {series.map(({ side, points }) => (
            <g key={side.key} className={`decide-series decide-series-${side.key}`}>
              {points.length > 1 ? (
                <polyline className="decide-line" points={points.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")} />
              ) : null}
              {points.map((p) => (
                <circle className="decide-dot" key={p.from} cx={px(p.x)} cy={py(p.y)} r={5}>
                  <title>
                    {`${side.name}: ${plural(p.rows, "row")} at ${percentText(p.from)} to ${percentText(p.to)} confidence (mean ${percentText(p.x)}), ${percentText(p.y)} right`}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
        <p className="muted small">
          Each dot is the test rows whose confidence fell in one tenth of the range: across, how sure the model said it
          was; up, how often it was right. On the dashed line it is right as often as it says. Calibration error{" "}
          {sides.map((side, i) => (
            <span key={side.key}>
              {i ? "; " : ""}
              {inLine(side)} {eceText(side.s.ece.withT)} with T, {eceText(side.s.ece.raw)} before
            </span>
          ))}
          .
        </p>
        <details className="decide-more">
          <summary>The bins as a table</summary>
          <div className="table-wrap">
            <table className="data decide-table">
              <caption className="sr-only">Reliability bins after T</caption>
              <thead>
                <tr>
                  <th scope="col">Confidence</th>
                  {sides.map((side) => (
                    <th scope="col" className="num" key={side.key}>
                      {side.name}: rows, right, mean confidence
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(sides[0]!.s.reliability ?? []).map((b, i) => (
                  <tr key={b.from}>
                    <th scope="row">
                      {percentText(b.from)} to {percentText(b.to)}
                    </th>
                    {sides.map((side) => {
                      const x = side.s.reliability[i];
                      return (
                        <td className="num" key={side.key}>
                          {x && x.rows ? `${x.rows}, ${percentText(x.accuracy)}, ${percentText(x.confidence)}` : "none"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}

function Baselines({ summary: s, sides }: { summary: DecisionSummary; sides: Side[] }) {
  const commonest = labelName(s.labels, s.baselines.commonest.id);
  const rows: Array<{ name: string; note: string; rate: DecisionSideSummary["accuracy"] }> = [
    ...sides.map((side) => ({
      name: side.key === "tuned" ? "Tuned" : "Base Glimmer",
      note: side.key === "tuned" ? "the trained adapter" : "zero-shot, same prompts",
      rate: side.s.accuracy,
    })),
    { name: `Always ${commonest}`, note: "the commonest training label", rate: s.baselines.commonest.accuracy },
    { name: "Word overlap", note: "a stand-in, not a model: the label sharing most words", rate: s.baselines.standIn.accuracy },
  ];
  return (
    <section className="section" aria-labelledby="decide-baselines-title">
      <div className="section-head">
        <h3 id="decide-baselines-title" className="decide-h3">
          Baselines
        </h3>
        <span className="muted small">All on the same test rows</span>
      </div>
      <div className="table-wrap">
        <table className="data decide-table">
          <caption className="sr-only">Accuracy of each model and baseline on the same test rows</caption>
          <thead>
            <tr>
              <th scope="col">Approach</th>
              <th scope="col" className="num">
                Right
              </th>
              <th scope="col" className="num">
                Accuracy
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <th scope="row">
                  {r.name}
                  <span className="row-sub muted">{r.note}</span>
                </th>
                <td className="num">
                  {groupThousands(r.rate.right)} of {groupThousands(r.rate.total)}
                </td>
                <td className="num">
                  <strong>{percentText(r.rate.rate)}</strong>
                  <span className="row-sub muted">{intervalText(r.rate)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Health({ summary: s, sides }: { summary: DecisionSummary; sides: Side[] }) {
  const each = (f: (x: DecisionSideSummary) => string) => sides.map((side) => `${inLine(side)} ${f(side.s)}`).join(" · ");
  return (
    <section className="section" aria-labelledby="decide-health-title">
      <div className="section-head">
        <h3 id="decide-health-title" className="decide-h3">
          Health
        </h3>
      </div>
      <div className="card decide-health">
        <dl className="kv">
          <div>
            <dt>Letter mass, median and lowest</dt>
            <dd>{each((x) => `${twoPlaces(x.letterMass.median)}, ${twoPlaces(x.letterMass.min)}`)}</dd>
          </div>
          <div>
            <dt>Answered &quot;none of the listed options&quot;</dt>
            <dd>{each((x) => percentText(x.noneRate))}</dd>
          </div>
          <div>
            <dt>Decline check (right label taken out)</dt>
            <dd>
              {each((x) => (x.decline ? `${x.decline.declined} of ${x.decline.rows} (${percentText(x.decline.rate)})` : "not scored"))}
            </dd>
          </div>
          <div>
            <dt>Renderings too long to score</dt>
            <dd>{groupThousands(s.tooLong)}</dd>
          </div>
          <div>
            <dt>Test rows with no usable score</dt>
            <dd>
              {groupThousands(s.unscoredRows)} of {groupThousands(s.testRows)}
            </dd>
          </div>
          <div>
            <dt>Prompts per row</dt>
            <dd>{s.groups}</dd>
          </div>
        </dl>
        <p className="muted small">
          Letter mass is the share of the first answer token&apos;s probability that lands on the shown letters; near 1 the
          model answers in the format. Base Glimmer sometimes starts with a word instead of a letter, so its letter mass is
          lower and this first-token read understates what a prompted base model could do.
        </p>
      </div>
    </section>
  );
}

function WrongList({ summary: s, wrong }: { summary: DecisionSummary; wrong: WrongAnswers }) {
  const tuned = wrong.model === "tuned";
  return (
    <section className="section" aria-labelledby="decide-wrong-title">
      <div className="section-head">
        <h3 id="decide-wrong-title" className="decide-h3">
          Wrong answers
        </h3>
        <span className="muted small">Admins only</span>
      </div>
      <p className="muted small">
        Every test row the {tuned ? "tuned model" : "base model"} got wrong, the most confident first. The public page
        shows numbers only, since the inputs may be private.
      </p>
      {wrong.shown.length ? (
        <div className="table-wrap">
          <table className="data decide-table decide-wrong">
            <caption className="sr-only">Test rows the {tuned ? "tuned" : "base"} model got wrong</caption>
            <thead>
              <tr>
                <th scope="col">Input</th>
                <th scope="col">Right label</th>
                <th scope="col">{tuned ? "Tuned picked" : "Base picked"}</th>
                {tuned ? <th scope="col">Base Glimmer</th> : null}
              </tr>
            </thead>
            <tbody>
              {wrong.shown.map((w) => (
                <tr key={w.row}>
                  <td>
                    <LongText text={w.input} foldAt={280} preview={180} />
                  </td>
                  <td>{labelName(s.labels, w.label)}</td>
                  <td>
                    {labelName(s.labels, w.pick)}
                    <span className="row-sub muted">{percentText(w.confidence)} sure</span>
                  </td>
                  {tuned ? (
                    <td>
                      {w.base ? labelName(s.labels, w.base.pick) : ""}
                      {w.base ? <span className="row-sub muted">{w.base.right ? "right" : "also wrong"}</span> : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">None: it got every scored test row right.</p>
      )}
      {wrong.total > wrong.shown.length ? (
        <p className="muted small">
          Showing the first {wrong.shown.length} of {groupThousands(wrong.total)}.
        </p>
      ) : null}
    </section>
  );
}
