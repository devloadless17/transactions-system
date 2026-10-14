'use client';
import * as React from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { SidebarNav, type NavItem } from './sidebar-nav';

/**
 * Reads the persisted collapsed flag for a given storage key. SSR-safe
 * (returns `false` until mounted), then syncs from localStorage.
 */
function useCollapsed(storageKey: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(storageKey) === '1');
    } catch {
      // ignore (e.g. storage disabled)
    }
  }, [storageKey]);

  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, [storageKey]);

  return [collapsed, toggle];
}

/**
 * Desktop sidebar rail. Hidden below `md`; collapsible to an icon-only rail
 * whose state persists in localStorage under `storageKey`. The mobile drawer
 * (see MobileNav) covers small screens.
 *
 * Deliberately has no title/brand row: the nav starts at the top so the first
 * item lines up with the topbar row beside it.
 */
export function DashboardSidebar({
  items,
  storageKey,
  badges,
  alerts,
}: {
  items: readonly NavItem[];
  storageKey: string;
  badges?: Record<string, number>;
  alerts?: Record<string, number>;
}): React.JSX.Element {
  const [collapsed, toggle] = useCollapsed(storageKey);

  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-background md:flex',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <SidebarNav items={items} collapsed={collapsed} badges={badges} alerts={alerts} />
      <div className={cn('border-t p-3', collapsed && 'flex justify-center')}>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="h-8 w-8"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>
    </aside>
  );
}
