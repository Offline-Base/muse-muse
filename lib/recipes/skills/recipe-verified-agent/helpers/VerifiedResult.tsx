/** Shows each claim with its quotes and what actually checked it. Restyle freely, but keep the words honest. */
interface Evidence { source: string; quote: string }
interface Claim { item: string; text: string; evidence: Evidence[] }
type Answer =
  | { status: "answered"; claims: Claim[]; open: Array<{ item: string; why: string }>; review_receipt: string }
  | { status: "needs_person"; item: string; request: string; tried: Array<{ source: string }>; claims: Claim[] };

function ClaimRow({ claim, reviewed }: { claim: Claim; reviewed: boolean }) {
  const state = !claim.evidence.length ? "Not checked" : reviewed ? "Quote found in the source by code. Read against the claim by a model." : "Quote found in the source by code. Not reviewed by a model.";
  return (
    <li>
      <p>{claim.text}</p>
      {claim.evidence.map((e) => (
        <blockquote key={`${e.source}:${e.quote}`}>{e.quote} <cite>{e.source}</cite></blockquote>
      ))}
      <small>{state}</small>
    </li>
  );
}

export function VerifiedResult({ answer }: { answer: Answer }) {
  const reviewed = answer.status === "answered" && !!answer.review_receipt;
  return (
    <div>
      {answer.status === "needs_person" ? (
        <section>
          <h3>Needs you: {answer.item}</h3>
          <p>{answer.request}</p>
          <small>It read: {answer.tried.map((t) => t.source).join(", ")}</small>
        </section>
      ) : null}
      <ul>{answer.claims.map((c) => <ClaimRow key={`${c.item}:${c.text}`} claim={c} reviewed={reviewed} />)}</ul>
      {answer.status === "answered" && answer.open.length ? (
        <ul>{answer.open.map((o) => <li key={o.item}><strong>Open: {o.item}.</strong> {o.why} <small>Not backed by anything it read.</small></li>)}</ul>
      ) : null}
      <small>Backed by what it read. These checks don't show that the sources themselves are right.</small>
    </div>
  );
}
