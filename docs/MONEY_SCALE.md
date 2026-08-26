# Money scale

The rule, stated once. Every other mention of precision in this repo should link
here rather than restate it — the previous scale lived in nine prose copies and
they drifted.

## The rule

**Amounts are 2 decimal places (whole cents). Rates are up to 8.**

- An **amount** is money: a deposit, a fee, a balance, a payout. It is booked in
  cents, and `MONEY_SCALE = 2` in `packages/shared/src/money.ts` is the single
  definition. Everything else derives from it, including the tier `EPSILON` in
  the admin UI and the user-facing "at most N decimal places" messages.
- A **rate** is not money. It is only ever multiplied by an amount, and the
  _product_ is quantized at the compute site, so a rate keeps its precision. This
  is what makes `0.125%` an expressible price instead of a rounding error.

`commission_rules.commission_value` and `source_fee_rules.fee_value` are
**dual-typed**: dollars when the type is `FIXED`, a rate when `PERCENTAGE`. They
are validated per-type, not by column.

## Where quantization happens

Exactly three places, and nowhere else:

1. **On input**, at the edge schema — once, on receipt.
2. **On read from the database** — `Money.fromDb()`, so a row written before the
   scale change can never feed an over-scale value into a fresh calculation.
3. **On persistence** — `Money.round()` / `toString()`.

In between, arithmetic runs at full precision (`Decimal` with `precision: 30`).
`percent()` and `div()` deliberately do **not** round.

## The invariant that makes it safe

A ledger set must satisfy `Σ DEBIT == Σ CREDIT`, with every leg at scale and
greater than zero.

That holds **by construction** when a builder quantizes its _inputs_ once (the
gross amount and the fee) and derives every remaining leg by exact subtraction.
It breaks the moment anything rounds legs independently, because for a partition
`Σ round(legᵢ)` can differ from `round(Σ legᵢ)` — two legs of `0.005` each round
to `0.00` while their total rounds to `0.01`.

So `LedgerService.writeEntries` **asserts** the scale and throws
`LedgerScaleError`; it does not round. Reaching that error is a programming bug
in a money builder, not bad user input, and it names the fix in its message.

Directional rounding matters where the value is a bound:

- Capping against a **balance** uses `floorToScale()` — half-even could round
  _up_ past what the wallet holds and overdraw it.
- Settling a **debt** floors too, and is capped at the debt that actually exists:
  crediting more receivable than the ledger records would drive that account
  permanently negative and over-collect from the company. A sub-cent residue is
  therefore left unsettled by design — it must be written off deliberately, never
  invented at settlement time.

## We never reject a payment over precision

Money-moving surfaces **quantize rather than refuse**:

| Surface                                  | Behaviour                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Source ingest                            | round to nearest cent — the deposit already happened upstream; a 400 would strand real money                 |
| Whish collect                            | round to nearest cent — the payer has already paid, and Whish itself accepts amounts its own docs discourage |
| Withdrawal / payout                      | round **down** — accepted, but we never move more money than was requested                                   |
| Admin config (rules, caps, W2W transfer) | **reject** — a human is at a keyboard and a silently-rounded fee rule misprices every future transaction     |

## Storage

Columns are `Decimal(20, 8)` at rest. That is headroom for rows written before
the scale change, not an invitation to use it. Two exceptions keep the wider
scale permanently:

- **PERCENTAGE rule values**, per the rate rule above.
- **`ledger_entries.amount` and `wallets.*`.** The ledger is append-only and
  accepts only balanced sets, so appending can never repair a global imbalance —
  meaning historical rows cannot be re-scaled without falsifying the books. A
  wallet is that ledger's projection and must match it exactly, so it stays wide
  too. New rows are constrained to cents by a `CHECK`, not by the column type.

The data migration shipped in 2026-08 (cent-tier re-derivation + safe column narrowing); the runbook has been retired.
