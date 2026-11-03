import Link from "next/link";
import type { GetItSlots } from "@/components/product/GetItPanel";
import { DRILL_GROUP_TITLE, type DrillRow } from "@/lib/edge/drills";

/**
 * The "Get it" panel's Edge slot (edge-honest unit, Nov 3). Kept apart from NativeSlots.tsx and the page's getItSlots,
 * which the native unit owns: the page spreads edgeSlots() into the panel beside them.
 *
 * It says only what the platform knows: what the build's simulated outage drills showed, that a hosted copy has no board
 * for its main answer (a hosted product never gets EDGE_URL), whether its look at a photo may go to the office board
 * through Muse Muse (FLEET_SAM, lib/caps/fleet/sam.ts), and where to get the code to run it beside a board. It never says
 * a board answered: the product's own board status line (components/BoardStatus.tsx in the template) says that live.
 */

/** The slot's anchor on the page for the drills' own section. */
export const DRILLS_SECTION_ID = "outage-drills";

export interface EdgeSlotContext {
  slug: string;
  /** The brief has the edge target and EDGE_ENABLED is on. Off: no slot. */
  edge: boolean;
  /** The brief looks at photos with Meta SAM 3.1. */
  looks: boolean;
  /** The newest drills (latestDrills), or null when the build never ran them. */
  drills: { drills: readonly DrillRow[]; later: boolean } | null;
  /** FLEET_SAM is on and its control-plane settings are there. */
  fleetSam: boolean;
  /** FLEET_ALL_PRODUCTS: any signed-in builder's product may reach the office board, not only an admin's. */
  fleetAllProducts: boolean;
  /** The viewer may read the source (canReadCode), so the Code page has the download. */
  codeReadable: boolean;
}

/** The plain line about a hosted copy's board. Pure, for the tests. */
export function boardLine(ctx: Pick<EdgeSlotContext, "looks" | "fleetSam" | "fleetAllProducts">): { headline: string; notes: string[] } {
  if (ctx.looks && ctx.fleetSam) {
    // Its look may reach the office board, so only the main answer is cloud-only here.
    const notes = ["This hosted copy has no board for its main answer, so here that answer comes from the cloud, labeled that way."];
    notes.push(
      `Its look at a photo can go to Meta SAM 3.1 on an office Jetson through Muse Muse when the cloud can't answer${ctx.fleetAllProducts ? "" : ", for products a Muse Muse admin made"}. The product's own board line says whether that board answers right now.`,
    );
    return { headline: "No board for the main answer", notes };
  }
  return { headline: "Not connected to a board", notes: ["This hosted copy has no board, so here every answer comes from the cloud, labeled that way."] };
}

/** The drills in one line: how many passed, and that they were simulated. */
export function drillsLine(drills: EdgeSlotContext["drills"]): string {
  if (!drills || !drills.drills.length) return "No outage drill ran for this build.";
  const ok = drills.drills.filter((d) => d.ok).length;
  const all = drills.drills.length;
  const head = ok === all ? `All ${all} outage drills passed.` : `${ok} of ${all} outage drills passed.`;
  return `${head} They ran in the build's sandbox against a simulated board and a blocked cloud, not on a real board.${drills.later ? " They ran on an earlier try." : ""}`;
}

function EdgePanel({ ctx }: { ctx: EdgeSlotContext }) {
  const board = boardLine(ctx);
  const failed = ctx.drills?.drills.filter((d) => !d.ok) ?? [];
  return (
    <div className="getit-tab">
      <section className="getit-block">
        <h3>Board</h3>
        <p className="getit-get">
          <span className="pill pill-neutral">
            <span className="pill-dot" aria-hidden />
            {board.headline}
          </span>
        </p>
        {board.notes.map((n) => (
          <p key={n} className="getit-note">
            {n}
          </p>
        ))}
      </section>
      <section className="getit-block">
        <h3>{DRILL_GROUP_TITLE}</h3>
        <p className="getit-note">{drillsLine(ctx.drills)}</p>
        {failed.length ? (
          <ul className="getit-reasons">
            {failed.map((d) => (
              <li key={d.id}>{`Didn't pass: drill ${d.id}, ${d.name}`}</li>
            ))}
          </ul>
        ) : null}
        {ctx.drills?.drills.length ? (
          <p className="getit-note">
            <a href={`#${DRILLS_SECTION_ID}`}>See each drill</a>
          </p>
        ) : null}
      </section>
      <section className="getit-block">
        <h3>Run it beside a board</h3>
        {ctx.codeReadable ? (
          <>
            <p className="getit-note">
              Download the source from the <Link href={`/p/${ctx.slug}/code`}>Code page</Link> and run it on a machine wired to a board.
            </p>
            <ol className="getit-steps">
              <li>Set EDGE_URL to the board model server&apos;s /v1 address{ctx.looks ? ", and EDGE_SAM_URL to its SAM service" : ""}.</li>
              <li>Set EDGE_BOARD to the board&apos;s name, so the labels name it.</li>
              <li>Open the product. Its board line says whether the board answers.</li>
            </ol>
          </>
        ) : (
          <p className="getit-note">This product&apos;s source isn&apos;t shared, so there&apos;s no kit to run it beside a board.</p>
        )}
      </section>
    </div>
  );
}

/** The Edge slot, or nothing for a product without the edge target (or with EDGE_ENABLED off). */
export function edgeSlots(ctx: EdgeSlotContext): GetItSlots {
  return { edge: ctx.edge ? <EdgePanel ctx={ctx} /> : null };
}
