import {
  FEE_OPERATION_TYPES,
  Money,
  type AuditChanges,
  type CommissionType,
  type FeeOperationType,
  type NetworkFeeConfigResponse,
  type SetNetworkFeeConfigInput,
} from '@app/shared';

/** One stored company_network_fees row, as Prisma returns it. */
export interface NetworkFeeRow {
  operationType: FeeOperationType;
  feeType: CommissionType;
  feeValue: { toString(): string };
}

/**
 * A rate in canonical form: every digit it carries, no trailing zeros ("2.00"
 * → "2", "0.125" stays "0.125"). Never Money.toString(), which rounds to cents
 * and would turn a 0.125% rate into 0.12%.
 */
function canonicalRate(value: string): string {
  return Money.of(value).toExactString();
}

/** The config as the API returns it: rates in flow order, values canonical. */
export function toNetworkFeeConfig(
  enabled: boolean,
  rows: ReadonlyArray<NetworkFeeRow>,
): NetworkFeeConfigResponse {
  const byOp = new Map(rows.map((r) => [r.operationType, r]));
  return {
    enabled,
    rates: FEE_OPERATION_TYPES.flatMap((operationType) => {
      const r = byOp.get(operationType);
      return r
        ? [{ operationType, feeType: r.feeType, feeValue: canonicalRate(r.feeValue.toString()) }]
        : [];
    }),
  };
}

/**
 * The audit diff of a network-fee save: the switch, plus one scalar per flow
 * ("PERCENTAGE 1", "FIXED 2", or null = not charged). Values are compared in
 * canonical form, so re-saving "2.00" over "2" records no change. The field
 * names are fixed here (never derived from input) and match no sensitive
 * pattern in recordAuditChanges.
 */
export function diffNetworkFeeConfig(
  before: NetworkFeeConfigResponse,
  after: SetNetworkFeeConfigInput,
): AuditChanges {
  const changes: AuditChanges = {};
  if (before.enabled !== after.enabled) {
    changes.networkFeeEnabled = { from: before.enabled, to: after.enabled };
  }
  const label = (
    rates: ReadonlyArray<{
      operationType: FeeOperationType;
      feeType: CommissionType;
      feeValue: string;
    }>,
    op: FeeOperationType,
  ): string | null => {
    const r = rates.find((x) => x.operationType === op);
    return r ? `${r.feeType} ${canonicalRate(r.feeValue)}` : null;
  };
  for (const op of FEE_OPERATION_TYPES) {
    const from = label(before.rates, op);
    const to = label(after.rates, op);
    if (from !== to) changes[`networkFee.${op}`] = { from, to };
  }
  return changes;
}
