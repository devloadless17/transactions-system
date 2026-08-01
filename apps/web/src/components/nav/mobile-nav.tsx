'use client';
import * as React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav, type NavItem } from './sidebar-nav';

/**
 * Mobile navigation: a hamburger trigger (visible only `< md`) that opens a
 * left-side `Sheet` containing the same nav. Tapping a link closes the drawer.
 *
 * Mirrors DashboardSidebar: no visible title row. The drawer still needs an
 * accessible name (Radix Dialog requirement), so the title is `sr-only`.
 */
export function MobileNav({
  items,
  badges,
}: {
  items: readonly NavItem[];
  badges?: Record<string, number>;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 md:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 p-0 sm:max-w-xs">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        {/* Clears the drawer's absolutely-positioned close button. */}
        <div className="h-10 shrink-0" />
        <SidebarNav items={items} onNavigate={() => setOpen(false)} badges={badges} />
      </SheetContent>
    </Sheet>
  );
}
