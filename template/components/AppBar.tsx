import type { ReactNode } from "react";

/**
 * The product's top bar: its name and one optional action, like a "Start over" text button or an icon button. It sits
 * at the top of the page and scrolls away with it. Put it above <main>, once per page. No logos and no marks: the name
 * is the brand.
 */
export function AppBar({ name, action, href }: { name: string; action?: ReactNode; href?: string }) {
  return (
    <header className="appbar">
      <div className="appbar-inner">
        {href ? (
          <a className="appbar-name" href={href}>
            {name}
          </a>
        ) : (
          <span className="appbar-name">{name}</span>
        )}
        {action ? <div className="appbar-action">{action}</div> : null}
      </div>
    </header>
  );
}
