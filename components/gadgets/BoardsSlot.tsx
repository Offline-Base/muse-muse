import { ConnectBoards } from "@/components/gadgets/ConnectBoards";
import { OwnBoards } from "@/components/gadgets/OwnBoards";
import { Icon } from "@/components/icons";
import type { SessionUser } from "@/lib/auth";
import { canOwnBoard, SHARED_ACCOUNT_MESSAGE } from "@/lib/caps/hardware/admin";
import { env } from "@/lib/env";

/*
 * ---------- Wave 3 slot: unit 13 (hardware) ----------
 * Agreed Oct 31: wave 3's hardware unit replaces this note, behind its own flag, with the per-owner board list from the
 * shared devices table and a pairing link to /device (admins only). Status words only: no board addresses, tokens or
 * live calls on page load. With that flag off, this note stays as it is.
 */
export function BoardsSlot({ viewer = null }: { viewer?: SessionUser | null } = {}) {
  if (env.gadgetConnect && canOwnBoard(viewer)) return <ConnectBoards />;
  if (env.gadgetConnect) {
    return (
      <section className="card notice" aria-labelledby="pair-title">
        <span className="notice-icon" aria-hidden>
          <Icon name="plug" />
        </span>
        <div>
          <h2 id="pair-title">Pair your own board</h2>
          <p className="muted">{SHARED_ACCOUNT_MESSAGE}</p>
        </div>
      </section>
    );
  }
  if (env.hardwareBoardRegistry) return <OwnBoards viewer={viewer} />;
  return (
    <section className="card notice" aria-labelledby="coming-title">
      <span className="notice-icon" aria-hidden>
        <Icon name="plug" />
      </span>
      <div>
        <h2 id="coming-title">Planned: connect your own board</h2>
        <p className="muted">
          Today, live products with the option can only use a board Muse Muse sets up. Connecting your own board is
          planned.
        </p>
      </div>
    </section>
  );
}
