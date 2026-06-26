import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
	FeedbackAttachment,
	FeedbackCampaign,
	FeedbackItem,
	FeedbackKind,
	FeedbackReward,
	FeedbackRewardStatus,
	FeedbackValidationResponse,
	FeedbackValidationVote,
} from "./types.ts";

export interface FeedbackSnapshot {
	campaigns: FeedbackCampaign[];
	items: FeedbackItem[];
	validations: FeedbackValidationResponse[];
	rewards: FeedbackReward[];
}

export interface FeedbackInput {
	campaignId: string;
	repo: string;
	kind: FeedbackKind;
	title: string;
	description: string;
	url?: string;
	userId?: string;
	userEmail?: string;
	browser?: string;
	viewport?: string;
	metadata?: Record<string, unknown>;
	attachment?: FeedbackItem["attachment"];
}

export interface PublicFeedbackSubmission {
	campaignId?: unknown;
	token?: unknown;
	kind?: unknown;
	title?: unknown;
	description?: unknown;
	url?: unknown;
	userId?: unknown;
	userEmail?: unknown;
	browser?: unknown;
	viewport?: unknown;
	metadata?: unknown;
	screenshotDataUrl?: unknown;
}

export interface AcceptedFeedbackSubmission {
	item: FeedbackItem;
	reward?: FeedbackReward;
	attachmentBytes?: Uint8Array;
	attachmentExt?: "png" | "jpg";
}

export interface FeedbackValidationInput {
	respondent?: unknown;
	vote?: unknown;
	wouldUse?: unknown;
	pain?: unknown;
	note?: unknown;
}

export interface FeedbackValidationScore {
	yes: number;
	no: number;
	unsure: number;
	total: number;
	averagePain?: number;
	yesRatio: number;
	confidence: "none" | "weak" | "medium" | "strong";
}

export interface RenderedFeedbackPlaneIssue {
	title: string;
	descriptionHtml: string;
}

export type NormalizedFeedbackInput = Omit<FeedbackItem, "id" | "status" | "rewardStatus" | "planeIssue" | "createdAt" | "updatedAt">;

export interface FeedbackSummary {
	id: string;
	campaignId: string;
	repo: string;
	kind: FeedbackKind;
	title: string;
	status: FeedbackItem["status"];
	rewardStatus: FeedbackReward["status"];
	validationCount: number;
	votes: Record<FeedbackValidationVote, number>;
	averagePain?: number;
	hasAttachment: boolean;
	planeIssue?: FeedbackItem["planeIssue"];
	createdAt: number;
	updatedAt: number;
}

const KINDS: Record<FeedbackKind, true> = { bug: true, feature: true, friction: true };
const VOTES: Record<FeedbackValidationVote, true> = { valid: true, invalid: true, unsure: true };
const DEFAULT_MAX_IMAGE_BYTES = 2_000_000;

export function emptyFeedbackSnapshot(): FeedbackSnapshot {
	return { campaigns: [], items: [], validations: [], rewards: [] };
}

