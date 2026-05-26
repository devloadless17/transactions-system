// Mirrors the DB enums in packages/db/prisma/schema.prisma.
// Kept in sync manually — short enough to be safe; a generator
// could replace this later if drift becomes a risk.

export const UserRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN_OPERATOR: 'ADMIN_OPERATOR',
  COMPANY_OWNER: 'COMPANY_OWNER',
  COMPANY_MANAGER: 'COMPANY_MANAGER',
  COMPANY_VIEWER: 'COMPANY_VIEWER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const ADMIN_ROLES: ReadonlyArray<UserRole> = [UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR];
export const COMPANY_ROLES: ReadonlyArray<UserRole> = [
  UserRole.COMPANY_OWNER,
  UserRole.COMPANY_MANAGER,
  UserRole.COMPANY_VIEWER,
];

export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.includes(role);
}

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  PENDING: 'PENDING',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const CompanyStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
} as const;
export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

export const SourceStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;
export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus];

export const CommissionType = {
  FIXED: 'FIXED',
  PERCENTAGE: 'PERCENTAGE',
} as const;
export type CommissionType = (typeof CommissionType)[keyof typeof CommissionType];

export const TransactionStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
  REFUNDED: 'REFUNDED',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const LedgerAccountType = {
  AVAILABLE: 'AVAILABLE',
  PENDING: 'PENDING',
  RESERVED: 'RESERVED',
  FEE: 'FEE',
  EXTERNAL: 'EXTERNAL',
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

export const LedgerDirection = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export const PayoutMethod = {
  BANK_TRANSFER: 'BANK_TRANSFER',
  CRYPTO: 'CRYPTO',
  CASH: 'CASH',
  WISH: 'WISH',
  OTHER: 'OTHER',
} as const;
export type PayoutMethod = (typeof PayoutMethod)[keyof typeof PayoutMethod];

// Methods offered to companies for withdrawal/payout/load flows. Bank
// transfers are intentionally excluded — operators settle off-platform
// via Whish Money, cash handover, or crypto.
export const SUPPORTED_PAYOUT_METHODS: ReadonlyArray<PayoutMethod> = [
  PayoutMethod.WISH,
  PayoutMethod.CASH,
  PayoutMethod.CRYPTO,
  PayoutMethod.OTHER,
];

// Status is shared across all three processes (withdrawal/payout/load).
export const WithdrawalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

// ISO 4217 currency codes used by the platform. Expand as needed.
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'LBP', 'AED', 'SAR'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
