'use client';
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
  ShieldCheck,
  Link2,
  Settings,
} from 'lucide-react';
import { DashboardSidebar } from '@/components/nav/dashboard-sidebar';
import type { NavItem } from '@/components/nav/sidebar-nav';

export const adminNavItems: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/sources', label: 'Sources', icon: Boxes },
  { href: '/admin/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/admin/withdrawals', label: 'Withdrawals', icon: Wallet },
  { href: '/admin/payouts', label: 'Payouts', icon: HandCoins },
  { href: '/admin/loads', label: 'Loads', icon: ArrowDownToLine },
  { href: '/admin/commissions', label: 'Commission Rules', icon: Percent },
  { href: '/admin/whish', label: 'Whish Pay', icon: Link2 },
  { href: '/admin/audit', label: 'Audit Logs', icon: ClipboardList },
  { href: '/admin/users', label: 'Platform Admins', icon: ShieldCheck },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
];

export function AdminSidebar() {
  return (
    <DashboardSidebar
      title="Txn Admin"
      items={adminNavItems}
      storageKey="admin-sidebar-collapsed"
    />
  );
}
