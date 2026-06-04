-- Add BACKOFFICE: an operational platform-admin role. Back-office staff handle
-- the money-movement queues (withdrawals/payouts/loads) and view companies,
-- transactions and Whish, but cannot reach platform configuration or company
-- analytics. Page access is enforced per-endpoint in the API; this only widens
-- the enum so such users can be created.

ALTER TYPE "UserRole" ADD VALUE 'BACKOFFICE';