export function newFeedbackId(): string {
	return `fb_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function newCampaignId(): string {
	return `fc_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function newValidationId(): string {
	return `fv_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function newRewardId(): string {
	return `fr_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function hashCampaignToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function normalizeFeedbackInput(input: FeedbackInput): NormalizedFeedbackInput {
	if (!KINDS[input.kind]) throw new Error("invalid feedback kind");
	const campaignId = cleanRequired(input.campaignId, "campaignId", 120);
	const repo = cleanRequired(input.repo, "repo", 500);
	const title = cleanRequired(input.title, "title", 160);
	const description = cleanRequired(input.description, "description", 5000);
	return {
		campaignId,
		repo,
		kind: input.kind,
		title,
		description,
		url: cleanOptional(input.url, 2048),
		userId: cleanOptional(input.userId, 200),
		userEmail: cleanOptional(input.userEmail, 320),
		browser: cleanOptional(input.browser, 300),
		viewport: cleanOptional(input.viewport, 80),
		metadata: clampFeedbackMetadata(input.metadata),
		attachment: input.attachment,
	};
}

export function summarizeFeedback(item: FeedbackItem, validations: FeedbackValidationResponse[] = [], reward?: FeedbackReward): FeedbackSummary {
	const votes: Record<FeedbackValidationVote, number> = { valid: 0, invalid: 0, unsure: 0 };
	let painTotal = 0;
	let painCount = 0;
	for (const v of validations) {
		if (v.feedbackId !== item.id) continue;
		if (VOTES[v.vote]) votes[v.vote]++;
		if (typeof v.pain === "number") {
			painTotal += v.pain;
			painCount++;
		}
	}
	return {
		id: item.id,
		campaignId: item.campaignId,
		repo: item.repo,
		kind: item.kind,
		title: item.title,
		status: item.status,
		rewardStatus: reward?.status ?? item.rewardStatus,
		validationCount: votes.valid + votes.invalid + votes.unsure,
		votes,
		averagePain: painCount ? painTotal / painCount : undefined,
		hasAttachment: !!item.attachment,
		planeIssue: item.planeIssue,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

export function acceptFeedbackSubmission(opts: { campaigns: FeedbackCampaign[]; body: unknown; origin?: string | null; now?: number; maxImageBytes?: number }): AcceptedFeedbackSubmission {
	const body = objectBody(opts.body);
	const campaignId = stringField(body, "campaignId");
	const token = stringField(body, "token");
	const campaign = opts.campaigns.find((c) => c.id === campaignId && !c.archived);
	if (!campaign) throw new Error("unknown campaign");
	if (!campaignTokenMatches(token, campaign.tokenHash)) throw new Error("invalid campaign token");
	if (!originAllowed(campaign.allowedOrigins, opts.origin)) throw new Error("origin not allowed");

	const parsed = parseScreenshotDataUrl(body.screenshotDataUrl, opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES);
	const now = opts.now ?? Date.now();
	const input = normalizeFeedbackInput({
		campaignId: campaign.id,
		repo: campaign.repo,
		kind: kindField(body.kind),
		title: clampRequiredString(body.title, "title", 160),
		description: clampRequiredString(body.description, "description", 5000),
		url: optionalString(body.url),
		userId: optionalString(body.userId),
		userEmail: optionalString(body.userEmail),
		browser: optionalString(body.browser),
		viewport: optionalString(body.viewport),
		metadata: objectMetadata(body.metadata),
		attachment: parsed?.attachment,
	});
	const item: FeedbackItem = {
		id: newFeedbackId(),
		...input,
		status: "new",
		rewardStatus: campaign.rewardCents ? "pending" : "none",
		createdAt: now,
		updatedAt: now,
	};
	const reward = campaign.rewardCents
		? ({
				id: newRewardId(),
				feedbackId: item.id,
				campaignId: campaign.id,
				repo: campaign.repo,
				amount: campaign.rewardCents,
				currency: campaign.rewardCurrency ?? "USD",
				status: "pending",
				createdAt: now,
				updatedAt: now,
			} satisfies FeedbackReward)
		: undefined;
	return { item, reward, attachmentBytes: parsed?.bytes, attachmentExt: parsed?.ext };
}

export function normalizeFeedbackValidation(input: FeedbackValidationInput, item: FeedbackItem, now = Date.now()): FeedbackValidationResponse {
	let vote: FeedbackValidationVote;
	if (typeof input.wouldUse === "boolean") vote = input.wouldUse ? "valid" : "invalid";
	else vote = voteField(input.vote);
	return {
		id: newValidationId(),
		feedbackId: item.id,
		campaignId: item.campaignId,
		repo: item.repo,
		respondent: clampRequiredString(input.respondent, "respondent", 200),
		vote,
		pain: painField(input.pain),
		note: optionalClampedString(input.note, 1000),
		createdAt: now,
	};
}

/** Boring confidence formula: decisive yes/no answers drive confidence; unsure answers count only as volume. */
export function scoreValidation(responses: FeedbackValidationResponse[]): FeedbackValidationScore {
	const yes = responses.filter((r) => r.vote === "valid").length;
	const no = responses.filter((r) => r.vote === "invalid").length;
	const unsure = responses.filter((r) => r.vote === "unsure").length;
	const pain = responses.map((r) => r.pain).filter((p): p is number => typeof p === "number");
	const decisive = yes + no;
	const total = decisive + unsure;
	const yesRatio = decisive ? yes / decisive : 0;
	let confidence: FeedbackValidationScore["confidence"] = "none";
	if (decisive > 0) {
		if (decisive >= 5 && yesRatio >= 0.8) confidence = "strong";
		else if (decisive >= 3 && yesRatio >= 0.6) confidence = "medium";
		else confidence = "weak";
	}
	return { yes, no, unsure, total, averagePain: pain.length ? pain.reduce((a, b) => a + b, 0) / pain.length : undefined, yesRatio, confidence };
}

export function canTransitionReward(from: FeedbackRewardStatus, to: FeedbackRewardStatus, campaignHasReward = true): boolean {
	if (from === to) return true;
	if (from === "none" && to === "pending") return campaignHasReward;
	if (from === "pending" && (to === "approved" || to === "void")) return true;
	if (from === "approved" && (to === "paid" || to === "void")) return true;
	return false;
}

export function assertRewardTransition(from: FeedbackRewardStatus, to: FeedbackRewardStatus, campaignHasReward = true): void {
	if (!canTransitionReward(from, to, campaignHasReward)) throw new Error(`illegal reward transition: ${from} -> ${to}`);
}

export function renderFeedbackPlaneIssue(item: FeedbackItem, validations: FeedbackValidationResponse[] = [], reward?: FeedbackReward): RenderedFeedbackPlaneIssue {
	const relevant = validations.filter((v) => v.feedbackId === item.id);
	const score = scoreValidation(relevant);
	const rewardText = reward ? `${formatMoney(reward.amount, reward.currency)} (${reward.status})` : item.rewardStatus === "none" ? "none" : item.rewardStatus;
	const screenshot = item.attachment ? item.attachment.path ? `${item.attachment.path} (${item.attachment.contentType}, ${item.attachment.bytes} bytes, sha256 ${item.attachment.sha256})` : `${item.attachment.contentType}, ${item.attachment.bytes} bytes, sha256 ${item.attachment.sha256}` : "none";
	const validationRows = relevant.length
		? `<ul>${relevant.map((v) => `<li>${escapeHtml(v.respondent)}: ${escapeHtml(v.vote)}${typeof v.pain === "number" ? `, pain ${v.pain}/5` : ""}${v.note ? ` — ${escapeHtml(v.note)}` : ""}</li>`).join("")}</ul>`
		: "<p>None yet.</p>";
	return {
		title: `[Feedback] ${item.title}`.slice(0, 120),
		descriptionHtml: [
			"<h2>User Feedback</h2>",
			`<p><strong>Kind:</strong> ${escapeHtml(item.kind)}</p>`,
			`<p><strong>URL:</strong> ${escapeHtml(item.url ?? "not provided")}</p>`,
			`<p><strong>User:</strong> ${escapeHtml(item.userEmail ?? item.userId ?? "anonymous")}</p>`,
			`<p><strong>User segment / metadata:</strong> ${escapeHtml(formatMetadata(item.metadata))}</p>`,
			`<p><strong>Reward campaign:</strong> ${escapeHtml(rewardText)}</p>`,
			`<p><strong>Description:</strong></p><p>${escapeHtml(item.description).replace(/\n/g, "<br />")}</p>`,
			"<h2>Evidence</h2>",
			`<p><strong>Screenshot:</strong> ${escapeHtml(screenshot)}</p>`,
			`<p><strong>Browser / viewport:</strong> ${escapeHtml([item.browser, item.viewport].filter(Boolean).join(" / ") || "not provided")}</p>`,
			"<p><strong>Repro notes:</strong> Use the URL, screenshot, metadata, and description above as the reproduction contract.</p>",
			"<h2>Validation</h2>",
			`<p><strong>Responses:</strong> ${score.total} (${score.yes} valid, ${score.no} invalid, ${score.unsure} unsure)</p>`,
			`<p><strong>Pain score:</strong> ${score.averagePain === undefined ? "n/a" : `${score.averagePain.toFixed(1)}/5`}</p>`,
			`<p><strong>Confidence:</strong> ${score.confidence}</p>`,
			validationRows,
			"<h2>Acceptance Criteria</h2>",
			"<ul><li>Address the reported feedback with the smallest maintainable change.</li><li>Preserve existing behavior outside this feedback path.</li><li>Surface any product decision that cannot be derived from the evidence.</li></ul>",
			"<h2>Verification</h2>",
			"<ul><li>Add or update focused tests/QA for the resolved behavior.</li><li>Run the relevant verification gate for touched files before landing.</li></ul>",
			"<h2>Scope Boundary</h2>",
			"<ul><li>Do not implement unrelated roadmap items.</li><li>Do not change reward/payment state while implementing this issue.</li></ul>",
		].join("\n"),
	};
}

export function clampFeedbackMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(metadata ?? {}).slice(0, 20)) {
		const k = key.trim().slice(0, 64);
		if (!k) continue;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
		out[k] = String(value).slice(0, 500);
	}
	return out;
}

function campaignTokenMatches(token: string, tokenHash: string): boolean {
	const actual = Buffer.from(hashCampaignToken(token), "hex");
	const expected = Buffer.from(tokenHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function originAllowed(allowed: string[], origin: string | null | undefined): boolean {
	if (allowed.includes("*")) return true;
	if (!origin) return false;
	let actual: string;
	try {
		actual = new URL(origin).origin;
	} catch {
		return false;
	}
	return allowed.some((entry) => {
		try {
			return new URL(entry).origin === actual;
		} catch {
			return entry === actual;
		}
	});
}

function parseScreenshotDataUrl(value: unknown, maxBytes: number): { attachment: FeedbackAttachment; bytes: Uint8Array; ext: "png" | "jpg" } | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (Array.isArray(value)) throw new Error("only one screenshot is allowed");
	if (typeof value !== "string") throw new Error("screenshotDataUrl must be a data URL");
	const m = value.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
	if (!m || m[2].length % 4 !== 0) throw new Error("screenshotDataUrl must be a PNG or JPEG data URL");
	const buf = Buffer.from(m[2], "base64");
	if (buf.length > maxBytes) throw new Error("screenshot is too large");
	const sha256 = createHash("sha256").update(buf).digest("hex");
	const contentType = m[1] as "image/png" | "image/jpeg";
	return {
		attachment: { id: `att_${sha256.slice(0, 16)}`, kind: "screenshot", contentType, bytes: buf.length, sha256 },
		bytes: new Uint8Array(buf),
		ext: contentType === "image/png" ? "png" : "jpg",
	};
}

function objectBody(body: unknown): PublicFeedbackSubmission {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
	return body as PublicFeedbackSubmission;
}

function objectMetadata(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata must be an object");
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = v;
	return out;
}

function stringField(body: PublicFeedbackSubmission, key: "campaignId" | "token"): string {
	const value = body[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
	return value.trim();
}

function kindField(value: unknown): FeedbackKind {
	if (typeof value !== "string" || !KINDS[value as FeedbackKind]) throw new Error("invalid feedback kind");
	return value as FeedbackKind;
}

function voteField(value: unknown): FeedbackValidationVote {
	if (typeof value !== "string" || !VOTES[value as FeedbackValidationVote]) throw new Error("invalid validation vote");
	return value as FeedbackValidationVote;
}

function painField(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error("pain must be an integer from 1 to 5");
	return n;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function clampRequiredString(value: unknown, name: string, max: number): string {
	if (typeof value !== "string") throw new Error(`${name} is required`);
	const out = value.trim().slice(0, max);
	if (!out) throw new Error(`${name} is required`);
	return out;
}

function optionalClampedString(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const out = value.trim().slice(0, max);
	return out || undefined;
}

function cleanRequired(value: string, name: string, max: number): string {
	const out = value.trim();
	if (!out) throw new Error(`${name} is required`);
	if (out.length > max) throw new Error(`${name} is too long`);
	return out;
}

function cleanOptional(value: string | undefined, max: number): string | undefined {
	if (value === undefined) return undefined;
	const out = value.trim();
	if (!out) return undefined;
	if (out.length > max) throw new Error("value is too long");
	return out;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

function formatMetadata(metadata: Record<string, string>): string {
	const entries = Object.entries(metadata);
	return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(", ") : "none";
}

function formatMoney(cents: number, currency: string): string {
	return `${(cents / 100).toFixed(2)} ${currency}`;
}
