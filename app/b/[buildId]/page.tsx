// Build room. TODO(kickoff, day 3): subscribe to /api/builds/[buildId]/events and render the brief, the live
// Muse Code log, the file list, the preview iframe and the check results.
export default async function BuildRoom({ params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  return (
    <main>
      <h1>Build {buildId}</h1>
      <p className="muted">The build room is planned for kickoff week.</p>
    </main>
  );
}
