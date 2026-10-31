import { Icon } from "@/components/Icon";
import type { AgentSource } from "@/lib/agent/events";

const PAGES_IN_VIEW = 5;

/**
 * The pages an answer rests on: the title links out, the site's name goes under it. Pages it cites come first. Pass
 * `numbered` when the answer points at them by number, as deep research's does.
 */
export function SourceList({ sources, numbered = false, title = "Sources" }: { sources: readonly AgentSource[]; numbered?: boolean; title?: string }) {
  const cited = sources.filter((s) => s.cited);
  const read = sources.filter((s) => !s.cited);
  if (!cited.length && !read.length) return null;
  // Nothing cited yet: the pages it read are all there is to show, so the first few stay in view.
  const shown = cited.length ? cited : read.slice(0, PAGES_IN_VIEW);
  const rest = cited.length ? read : read.slice(PAGES_IN_VIEW);
  return (
    <div data-sources>
      <h3>{cited.length ? title : "Pages it read"}</h3>
      <ul className="list">
        {shown.map((source, at) => (
          <SourceRow key={source.id} source={source} number={numbered && cited.length ? at + 1 : undefined} />
        ))}
      </ul>
      {rest.length ? (
        <details>
          <summary>{`Also read ${rest.length === 1 ? "1 page" : `${rest.length} pages`}`}</summary>
          <ul className="list">
            {rest.map((source) => (
              <SourceRow key={source.id} source={source} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function SourceRow({ source, number }: { source: AgentSource; number?: number }) {
  return (
    <li>
      <a className="list-row" href={source.href} target="_blank" rel="noopener noreferrer">
        <span className="icon-circle">{number ?? <Icon name="external" />}</span>
        <span className="list-text">
          <span className="list-title">{source.title}</span>
          <span className="meta">{source.date ? `${source.detail}, ${source.date}` : source.detail}</span>
        </span>
      </a>
    </li>
  );
}
