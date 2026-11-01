import { Icon } from "@/components/icons";

/*
 * ---------- Wave 3 slot: unit 13 (hardware) ----------
 * Agreed Oct 31: wave 3's hardware unit replaces this note, behind its own flag, with the per-owner board list from the
 * shared devices table and a pairing link to /device (admins only). Status words only: no board addresses, tokens or
 * live calls on page load. With that flag off, this note stays as it is.
 */
export function BoardsSlot() {
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
