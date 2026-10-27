// Product page. TODO(kickoff, day 7): live link, how it was built (Muse Code transcript), models used, cost per run,
// limits, and the Muse app connector URL.
export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main>
      <h1>{slug}</h1>
      <p className="muted">Product pages are planned for kickoff week.</p>
    </main>
  );
}
