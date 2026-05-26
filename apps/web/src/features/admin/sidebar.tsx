'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Building2,
  Boxes,
  ArrowLeftRight,
  Wallet,
  HandCoins,
  ArrowDownToLine,
  Percent,
  ClipboardList,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const items = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/sources', label: 'Sources', icon: Boxes },
  { href: '/admin/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/admin/withdrawals', label: 'Withdrawals', icon: Wallet },
  { href: '/admin/payouts', label: 'Payouts', icon: HandCoins },
  { href: '/admin/loads', label: 'Loads', icon: ArrowDownToLine },
  { href: '/admin/commissions', label: 'Commission Rules', icon: Percent },
  { href: '/admin/audit', label: 'Audit Logs', icon: ClipboardList },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
] as const;

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-background md:flex">
      <div className="flex h-14 items-center px-6 font-semibold">Txn Admin</div>
      <nav className="flex-1 space-y-1 px-3 py-3">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
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
