/**
 * Human-readable text for an unknown catch value — the ONE place the codebase spells out the
 * `instanceof Error` ternary idiom, pending the tagged-error hierarchy the effect-migration
 * ratchet tracks (see scripts/effect-migration.ts's `error-message-idiom` pattern). New catch
 * sites must call this instead of inlining the message-or-String ternary — an inline copy bites
 * the ratchet; a call to `errText(err)` doesn't match its regex at all. (This doc deliberately
 * never spells the ternary out verbatim: the ratchet scan is line-regex based, so even a comment
 * quoting it counts against the baseline.)
 *
 * Originally squad-manager.ts-private; extracted to its own module so worktree.ts (and any other
 * non-squad-manager caller) can share the ONE definition instead of re-inlining the idiom.
 */
export function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
