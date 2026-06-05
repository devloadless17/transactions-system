# Documentation

One place for all Rival Payments documentation. Start here.

## Partner integration (external)

| Doc                                                                                                 | For                       | Covers                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Integration Guide](rival-integration-guide.md)** ([PDF](rival-integration-guide.pdf))            | **Everyone — start here** | The canonical reference. **Part A – Ingest API** (how transaction _sources_ like Whish push transactions in) and **Part B – CRM Webhooks** (how _companies_ receive transaction events in their own CRM). Generic, no secrets. |
| [Whish onboarding sheet](rival-ingest-api-integration.md) ([PDF](rival-ingest-api-integration.pdf)) | The **Whish** team        | Partner-specific quick reference: Whish's issued source key + fixed `whish` URL, filled in for the Ingest API. A values-filled extract of the Guide's Part A. **Contains a live key — share privately.**                       |

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
