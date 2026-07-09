import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Result } from "effect";
import {
	ChatAttachmentCreateBodySchema,
	CommentsCreateBodySchema,
	decodeBody,
	decodeBodyOrEmpty,
	FeatureAutoBodySchema,
	FeatureCreateBodySchema,
	FederationCommandBodySchema,
	OrgPatchBodySchema,
	PlanCandidateCreateBodySchema,
	PlanVoteCallBodySchema,
	PlanVoteCastBodySchema,
	PushSubscriptionBodySchema,
} from "../src/schema/http-body.ts";

// ---------------------------------------------------------------------------
// decodeBody — the generic helper
// ---------------------------------------------------------------------------

test("decodeBody: succeeds on a matching shape", () => {
	const r = decodeBody(FeatureCreateBodySchema, { title: "Ship it" });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success.title).toBe("Ship it");
});

test("decodeBody: fails with a bounded, single-line message on a missing required field", () => {
	const r = decodeBody(FeatureCreateBodySchema, {});
	expect(Result.isFailure(r)).toBe(true);
	if (Result.isFailure(r)) {
		expect(r.failure.message.length).toBeGreaterThan(0);
		expect(r.failure.message.length).toBeLessThanOrEqual(200);
		expect(r.failure.message).not.toContain("\n");
	}
});

test("decodeBody: fails on a wrong-typed required field", () => {
	expect(Result.isFailure(decodeBody(FeatureCreateBodySchema, { title: 42 }))).toBe(true);
});

test("decodeBody: fails on non-object bodies (null, array, primitive)", () => {
	expect(Result.isFailure(decodeBody(FeatureCreateBodySchema, null))).toBe(true);
	expect(Result.isFailure(decodeBody(FeatureCreateBodySchema, undefined))).toBe(true);
	expect(Result.isFailure(decodeBody(FeatureCreateBodySchema, [{ title: "x" }]))).toBe(true);
	expect(Result.isFailure(decodeBody(FeatureCreateBodySchema, "title"))).toBe(true);
});

test("decodeBody: Schema.Struct strips excess/injected keys", () => {
	const r = decodeBody(FeatureCreateBodySchema, { title: "Ship it", role: "admin", __proto__: { polluted: true } });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) {
		expect(r.success).toEqual({ title: "Ship it" });
		expect("role" in r.success).toBe(false);
	}
});

test("decodeBody: optional Schema.Unknown fields pass any shape through untouched", () => {
	const repo = { nested: { deep: [1, 2, 3] } };
	const r = decodeBody(FeatureCreateBodySchema, { title: "x", repo, planDir: 5 });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) {
		expect(r.success.repo).toEqual(repo);
		expect(r.success.planDir).toBe(5); // wrong type, but Unknown never rejects it
	}
});

// ---------------------------------------------------------------------------
// decodeBodyOrEmpty — the lenient variant used by "no required field" endpoints
// ---------------------------------------------------------------------------

test("decodeBodyOrEmpty: returns the decoded struct when the body is object-shaped", () => {
	expect(decodeBodyOrEmpty(OrgPatchBodySchema, { name: "Acme" })).toEqual({ name: "Acme" });
});

test("decodeBodyOrEmpty: falls back to {} on null/array/primitive bodies (matches prior silent-default behavior)", () => {
	expect(decodeBodyOrEmpty(OrgPatchBodySchema, null)).toEqual({});
	expect(decodeBodyOrEmpty(OrgPatchBodySchema, undefined)).toEqual({});
	expect(decodeBodyOrEmpty(OrgPatchBodySchema, [1, 2, 3])).toEqual({});
	expect(decodeBodyOrEmpty(OrgPatchBodySchema, "oops")).toEqual({});
});

test("decodeBodyOrEmpty: an individually-mistyped optional field never rejects the whole body", () => {
	// name is modeled as Schema.optional(Schema.Unknown) precisely so a malformed value doesn't
	// 400 the whole request — the handler does its own typeof narrowing afterward.
	expect(decodeBodyOrEmpty(OrgPatchBodySchema, { name: 123 })).toEqual({ name: 123 });
});

// ---------------------------------------------------------------------------
// A representative sample of endpoint schemas
// ---------------------------------------------------------------------------

test("PushSubscriptionBodySchema: requires endpoint + nested keys.p256dh/auth", () => {
	const valid = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
	const ok = decodeBody(PushSubscriptionBodySchema, valid);
	expect(Result.isSuccess(ok)).toBe(true);
	if (Result.isSuccess(ok)) expect(ok.success).toEqual(valid);

	expect(Result.isFailure(decodeBody(PushSubscriptionBodySchema, { endpoint: "https://push.example/abc" }))).toBe(true); // no keys
	expect(Result.isFailure(decodeBody(PushSubscriptionBodySchema, { endpoint: "https://push.example/abc", keys: { p256dh: "p" } }))).toBe(true); // no auth
	expect(Result.isFailure(decodeBody(PushSubscriptionBodySchema, { endpoint: 5, keys: { p256dh: "p", auth: "a" } }))).toBe(true); // endpoint not a string
});

