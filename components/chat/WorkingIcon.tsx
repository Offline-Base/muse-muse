const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Eight dots on a ring that fills the icon's box, each tilted a little past its spoke so the ring reads as a flower,
 * as in the Muse app.
 */
const RING = 8.4;
const DOTS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * Math.PI) / 4 - Math.PI / 2;
  const cx = round(12 + RING * Math.cos(angle));
  const cy = round(12 + RING * Math.sin(angle));
  // Purple at the top shading to blue-violet at the bottom, the way the app's icon sits when it's still.
  const from = Math.round(((cy - 12 + RING) / (2 * RING)) * 100);
  return { cx, cy, turn: i * 45 + 20, fill: `color-mix(in oklab, var(--work-from) ${from}%, var(--work-to))` };
});

/**
 * The working icon (docs/UI_MUSE_APP.md, "The agent's working step"): a ring of eight dots shading from --work-from to
 * --work-to. It turns slowly while a step works and stands still otherwise, and always under reduced motion. 18 px, or
 * 16 px as the subagent variant for nested agent rows. Decorative: the step's title says what's happening.
 *
 * The Muse mascot's working animation replaces the dots when the owner's mascot folder lands. The swap stays inside
 * this file: every surface asks for a WorkingIcon by state and variant, never for the dots.
 */
export function WorkingIcon({
  state = "working",
  variant,
  size,
}: {
  state?: "working" | "still";
  /** Subagent and workflow rows: 16 px, and the mascot's subagent avatar once it lands. */
  variant?: "subagent";
  size?: number;
}) {
  const px = size ?? (variant === "subagent" ? 16 : 18);
  return (
    <svg
      className={`chat-working-icon${state === "working" ? " is-working" : ""}${variant ? ` is-${variant}` : ""}`}
      width={px}
      height={px}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {DOTS.map((d) => (
        <ellipse
          key={d.turn}
          cx={d.cx}
          cy={d.cy}
          rx={2.3}
          ry={3.3}
          transform={`rotate(${d.turn} ${d.cx} ${d.cy})`}
          style={{ fill: d.fill }}
        />
      ))}
    </svg>
  );
}
