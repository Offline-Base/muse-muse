"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { Icon } from "@/components/icons";
import { NAV_GROUPS, isActive } from "@/components/shell/nav";

/** The sidebar's nav rows. The active row comes from the current pathname. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav" aria-label="Main">
      {NAV_GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 ? <hr className="nav-sep" /> : null}
          <ul className="nav-group">
            {group.map((item) => {
              if (item.external) {
                return (
                  <li key={item.href}>
                    <a href={item.href} className="nav-link" target="_blank" rel="noopener noreferrer">
                      <Icon name={item.icon} size={24} />
                      <span>{item.label}</span>
                      <Icon name="external" size={20} className="nav-ext" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </li>
                );
              }
              const active = isActive(item, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="nav-link"
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                  >
                    <Icon name={item.icon} size={24} />
                    <span>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Fragment>
      ))}
    </nav>
  );
}
