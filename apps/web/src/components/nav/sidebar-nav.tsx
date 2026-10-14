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
  /** Key into the `badges` map for a live count pill (e.g. PENDING requests). */
  badgeKey?: string;
  /** Key into the `alerts` map: money stuck that a person must look at (red). */
  alertKey?: string;
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
  badges,
  alerts,
}: {
  items: readonly NavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
  /** Map of `badgeKey` → count; renders a pill (or a dot when collapsed). */
  badges?: Record<string, number>;
  /** Map of `alertKey` → count; renders a red pill (or a red dot when collapsed). */
  alerts?: Record<string, number>;
}): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3">
      {items.map(({ href, label, icon: Icon, badgeKey, alertKey }) => {
        const active = isNavItemActive(pathname, href);
        const count = badgeKey ? (badges?.[badgeKey] ?? 0) : 0;
        const alert = alertKey ? (alerts?.[alertKey] ?? 0) : 0;
        const status = [
          alert > 0 ? `${alert} need${alert === 1 ? 's' : ''} attention` : null,
          count > 0 ? `${count} pending` : null,
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            title={collapsed ? label : alert > 0 ? status : undefined}
            aria-label={
              collapsed || alert > 0 ? `${label}${status ? ` (${status})` : ''}` : undefined
            }
            className={cn(
              'relative flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              collapsed && 'justify-center px-2',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
            {alert > 0 &&
              (collapsed ? (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive ring-2 ring-background" />
              ) : (
                <span
                  className={cn(
                    'ml-auto min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums',
                    active
                      ? 'bg-primary-foreground text-destructive'
                      : 'bg-destructive text-destructive-foreground',
                  )}
                >
                  {alert > 99 ? '99+' : alert}
                </span>
              ))}
            {count > 0 &&
              (collapsed ? (
                alert === 0 && (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" />
                )
              ) : (
                <span
                  className={cn(
                    'min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums',
                    alert === 0 && 'ml-auto',
                    active
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-amber-500 text-white',
                  )}
                >
                  {count > 99 ? '99+' : count}
                </span>
              ))}
          </Link>
        );
      })}
    </nav>
  );
}