test("CommentsCreateBodySchema: subject and body both required, everything else optional/unknown", () => {
	const r = decodeBody(CommentsCreateBodySchema, { subject: "s1", body: "hello", repo: "/r", urgent: true });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toEqual({ subject: "s1", body: "hello", repo: "/r", urgent: true });

	expect(Result.isFailure(decodeBody(CommentsCreateBodySchema, { body: "hello" }))).toBe(true); // no subject
	expect(Result.isFailure(decodeBody(CommentsCreateBodySchema, { subject: "s1" }))).toBe(true); // no body
});

test("PlanCandidateCreateBodySchema: planPath and summary both required", () => {
	expect(Result.isSuccess(decodeBody(PlanCandidateCreateBodySchema, { planPath: "plans/x", summary: "did a thing" }))).toBe(true);
	expect(Result.isFailure(decodeBody(PlanCandidateCreateBodySchema, { planPath: "plans/x" }))).toBe(true);
	expect(Result.isFailure(decodeBody(PlanCandidateCreateBodySchema, { summary: "did a thing" }))).toBe(true);
});

test("FeatureAutoBodySchema: goal required, title/repo/model pass through as Unknown", () => {
	const r = decodeBody(FeatureAutoBodySchema, { goal: "  ship it  ", title: 5, repo: { weird: true } });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) {
		expect(r.success.goal).toBe("  ship it  "); // trim-emptiness stays a post-decode business check
		expect(r.success.title).toBe(5);
	}
	expect(Result.isFailure(decodeBody(FeatureAutoBodySchema, {}))).toBe(true);
});

test("FederationCommandBodySchema: cmd stays Schema.Unknown so it is never key-stripped (would truncate the relayed command)", () => {
	const cmd = { type: "prompt", id: "a1", message: "hi", clientTurnId: "t1", displayText: "shown" };
	const r = decodeBody(FederationCommandBodySchema, { to: "peer-1", cmd });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success.cmd).toEqual(cmd); // every field survives, none stripped
});

test("ChatAttachmentCreateBodySchema: dataUrl required; mime/size/PNG-magic checks stay post-decode", () => {
	const r = decodeBody(ChatAttachmentCreateBodySchema, { dataUrl: "data:image/png;base64,iVBORw0KGgo=" });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toEqual({ dataUrl: "data:image/png;base64,iVBORw0KGgo=" });

	expect(Result.isFailure(decodeBody(ChatAttachmentCreateBodySchema, {}))).toBe(true); // no dataUrl
	expect(Result.isFailure(decodeBody(ChatAttachmentCreateBodySchema, { dataUrl: 5 }))).toBe(true); // not a string
});

test("PlanVoteCallBodySchema: no required field; candidateId/deadlineMs pass through as Unknown", () => {
	const r = decodeBody(PlanVoteCallBodySchema, { candidateId: "c1", deadlineMs: 60000 });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toEqual({ candidateId: "c1", deadlineMs: 60000 });

	// An empty/missing body decodes fine (both fields optional) — the handler resolves the head
	// candidate itself when candidateId is absent.
	expect(Result.isSuccess(decodeBody(PlanVoteCallBodySchema, {}))).toBe(true);
});

test("PlanVoteCastBodySchema: roundId and choice both required", () => {
	const r = decodeBody(PlanVoteCastBodySchema, { roundId: "pv1", choice: "approve" });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toEqual({ roundId: "pv1", choice: "approve" });

	expect(Result.isFailure(decodeBody(PlanVoteCastBodySchema, { choice: "approve" }))).toBe(true); // no roundId
	expect(Result.isFailure(decodeBody(PlanVoteCastBodySchema, { roundId: "pv1" }))).toBe(true); // no choice
	expect(Result.isFailure(decodeBody(PlanVoteCastBodySchema, { roundId: "pv1", choice: 5 }))).toBe(true); // choice not a string
});

test("bespoke endpoint schemas are not mirrors of a types.ts interface (documented, not a defect)", () => {
	// Sanity check that Schema.Struct really does strip unknowns on a second, differently-shaped
	// schema too — i.e. the stripping behavior isn't accidental to one specific struct above.
	const AdHoc = Schema.Struct({ a: Schema.String });
	const r = decodeBody(AdHoc, { a: "keep", b: "drop" });
	expect(Result.isSuccess(r)).toBe(true);
	if (Result.isSuccess(r)) expect(r.success).toEqual({ a: "keep" });
});
