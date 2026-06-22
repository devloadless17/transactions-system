# Documentation

One place for all Rival Payments documentation. Start here.

## Partner integration (external)

Two audience-scoped guides — give a partner only the one for their role.

| Doc                                                              | For                                             | Covers                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[Companies Integration Guide](companies-integration-docs.md)** | A **company's** developer team                  | The full **Company API** (company API key): transactions, loads, withdrawals & payouts, wallets/ledger/activity, Whish payment collection, plus the **CRM webhooks** Rival sends you. Does **not** expose the ingest/source API. |
| **[Sources Integration Guide](sources-integration-docs.md)**     | A transaction **source** (Whish, OMT, banks, …) | The **Ingest API** (source API key): discover operating entities and submit transactions. Source-only — no company API or webhooks.                                                                                              |

## Reference & operations (internal)

| Doc                                                                                                                                    | Covers                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [Deployment](DEPLOYMENT.md)                                                                                                            | Production deploy / VPS / CI runbook.            |
| [WHISH PAY Web Service — Technical Specification v1.4.2](WHISH%20PAY%20Web%20Service%20-%20Technical%20Specification%20-%20v1.4.2.pdf) | Whish's own vendor spec (third-party reference). |

For the codebase overview and local dev setup, see the root
[`README.md`](../README.md) and [`GETTING_STARTED.md`](../GETTING_STARTED.md).

---

### Editing the guides

The `.md` files are the source of truth; the `.pdf` files are generated from them for
hand-off. After editing a `.md`, regenerate its PDF (rendered via `marked` + headless
Chromium) — ask and it'll be rebuilt.
