'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Wallet,
  Boxes,
  Settings,
  ArrowUpFromLine,
  ArrowDownToLine,
  HandCoins,
  Users,
  BookOpen,
  Code2,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const items = [
  { href: '/app', label: 'Overview', icon: LayoutDashboard },
  { href: '/app/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/app/wallets', label: 'Wallets', icon: Wallet },
  { href: '/app/ledger', label: 'Ledger', icon: BookOpen },
  { href: '/app/withdrawals', label: 'Withdrawals', icon: ArrowUpFromLine },
  { href: '/app/payouts', label: 'Payouts', icon: HandCoins },
  { href: '/app/loads', label: 'Loads', icon: ArrowDownToLine },
  { href: '/app/api-docs', label: 'API Docs', icon: Code2 },
  { href: '/app/sources', label: 'Sources', icon: Boxes },
  { href: '/app/team', label: 'Team', icon: Users },
  { href: '/app/settings', label: 'Settings', icon: Settings },
] as const;

export function CompanySidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-background md:flex">
      <div className="flex h-14 items-center px-6 font-semibold">Company</div>
      <nav className="flex-1 space-y-1 px-3 py-3">
        {items.map(({ href, label, icon: Icon }) => {
          const active =
            href === '/app'
              ? pathname === '/app'
              : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
