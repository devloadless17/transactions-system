'use client';
import {
  LayoutDashboard,
  Building2,
  Boxes,
  ArrowLeftRight,
  Banknote,
  Wallet,
  HandCoins,
  ArrowDownToLine,
  Percent,
  ClipboardList,
  ShieldCheck,
  Link2,
  ScrollText,
  Send,
  Settings,
} from 'lucide-react';
import type { UserRole } from '@app/shared';
import { DashboardSidebar } from '@/components/nav/dashboard-sidebar';
import type { NavItem } from '@/components/nav/sidebar-nav';
import { usePendingCounts } from '@/features/operations/use-pending-counts';
import { useAdminAttention } from '@/features/operations/use-admin-attention';
import { canSeeAdminSection } from './access';

export const adminNavItems: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/sources', label: 'Sources', icon: Boxes },
  { href: '/admin/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/admin/deposits', label: 'Deposits', icon: Banknote },
  {
    href: '/admin/withdrawals',
    label: 'Withdrawals',
    icon: Wallet,
    badgeKey: 'withdrawals',
    alertKey: 'withdrawals',
  },
  { href: '/admin/loads', label: 'Loads', icon: ArrowDownToLine, badgeKey: 'loads' },
  { href: '/admin/payouts', label: 'Payouts', icon: HandCoins, badgeKey: 'payouts' },
  { href: '/admin/commissions', label: 'Commission Rules', icon: Percent },
  { href: '/admin/whish', label: 'Whish Pay', icon: Link2, alertKey: 'whish' },
  { href: '/admin/transfer-money', label: 'Transfer Money', icon: Send },
  { href: '/admin/transaction-logs', label: 'Transaction Logs', icon: ScrollText },
  { href: '/admin/audit', label: 'Audit Logs', icon: ClipboardList },
  { href: '/admin/users', label: 'Platform Admins', icon: ShieldCheck },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
];

/** Nav items visible to the given admin role (back office sees a subset). */
export function adminNavItemsFor(role: UserRole): NavItem[] {
  return adminNavItems.filter((item) => canSeeAdminSection(role, item.href));
}

/** Red sidebar alerts: money stuck that a person must look at (see useAdminAttention). */
export function useAdminNavAlerts(): Record<string, number> {
  const attention = useAdminAttention();
  return {
    withdrawals: attention?.stuckWithdrawals.count ?? 0,
    whish: attention?.whishNeedsAttention.count ?? 0,
  };
}

export function AdminSidebar({ role }: { role: UserRole }) {
  const badges = usePendingCounts('admin');
  const alerts = useAdminNavAlerts();
  return (
    <DashboardSidebar
      items={adminNavItemsFor(role)}
      storageKey="admin-sidebar-collapsed"
      badges={badges}
      alerts={alerts}
    />
  );
}
