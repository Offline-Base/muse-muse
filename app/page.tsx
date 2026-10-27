const EXAMPLES = [
  { inspo: "A photo of a bookshelf in a café", note: "Make me one for my wall" },
  { inspo: "A napkin sketch of a habit tracker", note: "No note needed" },
  { inspo: "A 15-second video of birds at a feeder", note: "Count them for me" },
];

// Scaffold only. TODO(kickoff, day 3): upload inspo through an upload ticket, POST /api/inspirations,
// then route to /b/[buildId].
export default function Home() {
  return (
    <main>
      <h1>Give it a muse. Muse makes it.</h1>
      <p className="muted">
        Drop in an example or some inspo, like a photo, a screenshot, a sketch, a short video, a voice memo or a PDF.
        Muse Code builds a working product from it on Meta&apos;s models, tests it and gives you a link.
      </p>
      <form className="card" aria-label="Your muse">
        <label htmlFor="inspo">Your inspo</label>
        <input
          id="inspo"
          name="inspo"
          type="file"
          multiple
          accept="image/*,video/mp4,video/quicktime,audio/*,application/pdf"
          disabled
        />
        <label htmlFor="note">Add a note (optional)</label>
        <textarea id="note" name="note" placeholder="Make this, but for my bakery" disabled />
        <p className="muted">Building opens at kickoff on Oct 26.</p>
        <button type="submit" disabled>
          Make it
        </button>
      </form>
      <section className="card" aria-label="Examples">
        <h2>Examples</h2>
        <ul>
          {EXAMPLES.map((example) => (
            <li key={example.inspo}>
              {example.inspo}. {example.note}.
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
