/**
 * Org-scoping context for the DAL (MT-SaaS P0).
 *
 * `withOrg` is the ONLY way the DAL touches data. It opens a transaction and,
 * on Postgres, sets the `app.current_org` GUC transaction-locally
 * (`set_config(…, true)`) so the RLS policies installed by the migrations filter
 * every row to the caller's org — even if a query forgets its `where org_id`.
 * Transaction-local is the right scope for a pooled connection: the setting
 * cannot leak to the next checkout.
 *
 * Defense in depth: RLS is the *backstop*. The DAL queries themselves still
 * carry an explicit `org_id = orgId` predicate (the primary guard), so SQLite
 * self-host — which has no RLS — is equally isolated.
 */

import { Kysely, sql, type Transaction } from "kysely";
import type { DbKind } from "../db/index.ts";
import type { AppDatabase } from "../db/schema.ts";

export interface OrgContext {
	db: Kysely<AppDatabase>;
	type: DbKind;
}

/** Run `fn` inside a transaction scoped to `orgId` (RLS GUC set on Postgres). */
export function withOrg<T>(ctx: OrgContext, orgId: string, fn: (trx: Transaction<AppDatabase>) => Promise<T>): Promise<T> {
	if (!orgId) throw new Error("withOrg: orgId is required");
	return ctx.db.transaction().execute(async (trx) => {
		if (ctx.type === "postgres") {
			await sql`select set_config('app.current_org', ${orgId}, true)`.execute(trx);
		}
		return fn(trx);
	});
}
