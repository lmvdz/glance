/**
 * Type-level DTO conformance (eap-borrows follow-up #3): the webapp's DTOs under
 * `webapp/src/lib/dto.ts` are HAND-MAINTAINED mirrors of backend wire types in `src/types.ts`, with no
 * compiler edge between them — `tsc` passes cleanly on both sides of a field the mirror forgot, dropped,
 * or silently retyped (that's exactly how `ValidationRecordDTO` ended up missing `gateLogPaths`, and had
 * already been missing `lensAdvisory`/`lensVerify`, undetected). This file IS that edge: it is wired
 * into the root tsconfig's `include` (see tsconfig.json) so a violation fails
 * `bunx tsc --noEmit -p .` (part of `bun run check`), not just a runtime read nobody happened to
 * exercise.
 *
 * Deliberately a SUBSET check, not full structural equality: a DTO may legitimately omit fields the
 * webapp has no reader for yet (see plans/eap-borrows/00-overview.md's follow-ups list). The guarantee
 * this makes: every key a DTO DOES declare exists on its backend source type with the IDENTICAL type —
 * a backend field renamed out from under a DTO, or retyped, breaks the build; a NEW backend field the
 * DTO is meant to carry can't silently vanish from the mirror once the DTO claims to carry it (that
 * "claims to carry it" moment is exactly a rename: the old key becomes an EXTRA key on the DTO with no
 * backend counterpart, which this check also catches).
 *
 * `.test-d.ts` naming (mirrors the `tsd`/`expect-type` convention): type-only, no `bun:test` import, no
 * runtime assertions — every import here is `import type`, so the whole file fully erases at
 * transpile time and contributes zero runtime behavior even if a test runner's glob happens to pick it
 * up (bun's default `*.test.{ts,tsx}` glob does not match `*.test-d.ts`, so it isn't run as a test
 * either — this file's only job is to exist inside the `tsc` program).
 */

import type { ValidationRecord } from "../src/types.ts";
import type { ValidationRecordDTO } from "../webapp/src/lib/dto.ts";

/** Mutual-assignability type equality — `true` only when `A` and `B` are the EXACT same type (not
 *  merely assignable one way), so a widened/narrowed DTO field is caught, not just a missing one. The
 *  double-conditional-over-generic-function form is the standard `tsd`/`expect-type` idiom; it avoids
 *  the naive `A extends B ? B extends A ? ... : false : false` form's false positives on `any` and its
 *  failures across distributive-conditional-type edge cases. */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless `T` is exactly `true` — assigning a computed `false` (or anything else) to
 *  this generic's constraint is a type error at the assertion site, not a boolean you'd have to run
 *  something to notice. */
export type Expect<T extends true> = T;

/** Keys `Dto` declares that `Source` does not have at all — must be `never`. A non-`never` result here
 *  IS the offending key name(s), surfaced directly in the compiler error (e.g. a field renamed on the
 *  backend, leaving a now-orphaned DTO key of the old name). */
export type ExtraDtoKeys<Dto, Source> = Exclude<keyof Dto, keyof Source>;

/** Keys BOTH types share whose value types diverge — must be `never`. A non-`never` result here is the
 *  key(s) whose type drifted between the backend source and its DTO mirror. */
export type MismatchedSharedKeys<Dto, Source> = {
	[K in keyof Dto & keyof Source]: Equals<Dto[K], Source[K]> extends true ? never : K;
}[keyof Dto & keyof Source];

// ── ValidationRecordDTO ⊆ ValidationRecord, and every shared key is byte-identical ─────────────────────
// The concrete drift this follow-up closes: `gateLogPaths` (and, pre-existing, `lensAdvisory`/
// `lensVerify`) were on `ValidationRecord` but missing from `ValidationRecordDTO` — added to the DTO
// alongside this check so the NEXT such field can't repeat it silently.
export type _ValidationRecordDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<ValidationRecordDTO, ValidationRecord>] extends [never] ? true : false>;
export type _ValidationRecordDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<ValidationRecordDTO, ValidationRecord>] extends [never] ? true : false>;
