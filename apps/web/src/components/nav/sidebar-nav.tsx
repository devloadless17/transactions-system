'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * Returns whether a nav item is active for the given pathname. The overview
 * roots ('/admin', '/app') match exactly so child routes don't keep them lit.
 */
export function isNavItemActive(
  pathname: string,
  href: string,
  exactRoots: readonly string[] = ['/admin', '/app'],
): boolean {
  if (exactRoots.includes(href)) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Shared sidebar navigation list. Renders the same links for both the desktop
 * rail and the mobile drawer.
 *
 * - `collapsed` shows icon-only items with a native tooltip (`title`).
 * - `onNavigate` fires when a link is tapped (used to close the mobile drawer).
 */
export function SidebarNav({
  items,
  collapsed = false,
  onNavigate,
}: {
  items: readonly NavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav className="flex-1 space-y-1 px-3 py-3">
      {items.map(({ href, label, icon: Icon }) => {
        const active = isNavItemActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            title={collapsed ? label : undefined}
            aria-label={collapsed ? label : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              collapsed && 'justify-center px-2',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
