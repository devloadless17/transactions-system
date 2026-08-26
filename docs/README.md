# Documentation

One place for all Rival Payments documentation. Start here.

## Partner integration (external)

Audience-scoped guides — give a partner only the one for their role.

| Doc                                                                  | For                                             | Covers                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Whish Ingestion Guide](rival-ingest-api-integration.md)** (+ PDF) | The **Whish** technical team                    | The single slug-based `POST /ingest/whish/transactions` API — the only thing a source needs. Deliberately minimal: no discovery, no internal mechanics.                                                                          |
| **[Sources Integration Guide](sources-integration-docs.md)**         | A transaction **source** (internal ops copy)    | The full Ingest API surface incl. discovery, internals and boundary behaviour — the ops-side reference behind the partner guide above.                                                                                           |
| **[Company Developer Guide](company-developer-guide.md)**            | A **company's** engineering team (handout)      | Curated one-file guide mirroring the in-dashboard Documentation pages: getting started, Whish Pay, Company API, CRM integration.                                                                                                 |
| **[Companies Integration Guide](companies-integration-docs.md)**     | A **company's** developer team (full reference) | The exhaustive **Company API** reference (company API key): transactions, loads, withdrawals & payouts, wallets/ledger/activity, Whish payment collection, plus the **CRM webhooks** Rival sends you. No ingest/source API here. |

## Reference & operations (internal)

| Doc                                                                       | Covers                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Deployment](DEPLOYMENT.md)                                               | Production deploy / VPS / CI runbook.                                              |
| [Server operations](server-operations.md)                                 | Backups, restore drills, watchdog timers — server-side state outside the pipeline. |
| [Money scale](MONEY_SCALE.md)                                             | The one-page platform money-precision rule (2 dp), stated once and linked to.      |
| [Production-readiness audit prompt](PRODUCTION_READINESS_AUDIT_PROMPT.md) | Reusable template for running a full go/no-go audit.                               |
| [Security audit prompt](SECURITY_AUDIT_PROMPT.md)                         | Reusable template for running a security audit.                                    |

For the codebase overview and local dev setup, see the root
[`README.md`](../README.md) and [`GETTING_STARTED.md`](../GETTING_STARTED.md).

---

### Editing the guides

The `.md` files are the source of truth; the `.pdf` files are generated from them for
hand-off. After editing a `.md`, regenerate its PDF (rendered via `marked` + headless
Chromium via `scripts/md-to-pdf.mjs`).

The public guides are pinned by anti-drift tests (`apps/api/src/contract/docs-contract.spec.ts`):
if you change endpoint behaviour or doc wording those tests grep for, update both together.
