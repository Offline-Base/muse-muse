"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/icons";
import { Menu } from "@/components/Menu";
import { TOP_NAV, isActive, isGroup, isGroupActive, type NavItem } from "@/components/shell/nav";

function MenuLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const text = (
    <span className="menu-item-text">
      <span>{item.label}</span>
      {item.blurb ? <span className="menu-item-sub">{item.blurb}</span> : null}
    </span>
  );
  if (item.external) {
    return (
      <a className="menu-item" href={item.href} target="_blank" rel="noopener noreferrer">
        <Icon name={item.icon} size={20} />
        {text}
        <Icon name="external" size={16} className="menu-item-ext" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link className="menu-item" href={item.href} aria-current={isActive(item, pathname) ? "page" : undefined}>
      <Icon name={item.icon} size={20} />
      {text}
    </Link>
  );
}

/**
 * The desktop top bar's links, laid out like the developer site's: plain gray text, the current page in ink with a
 * blue bar under it, and chevron menus (buttons with aria-expanded; Escape closes and returns focus) for the groups.
 */
export function TopLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="topnav" aria-label="Main">
      <ul className="topnav-list">
        {TOP_NAV.map((entry) => {
          if (isGroup(entry)) {
            const active = isGroupActive(entry, pathname);
            return (
              <li key={entry.label}>
                <Menu
                  text={entry.label}
                  label={entry.label}
                  align="start"
                  buttonClassName={`topnav-link topnav-trigger${active ? " is-active" : ""}`}
                >
                  <ul className="menu-list">
                    {entry.items.map((item) => (
                      <li key={item.href}>
                        <MenuLink item={item} pathname={pathname} />
                      </li>
                    ))}
                  </ul>
                </Menu>
              </li>
            );
          }
          const active = isActive(entry, pathname);
          return (
            <li key={entry.href}>
              <Link
                href={entry.href}
                className={`topnav-link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {entry.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
