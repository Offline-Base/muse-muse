import type { RewardPoint, RlResultsView } from "@/lib/train/rl";

const W = 640;
const H = 240;
const PAD = { left: 48, right: 16, top: 12, bottom: 40 };
const TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Mean reward per logged step on one fixed 0 to 1 axis, the reward's whole range, so a small change looks small. */
function RewardChart({ points }: { points: RewardPoint[] }) {
  const first = points[0]!.step;
  const last = points[points.length - 1]!.step;
  const px = (step: number) => PAD.left + ((step - first) / Math.max(1, last - first)) * (W - PAD.left - PAD.right);
  const py = (reward: number) => H - PAD.bottom - Math.max(0, Math.min(1, reward)) * (H - PAD.top - PAD.bottom);
  const end = points[points.length - 1]!;
  return (
    <svg
      className="decide-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Mean reward from ${points[0]!.reward} at step ${first} to ${end.reward} at step ${last}.`}
    >
      {TICKS.map((t) => (
        <g key={t}>
          <line className="decide-grid" x1={PAD.left} x2={W - PAD.right} y1={py(t)} y2={py(t)} />
          <text className="decide-tick" x={PAD.left - 6} y={py(t) + 4} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <text className="decide-tick" x={px(first)} y={H - PAD.bottom + 16} textAnchor="start">
        {first}
      </text>
      <text className="decide-tick" x={px(last)} y={H - PAD.bottom + 16} textAnchor="end">
        {last}
      </text>
      <text className="decide-axis" x={(W + PAD.left - PAD.right) / 2} y={H - 4} textAnchor="middle">
        Training step
      </text>
      <text className="decide-axis" x={12} y={H / 2} textAnchor="middle" transform={`rotate(-90 12 ${H / 2})`}>
        Mean reward
      </text>
      <g className="decide-series decide-series-tuned">
        {points.length > 1 ? <polyline className="decide-line" points={points.map((p) => `${px(p.step)},${py(p.reward)}`).join(" ")} /> : null}
        {points.map((p) => (
          <circle className="decide-dot" key={p.step} cx={px(p.step)} cy={py(p.reward)} r={4}>
            <title>{`Step ${p.step}: mean reward ${p.reward}`}</title>
          </circle>
        ))}
      </g>
    </svg>
  );
}

/**
 * An rl-grpo job's results on its admin page: reward over time, then the held-out problems before and after. The reward
 * is checked by code. A dry run says its numbers are made up.
 */
export function RlResults({ results: r, running }: { results: RlResultsView; running: boolean }) {
  const h = r.heldOut;
  return (
    <section className="card section-card" aria-labelledby="rl-results">
      <h2 id="rl-results">Reinforcement learning results</h2>
      {r.dryRun ? (
        <p>
          <strong>Dry run: these numbers are made up.</strong> No model ran.
        </p>
      ) : null}
      <p className="muted small">
        Made-up arithmetic problems, scored by code: 1 for the right number in the answer tag, 0.1 for a wrong number, 0 for no single tag.
      </p>

      <h3>Reward over time</h3>
      {r.curve.length ? (
        <>
          <RewardChart points={r.curve} />
          <details>
            <summary>Reward as a table</summary>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Mean reward</th>
                </tr>
              </thead>
              <tbody>
                {r.curve.map((p) => (
                  <tr key={p.step}>
                    <td>{p.step}</td>
                    <td>{p.reward}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p className="muted">{running ? "No reward logged yet. The first points come a few steps into training." : "No reward was logged."}</p>
      )}
      {r.stoppedEarly ? <p className="muted small">Training stopped early to stay inside the job&apos;s time limit.</p> : null}

      <h3>Held-out problems, before and after</h3>
      {h ? (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Right</th>
                <th scope="col">Mean reward</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Before training</th>
                <td>
                  {h.baseCorrect} of {h.total}
                </td>
                <td>{h.baseReward}</td>
              </tr>
              <tr>
                <th scope="row">After training</th>
                <td>
                  {h.tunedCorrect} of {h.total}
                </td>
                <td>{h.tunedReward}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">One run on {h.total} problems the training never saw. A small difference can be chance.</p>
          {r.examples.length ? (
            <details>
              <summary>Sample answers</summary>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Problem</th>
                    <th scope="col">Answer</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {r.examples.map((e) => (
                    <tr key={e.problem}>
                      <th scope="row">{e.problem}</th>
                      <td>{e.answer}</td>
                      <td>
                        {e.base} <span className="muted small">(reward {e.baseReward})</span>
                      </td>
                      <td>
                        {e.tuned} <span className="muted small">(reward {e.tunedReward})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </>
      ) : (
        <p className="muted">{running ? "The comparison shows when the job finishes." : "No comparison was reported."}</p>
      )}
    </section>
  );
}
