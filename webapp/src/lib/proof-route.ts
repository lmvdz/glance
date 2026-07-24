export const UNIT_PROOF_ROUTE_PREFIX = '#/proof';

export function buildUnitProofHash(unitId: string): string {
  return `${UNIT_PROOF_ROUTE_PREFIX}/${encodeURIComponent(unitId)}`;
}
