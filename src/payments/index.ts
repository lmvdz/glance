/**
 * Payments module — real reward disbursement seam.
 *
 * Public surface:
 *   - PaymentProvider / PayoutRequest / PayoutResult — the provider contract.
 *   - ManualProvider     — records-only ledger entry (no network), preserves pre-Tremendous behavior.
 *   - TremendousProvider — real disbursement via the Tremendous Orders API.
 *   - paymentProviderFromEnv() — picks Tremendous when OMP_SQUAD_TREMENDOUS_API_KEY is set, else Manual.
 */

export type { PaymentProvider, PayoutRequest, PayoutResult, PayoutStatus } from "./types.ts";
export { ManualProvider, type ManualProviderOptions } from "./manual.ts";
export {
	TremendousProvider,
	type TremendousProviderOptions,
	type FetchLike,
	tremendousFromEnv,
	TREMENDOUS_SANDBOX_BASE,
	TREMENDOUS_PRODUCTION_BASE,
} from "./tremendous.ts";

import type { PaymentProvider } from "./types.ts";
import { ManualProvider, type ManualProviderOptions } from "./manual.ts";
import { tremendousFromEnv } from "./tremendous.ts";

/**
 * Select the active payout provider from the environment.
 *
 * Returns a real `TremendousProvider` when `OMP_SQUAD_TREMENDOUS_API_KEY` is set (the presence of the
 * key is the activation switch). Otherwise returns a `ManualProvider` — no creds means no network,
 * preserving the original "operator records an out-of-band payout" behavior.
 *
 * `manual` options let a caller carry the operator-supplied externalRef/provider label through to the
 * fallback ManualProvider (used by `markFeedbackRewardPaid`'s manual path).
 */
export function paymentProviderFromEnv(env: NodeJS.ProcessEnv = process.env, manual: ManualProviderOptions = {}): PaymentProvider {
	return tremendousFromEnv(env) ?? new ManualProvider(manual);
}
