/**
 * Seed: creates a SUPER_ADMIN, a starter catalog of sources, and a
 * couple of sample (global) commission rules. Safe to re-run — uses
 * upserts by natural keys.
 *
 * Run via: pnpm db:seed
 */
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  // Never seed a default/known super-admin password into production.
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be set in production — refusing to seed a default admin password.',
    );
  }
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'AdminPassw0rd!';

  // Bypass RLS for seeding.
  await prisma.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);

  // --- Admin user ---
  // In PRODUCTION, force a password change on first login so the seeded credential
  // can't live forever (set only on create; a re-seed won't re-flag a rotated
  // admin). In dev/test we skip the flag so a clean re-seed leaves the admin
  // immediately usable by the app, the API, and the e2e suite (which logs in and
  // expects to land on /admin, not /change-password).
  const forcePasswordChange = process.env.NODE_ENV === 'production';
  const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { passwordHash },
    create: {
      email: adminEmail,
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      mustChangePassword: forcePasswordChange,
    },
  });

  // --- Sources ---
  const sources = [
    { code: 'whish', name: 'Whish Pay' },
    { code: 'omt', name: 'OMT' },
  ];
  for (const s of sources) {
    await prisma.source.upsert({
      where: { code: s.code },
      update: { name: s.name },
      create: s,
    });
  }

  // --- Whish source-fee schedule (what Whish charges THE PLATFORM per deposit) ---
  // System/admin-only cost data used to compute net revenue. It's the SAME source
  // as ingestion — only the per-transaction channel differs:
  //   INGEST    (direct ingest API):    ≤ $10 → flat $1, > $10 → 1%
  //   WHISH_PAY (company collect link): 1% on everything
  // Idempotent: only seeds when the source has no fee rules yet.
  const whish = await prisma.source.findUnique({ where: { code: 'whish' } });
  if (whish) {
    const existingFeeRules = await prisma.sourceFeeRule.count({ where: { sourceId: whish.id } });
    if (existingFeeRules === 0) {
      await prisma.sourceFeeRule.createMany({
        data: [
          // INGEST. The bands touch at exactly 10 on purpose — the analytics
          // resolver picks the LOWEST matching min_amount, so exactly $10 lands in
          // the flat-$1 tier ("$10 or under") and only $10.00000001+ in the 1% tier.
          {
            sourceId: whish.id,
            channel: 'INGEST',
            minAmount: '0',
            maxAmount: '10',
            feeType: 'FIXED',
            feeValue: '1',
          },
          {
            sourceId: whish.id,
            channel: 'INGEST',
            minAmount: '10',
            maxAmount: null,
            feeType: 'PERCENTAGE',
            feeValue: '1',
          },
          // WHISH_PAY: flat 1% on everything.
          {
            sourceId: whish.id,
            channel: 'WHISH_PAY',
            minAmount: '0',
            maxAmount: null,
            feeType: 'PERCENTAGE',
            feeValue: '1',
          },
        ],
      });
    }
  }

  // --- Whish externalId base (avoid cross-environment collisions) ---
  // whish_payments.external_id is a per-DB autoincrement that doubles as the
  // idempotency key sent to the Whish account. Local dev and the docker stack
  // point at the SAME (sandbox) Whish account, so a fresh DB starting at 1,2,3…
  // reuses ids dev already burned — Whish then returns the existing (empty)
  // record and the app surfaces "Whish did not return a collect URL". Seed the
  // sequence to the current epoch seconds (monotonic, and never below the
  // existing max) so every freshly-seeded DB starts in its own high, unused
  // range and can't collide. GREATEST keeps it safe on a non-reset re-seed.
  await prisma.$queryRawUnsafe(`
    SELECT setval(
      'public.whish_payments_external_id_seq',
      GREATEST(
        floor(extract(epoch from now()))::bigint,
        (SELECT COALESCE(MAX(external_id), 0) FROM whish_payments)
      ),
      true
    )
  `);

  // --- Sample global commission rules (company_id NULL = applies to all) ---
  // The spec example:
  //   1 → 100     => fixed 1$
  //   101 → 300   => fixed 5$
  //   301 → 1000  => 2%
  const sampleRules = [
    { minAmount: '1', maxAmount: '100', type: 'FIXED' as const, value: '1', priority: 100 },
    { minAmount: '101', maxAmount: '300', type: 'FIXED' as const, value: '5', priority: 100 },
    { minAmount: '301', maxAmount: '1000', type: 'PERCENTAGE' as const, value: '2', priority: 100 },
  ];
  // Skip if any global rule already exists (idempotent enough for a sample).
  const existingGlobal = await prisma.commissionRule.count({
    where: { companyId: null, sourceId: null },
  });
  if (existingGlobal === 0) {
    // All three tiers belong to ONE logical rule (all companies, default
    // operations), so they share a groupId — this is exactly what the new admin
    // UI creates and regroups by.
    const groupId = crypto.randomUUID();
    for (const r of sampleRules) {
      await prisma.commissionRule.create({
        data: {
          groupId,
          companyId: null,
          sourceId: null,
          minAmount: r.minAmount,
          maxAmount: r.maxAmount,
          commissionType: r.type,
          commissionValue: r.value,
          priority: r.priority,
          active: true,
        },
      });
    }
  }

  console.log('');
  console.log('==========================================');
  console.log(' Seed complete.');
  console.log(' Super admin:');
  console.log('   email:    ', admin.email);
  // Never print the real credential into production deploy logs.
  console.log(
    '   password: ',
    process.env.NODE_ENV === 'production'
      ? '(from SEED_ADMIN_PASSWORD — change required on first login)'
      : adminPassword,
  );
  console.log('==========================================');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
