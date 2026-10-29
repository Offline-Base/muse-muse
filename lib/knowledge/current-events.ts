import { linkTargets, sourceNames, wikitextToPlain } from "@/lib/knowledge/wikitext";

/**
 * Wikipedia's daily current-events pages (Portal:Current events/2026 June 15) as dated events. Each page is a list of
 * topic headings ('''Armed conflicts and attacks'''), then nested bullets: the outer ones name the story
 * ([[2026 Iran war]]), the innermost one is the event itself, with its news source as an external link.
 */

export interface CurrentEvent {
  /** The day, YYYY-MM-DD. */
  date: string;
  /** The page's topic heading, such as "Armed conflicts and attacks". */
  category: string;
  /** The stories it sits under, outermost first: ["Middle Eastern crisis", "2026 Iran war"]. */
  topics: string[];
  /** The event as one plain sentence or a few. */
  text: string;
  /** Article titles linked from the event and its stories. */
  links: string[];
  /** News outlets the page cites for it. */
  sources: string[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The page title for a day: "Portal:Current events/2026 June 15". */
export function currentEventsTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `Portal:Current events/${y} ${MONTHS[m - 1]} ${d}`;
}

/** Every day from start to end, both included, as YYYY-MM-DD. */
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** The portal's topic headings. A heading that matches one but for case or a typo is read as that one. */
export const CATEGORIES = [
  "Armed conflicts and attacks",
  "Arts and culture",
  "Business and economy",
  "Disasters and accidents",
  "Health and environment",
  "International relations",
  "Law and crime",
  "Politics and elections",
  "Science and technology",
  "Sports",
];

function canonicalCategory(heading: string): string {
  const key = heading.toLowerCase().replace(/[^a-z]/g, "");
  const exact = CATEGORIES.find((c) => c.toLowerCase().replace(/[^a-z]/g, "") === key);
  if (exact) return exact;
  // One letter wrong, missing or extra ("Business and econony"): same first word and length within one.
  return CATEGORIES.find((c) => c.split(" ")[0].toLowerCase() === heading.split(" ")[0].toLowerCase() && Math.abs(c.length - heading.length) <= 1) ?? heading;
}

/** A bullet is an event when it cites a source, or reads as a sentence rather than a bare story link. */
function isEvent(raw: string, plain: string): boolean {
  if (/\[https?:\/\//.test(raw)) return true;
  return plain.split(/\s+/).length >= 8 && /[.!?]["')]*$/.test(plain);
}

export function parseCurrentEvents(wikitext: string, date: string): CurrentEvent[] {
  const events: CurrentEvent[] = [];
  const body = wikitext.replace(/<!--[\s\S]*?-->/g, "");
  let category = "";
  // stack[i] is the bullet at depth i + 1: its plain text and its raw wikitext.
  const stack: Array<{ plain: string; raw: string }> = [];
  for (const line of body.split("\n")) {
    const heading = line.match(/^\s*(?:'''(.+?)'''|;\s*(.+))\s*$/);
    if (heading) {
      category = canonicalCategory(wikitextToPlain(heading[1] ?? heading[2]));
      stack.length = 0;
      continue;
    }
    const bullet = line.match(/^(\*+)\s*(.*)$/);
    if (!bullet) continue;
    const depth = bullet[1].length;
    const raw = bullet[2];
    const plain = wikitextToPlain(raw);
    stack.length = depth - 1;
    stack[depth - 1] = { plain, raw };
    if (!plain || !isEvent(raw, plain)) continue;
    const parents = stack.slice(0, depth - 1).filter(Boolean);
    events.push({
      date,
      category,
      topics: parents.map((p) => p.plain).filter((p) => p && !isEvent(p, p)),
      text: plain,
      links: [...new Set([...parents.flatMap((p) => linkTargets(p.raw)), ...linkTargets(raw)])],
      sources: sourceNames(raw),
    });
  }
  return events;
}
