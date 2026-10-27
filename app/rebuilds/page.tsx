import resources from "@/catalog/meta-resources.json";

const FIT_LABEL: Record<string, string> = {
  clean: "Clean rebuild",
  reframe: "Reframe",
  partial: "Partial",
};

// Scaffold: lists the rebuild targets from the catalog. TODO(kickoff, day 7): show each rebuild's live product,
// recorded demo, build time and cost, plus totals for the whole batch.
export default function Rebuilds() {
  return (
    <main>
      <h1>Meta&apos;s demos, rebuilt</h1>
      <p className="muted">
        Every video on the first page of Meta&apos;s Videos section uses Llama. Each one below becomes a muse that Muse
        Muse rebuilds on current Muse models and records. Checked {resources.checkedOn}.
      </p>

      <section className="grid-cards" aria-label="Rebuilds of Meta's videos">
        {resources.videos.map((video) => (
          <article className="card" key={video.id}>
            <span className="pill">{FIT_LABEL[video.rebuild.fit] ?? video.rebuild.fit}</span>
            <h2 style={{ fontSize: "1.05rem", margin: 0 }}>
              <a href={video.url} target="_blank" rel="noopener noreferrer">
                {video.title}
              </a>
            </h2>
            <p className="muted">{video.rebuild.plan}</p>
            <p className="muted">Models: {video.rebuild.models.join(", ")}</p>
            <p className="muted">Not built yet</p>
          </article>
        ))}
      </section>

      <h2>Demos Meta doesn&apos;t have yet</h2>
      <section className="grid-cards" aria-label="First demos for newer models">
        {resources.missing.map((item) => (
          <article className="card" key={item.id}>
            <span className="pill">{item.model}</span>
            <p>{item.note}</p>
            <p className="muted">{item.why}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
