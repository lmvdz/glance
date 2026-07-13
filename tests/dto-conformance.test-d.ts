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
 * Blind review follow-up (this file's original SUBSET design didn't catch the bug it was built for): a
 * "DTO keys ⊆ Source keys" check passes trivially the moment someone adds a NEW backend field and simply
 * forgets to mirror it — the DTO stays a valid subset either way, so the exact defect this file exists to
 * catch (`gateLogPaths` sitting on `ValidationRecord` for months with no compiler edge to `dto.ts`) would
 * have sailed straight through the old check too. Redesigned to EQUALITY-minus-an-explicit-omit-list: a
 * DTO's keys must equal its backend source's keys, MINUS a `OmittedFromDto` union the mirror author has
 * to name on purpose. `UnmirroredSourceKeys` is the new arm — every backend field that is neither on the
 * DTO nor in the omit list fails the build. Adding a backend field now forces a conscious choice (mirror
 * it, or name it in `OmittedFromDto`); neither can happen by accident, and both are compile errors
 * otherwise. Verified live: added a throwaway field to `ValidationRecord` with no DTO/omit-list
 * counterpart, confirmed `bunx tsc --noEmit -p .` failed on `_ValidationRecordDtoMirrorsEveryBackendField`
 * naming the new field, then reverted it.
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

/** Keys `Source` declares that NEITHER `Dto` NOR the explicit `Omitted` union covers — must be `never`.
 *  A non-`never` result here IS the offending key name(s): a backend field nobody made a conscious
 *  decision about yet. This is the arm the old subset-only check was missing — `ExtraDtoKeys` alone
 *  can never fail on a field that simply never got added to the DTO, which is exactly how
 *  `gateLogPaths` went unmirrored for months with a "passing" conformance file sitting right next to
 *  it. Combined with `ExtraDtoKeys` + `MismatchedSharedKeys`, the three checks together assert
 *  `keyof Dto === keyof Source \ Omitted` — equality minus a deliberate, named exclusion list, not a
 *  one-directional subset. */
export type UnmirroredSourceKeys<Dto, Source, Omitted extends keyof Source = never> = Exclude<keyof Source, keyof Dto | Omitted>;

// ── ValidationRecordDTO == ValidationRecord \ OmittedFromValidationRecordDto ────────────────────────────
// The concrete drift this follow-up closes: `gateLogPaths` (and, pre-existing, `lensAdvisory`/
// `lensVerify`) were on `ValidationRecord` but missing from `ValidationRecordDTO` — added to the DTO
// alongside this check so the NEXT such field can't repeat it silently. Every field on `ValidationRecord`
// is mirrored today, so this omit list is empty — the NEXT backend field added here must either be
// mirrored onto `ValidationRecordDTO` or named below on purpose; leaving it out of both fails the build
// via `_ValidationRecordDtoMirrorsEveryBackendField`, not silently.
export type OmittedFromValidationRecordDto = never;
export type _ValidationRecordDtoHasNoExtraKeys = Expect<[ExtraDtoKeys<ValidationRecordDTO, ValidationRecord>] extends [never] ? true : false>;
export type _ValidationRecordDtoSharedKeysMatch = Expect<[MismatchedSharedKeys<ValidationRecordDTO, ValidationRecord>] extends [never] ? true : false>;
export type _ValidationRecordDtoMirrorsEveryBackendField = Expect<[UnmirroredSourceKeys<ValidationRecordDTO, ValidationRecord, OmittedFromValidationRecordDto>] extends [never] ? true : false>;
