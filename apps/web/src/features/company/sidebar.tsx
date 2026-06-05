'use client';
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
  Link2,
  FileText,
} from 'lucide-react';
import { DashboardSidebar } from '@/components/nav/dashboard-sidebar';
import type { NavItem } from '@/components/nav/sidebar-nav';

export const companyNavItems: NavItem[] = [
  { href: '/app', label: 'Overview', icon: LayoutDashboard },
  { href: '/app/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/app/wallets', label: 'Wallets', icon: Wallet },
  { href: '/app/ledger', label: 'Ledger', icon: BookOpen },
  { href: '/app/withdrawals', label: 'Withdrawals', icon: ArrowUpFromLine },
  { href: '/app/payouts', label: 'Payouts', icon: HandCoins },
  { href: '/app/loads', label: 'Loads', icon: ArrowDownToLine },
  { href: '/app/whish', label: 'Whish Pay', icon: Link2 },
  { href: '/app/documentation', label: 'Documentation', icon: FileText },
  { href: '/app/sources', label: 'Sources', icon: Boxes },
  { href: '/app/team', label: 'Team', icon: Users },
  { href: '/app/settings', label: 'Settings', icon: Settings },
];

export function CompanySidebar() {
  return (
    <DashboardSidebar
      title="Company"
      items={companyNavItems}
      storageKey="company-sidebar-collapsed"
    />
  );
}
