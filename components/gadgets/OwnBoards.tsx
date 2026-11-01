import Link from "next/link";
import { Icon } from "@/components/icons";
import { listBoards, type BoardView } from "@/lib/caps/hardware/store";
import type { SessionUser } from "@/lib/auth";

const STATUS: Record<BoardView["status"], { word: string; pill: string }> = {
  ok: { word: "Online", pill: "pill-live" },
  unreachable: { word: "Not answering", pill: "pill-failed" },
  unknown: { word: "Not checked yet", pill: "pill-neutral" },
};

/** An admin's boards as status words, read from the last call that reached each one. Never an address, never a live call. */
async function boardsOf(viewer: SessionUser): Promise<BoardView[] | null> {
  try {
    return await listBoards(viewer.id);
  } catch (err) {
    console.error("[gadgets] the board list didn't load:", err instanceof Error ? err.name : "error");
    return null;
  }
}

/**
 * The /gadgets slot with HARDWARE_BOARD_REGISTRY on (docs/CAPABILITIES.md, section 19). This page is public, so anyone else
 * sees one plain line. Admins see their own boards and a link to /device, where they add and link them.
 */
export async function OwnBoards({ viewer }: { viewer: SessionUser | null }) {
  const boards = viewer?.isAdmin && !viewer.openAccess ? await boardsOf(viewer) : null;
  return (
    <section className="card notice" aria-labelledby="boards-title">
      <span className="notice-icon" aria-hidden>
        <Icon name="plug" />
      </span>
      <div>
        <h2 id="boards-title">Your boards</h2>
        {!viewer?.isAdmin || viewer.openAccess ? (
          <p className="muted">Admins connect boards for now. A board reaches a product only after its owner links it.</p>
        ) : !boards ? (
          <p className="muted">Your boards can&apos;t be shown right now.</p>
        ) : !boards.length ? (
          <p className="muted">You haven&apos;t added a board yet.</p>
        ) : (
          <ul>
            {boards.map((b) => (
              <li key={b.id}>
                <span>{b.name}</span> <span className={`pill ${STATUS[b.status].pill}`}>{STATUS[b.status].word}</span>
                <span className="muted small"> {b.products.length ? `Linked to ${b.products.map((p) => p.name).join(", ")}` : "Not linked to a product"}</span>
              </li>
            ))}
          </ul>
        )}
        {viewer?.isAdmin && !viewer.openAccess ? (
          <p>
            <Link href="/device">Add or link a board on the Device page</Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}
