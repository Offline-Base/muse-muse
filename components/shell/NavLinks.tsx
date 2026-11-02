"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { Icon } from "@/components/icons";
import { NAV_GROUPS, START_MUSING, isActive, type NavItem } from "@/components/shell/nav";

/** One sidebar row: icon and label, lit when its page is open. */
export function NavRow({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  if (item.external) {
    return (
      <a href={item.href} className="nav-link" target="_blank" rel="noopener noreferrer">
        <Icon name={item.icon} size={24} />
        <span>{item.label}</span>
        <Icon name="external" size={20} className="nav-ext" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  const active = isActive(item, pathname);
  return (
    <Link href={item.href} className="nav-link" aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <Icon name={item.icon} size={24} />
      <span>{item.label}</span>
    </Link>
  );
}

/** The one creation button at the top of the sidebar: it opens the composer on the Make page. */
export function StartMusing({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  return (
    <Link
      href={START_MUSING.href}
      className="btn btn-primary nav-start"
      aria-current={isActive(START_MUSING, pathname) ? "page" : undefined}
      onClick={onNavigate}
    >
      <Icon name={START_MUSING.icon} size={20} />
      <span>{START_MUSING.label}</span>
    </Link>
  );
}

/** The sidebar's main rows. The active row comes from the current pathname. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav" aria-label="Main">
      {NAV_GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 ? <hr className="nav-sep" /> : null}
          <ul className="nav-group">
            {group.map((item) => (
              <li key={item.href}>
                <NavRow item={item} pathname={pathname} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </nav>
  );
}
