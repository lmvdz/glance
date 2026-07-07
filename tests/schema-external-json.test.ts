/**
 * src/schema/external-json.ts — the decode-or-null boundary for the three small
 * external JSON payloads (WorkOS JWT claims, `tailscale whois` stdout, the
 * PLANE_PROJECT_MAP env). Each consumer's fail-soft contract is `null`; the
 * decode must reject wrong SHAPES (not just malformed JSON) that the old
 * `JSON.parse(...) as T` casts waved through.
 */

import { expect, test } from "bun:test";
import { decodeJsonWith, JwtClaimsSchema, PlaneProjectMapSchema, TailscaleWhoisSchema } from "../src/schema/external-json.ts";
import { decodeJwtPayload } from "../src/workos.ts";

test("decodeJsonWith: malformed JSON ⇒ null", () => {
	expect(decodeJsonWith(JwtClaimsSchema, "{nope")).toBeNull();
	expect(decodeJsonWith(TailscaleWhoisSchema, "")).toBeNull();
});

test("JwtClaimsSchema: objects pass, JSON scalars/arrays are rejected (the old cast accepted them)", () => {
	expect(decodeJsonWith(JwtClaimsSchema, JSON.stringify({ sub: "u1", org_id: "o1", n: 3 }))).toEqual({ sub: "u1", org_id: "o1", n: 3 });
	expect(decodeJsonWith(JwtClaimsSchema, "42")).toBeNull();
	expect(decodeJsonWith(JwtClaimsSchema, '"str"')).toBeNull();
	expect(decodeJsonWith(JwtClaimsSchema, "[1,2]")).toBeNull();
	expect(decodeJsonWith(JwtClaimsSchema, "null")).toBeNull();
});

test("decodeJwtPayload: round-trips a real payload segment and null-rejects a non-object one", () => {
	const seg = (v: unknown): string => `h.${Buffer.from(JSON.stringify(v)).toString("base64url")}.s`;
	expect(decodeJwtPayload(seg({ sub: "user_1", email: "a@b.c" }))).toEqual({ sub: "user_1", email: "a@b.c" });
	expect(decodeJwtPayload(seg([1, 2]))).toBeNull();
	expect(decodeJwtPayload("not-a-jwt")).toBeNull();
	expect(decodeJwtPayload(undefined)).toBeNull();
});

test("TailscaleWhoisSchema: valid shapes pass (empty UserProfile ok), mistyped LoginName is rejected", () => {
	expect(decodeJsonWith(TailscaleWhoisSchema, JSON.stringify({ UserProfile: { LoginName: "alice@ts.net", DisplayName: "Alice" } }))).toEqual({
		UserProfile: { LoginName: "alice@ts.net", DisplayName: "Alice" },
	});
	expect(decodeJsonWith(TailscaleWhoisSchema, "{}")).toEqual({});
	// A numeric LoginName would have become an `Actor.id` under the old cast.
	expect(decodeJsonWith(TailscaleWhoisSchema, JSON.stringify({ UserProfile: { LoginName: 42 } }))).toBeNull();
});

test("PlaneProjectMapSchema: string→string maps pass, non-string project ids are rejected", () => {
	expect(decodeJsonWith(PlaneProjectMapSchema, JSON.stringify({ "omp-squad": "proj-uuid" }))).toEqual({ "omp-squad": "proj-uuid" });
	expect(decodeJsonWith(PlaneProjectMapSchema, JSON.stringify({ repo: 7 }))).toBeNull();
	expect(decodeJsonWith(PlaneProjectMapSchema, "[]")).toBeNull();
});
