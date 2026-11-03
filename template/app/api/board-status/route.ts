import { boardStatus } from "../../../lib/meta/board-status";

// Whether this copy reaches an edge board right now, for components/BoardStatus.tsx (the muse-edge skill). It asks no
// model, in the cloud or on the board. ?looks=1 adds Meta SAM 3.1's board, for a product that looks at photos. Keep this
// file as it is: the outage drill reads it.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const looks = new URL(request.url).searchParams.get("looks") === "1";
  return Response.json(await boardStatus({ looks }), { headers: { "cache-control": "no-store" } });
}
