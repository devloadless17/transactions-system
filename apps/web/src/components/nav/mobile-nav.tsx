'use client';
import * as React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav, type NavItem } from './sidebar-nav';

/**
 * Mobile navigation: a hamburger trigger (visible only `< md`) that opens a
 * left-side `Sheet` containing the same nav. Tapping a link closes the drawer.
 */
export function MobileNav({
  title,
  items,
}: {
  title: string;
  items: readonly NavItem[];
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
        <SheetHeader className="h-14 justify-center border-b px-6">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <SidebarNav items={items} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
