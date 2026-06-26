import { createHash } from "node:crypto";
import type { AgentProfile } from "../types.ts";
import type { WorkflowDefinition } from "../workflow-catalog.ts";

export type CapabilityFramework = "omp" | "workflow" | "flue" | "external";
export type CapabilityInstallState = "imported" | "validated" | "approved" | "enabled" | "disabled" | "failed" | "removed";
export type CapabilityBindingType = "profile" | "workflow" | "tool" | "skill" | "driver" | "ui-action" | "preview" | "doc";
export type CapabilityVerificationStatus = "passed" | "failed" | "warning";
export type CapabilityDiffRisk = "none" | "low" | "medium" | "high";

export interface CapabilityFile {
	path: string;
	content?: string;
	sha256?: string;
}

export interface CapabilityProfileSpec {
	id?: string;
	name: string;
	description?: string;
	model?: string;
	approvalMode?: AgentProfile["approvalMode"];
	instructions?: string;
	capabilities?: string[];
}

export interface CapabilityWorkflowSpec {
	id?: string;
	label: string;
	description?: string;
	path?: string;
	steps?: { id: string; label: string; owner?: string; next?: string[] }[];
}

export interface CapabilityToolSpec {
	name: string;
	description?: string;
	required?: boolean;
}

export interface CapabilitySkillSpec {
	name: string;
	description?: string;
}

export interface CapabilityPreviewSpec {
	kind: "markdown" | "html" | "artifact";
	path?: string;
	content?: string;
}

export interface CapabilityContextDeclaration {
	imports?: string[];
	exports?: string[];
	shareable?: boolean;
}

export interface CapabilityContextPolicy {
	installId: string;
	imports: string[];
	exports: string[];
	redactions: string[];
	allowedPeers: string[];
	retentionDays: number;
	shareable: boolean;
}

export interface CapabilitySource {
	id: string;
	name: string;
	url?: string;
	trusted: boolean;
	createdAt: number;
	updatedAt: number;
	lastSyncAt?: number;
}

export interface CapabilityPack {
	id: string;
	sourceId: string;
	framework: CapabilityFramework;
	slug: string;
	version: string;
	checksum: string;
	schemaVersion: string;
	title: string;
	description: string;
	files: CapabilityFile[];
	profiles: CapabilityProfileSpec[];
	workflows: CapabilityWorkflowSpec[];
	tools: CapabilityToolSpec[];
	skills: CapabilitySkillSpec[];
	requiredEnv: string[];
	preview?: CapabilityPreviewSpec;
	context?: CapabilityContextDeclaration;
	compatibility: { ompSquad: string; drivers: string[] };
	createdAt: number;
	extra: Record<string, unknown>;
}

export interface CapabilityBinding {
	id: string;
	installId: string;
	packId: string;
	version: string;
	checksum: string;
	type: CapabilityBindingType;
	key: string;
	sourcePath?: string;
	enabled: boolean;
	config: Record<string, unknown>;
}

export interface CapabilityInstall {
	id: string;
	orgId: string;
	packId: string;
	version: string;
	checksum: string;
	state: CapabilityInstallState;
	approvedBy?: string;
	overrides: Record<string, unknown>;
	bindings: CapabilityBinding[];
	contextPolicy?: CapabilityContextPolicy;
	previous?: { packId: string; version: string; checksum: string; bindings: CapabilityBinding[] };
	createdAt: number;
	updatedAt: number;
}

export interface CapabilityVerification {
	id: string;
	scope: "pack" | "install" | "upgrade" | "federation" | "context";
	targetId: string;
	status: CapabilityVerificationStatus;
	message: string;
	createdAt: number;
}

export interface CapabilityAuditEvent {
	id: string;
	actor: string;
	action: string;
	target: string;
	detail?: Record<string, unknown>;
	at: number;
}

export interface CapabilitySnapshot {
	sources: CapabilitySource[];
	packs: CapabilityPack[];
	installs: CapabilityInstall[];
	verifications: CapabilityVerification[];
	audit: CapabilityAuditEvent[];
}

export interface CapabilityImportInput {
	name?: string;
	url?: string;
	trusted?: boolean;
	manifest: unknown;
}

export interface CapabilityInstallInput {
	packId: string;
	orgId?: string;
	overrides?: Record<string, unknown>;
	enable?: boolean;
}

export interface CapabilityInstallPatch {
	state?: CapabilityInstallState;
	enabled?: boolean;
	removed?: boolean;
	overrides?: Record<string, unknown>;
	upgradeToPackId?: string;
	rollback?: boolean;
}

export interface CapabilityDiffEntry {
	field: string;
	before: unknown;
	after: unknown;
	risk: CapabilityDiffRisk;
}

export interface CapabilityFederationMetadata {
	packId: string;
	sourceId: string;
	framework: CapabilityFramework;
	slug: string;
	version: string;
	checksum: string;
	title: string;
	description: string;
	compatibility: CapabilityPack["compatibility"];
	context: { shareable: boolean; exports: string[] };
}

const EXECUTABLE_TOP_LEVEL = new Set(["scripts", "postinstall", "preinstall", "commands", "hooks", "execute"]);

export function emptyCapabilitySnapshot(): CapabilitySnapshot {
	return { sources: [], packs: [], installs: [], verifications: [], audit: [] };
}

export function normalizeCapabilitySnapshot(value: unknown): CapabilitySnapshot {
	if (!isRecord(value)) return emptyCapabilitySnapshot();
	return {
		sources: arrayOfRecords(value.sources).map(readSource).filter(isDefined),
		packs: arrayOfRecords(value.packs).map(readPack).filter(isDefined),
		installs: arrayOfRecords(value.installs).map(readInstall).filter(isDefined),
		verifications: arrayOfRecords(value.verifications).map(readVerification).filter(isDefined),
		audit: arrayOfRecords(value.audit).map(readAudit).filter(isDefined),
	};
}

export function importCapabilitySource(snapshot: CapabilitySnapshot, input: CapabilityImportInput, actor = "local", now = Date.now()): { source: CapabilitySource; pack: CapabilityPack; warnings: string[] } {
	const sourceId = stableId("src", input.url ?? input.name ?? "local");
	const existing = snapshot.sources.find((source) => source.id === sourceId);
	const source: CapabilitySource = existing ?? { id: sourceId, name: input.name?.trim() || input.url || "Capability source", url: input.url, trusted: input.trusted !== false, createdAt: now, updatedAt: now };
	source.name = input.name?.trim() || source.name;
	source.url = input.url ?? source.url;
	source.trusted = input.trusted ?? source.trusted;
	source.lastSyncAt = now;
	source.updatedAt = now;
	const parsed = parseCapabilityManifest(input.manifest, source.id, now);
	upsert(snapshot.sources, source, (item) => item.id);
	upsert(snapshot.packs, parsed.pack, (item) => item.id);
	recordVerification(snapshot, "pack", parsed.pack.id, "passed", parsed.warnings.length ? `Validated with ${parsed.warnings.length} warning(s)` : "Validated", now);
	recordAudit(snapshot, actor, "capability.source.import", source.id, { packId: parsed.pack.id, checksum: parsed.pack.checksum }, now);
	return { source, pack: parsed.pack, warnings: parsed.warnings };
}

export function parseCapabilityManifest(input: unknown, sourceId: string, now = Date.now()): { pack: CapabilityPack; warnings: string[] } {
	if (!isRecord(input)) throw new Error("manifest must be an object");
	for (const key of Object.keys(input)) if (EXECUTABLE_TOP_LEVEL.has(key)) throw new Error(`unsupported executable manifest field: ${key}`);
	const name = readString(input.name) ?? readString(input.slug) ?? readString(input.id);
	if (!name) throw new Error("manifest name required");
	const framework = readFramework(input.framework) ?? readFramework(input.runtime) ?? "external";
	const slug = slugify(name);
	const version = readString(input.version) ?? "0.0.0";
	const files = readFiles(input.files);
	const warnings: string[] = [];
	if (files.length === 0) warnings.push("manifest has no files");
	const title = readString(input.title) ?? name;
	const description = readString(input.description) ?? "";
	const checksum = sha256(stableJson({ sourceId, framework, slug, version, title, description, files, profiles: input.profiles, workflows: input.workflows, tools: input.tools, skills: input.skills, context: input.context }));
	return {
		warnings,
		pack: {
			id: stableId("pack", `${sourceId}:${framework}:${slug}:${version}:${checksum}`),
			sourceId,
			framework,
			slug,
			version,
			checksum,
			schemaVersion: readString(input.schemaVersion) ?? "1",
			title,
			description,
			files,
			profiles: readProfiles(input.profiles, title, description),
			workflows: readWorkflows(input.workflows),
			tools: readNamedSpecs(input.tools),
			skills: readNamedSpecs(input.skills),
			requiredEnv: readStringArray(input.requiredEnv),
			preview: readPreview(input.preview),
			context: readContext(input.context),
			compatibility: readCompatibility(input.compatibility, framework),
			createdAt: now,
			extra: readExtra(input),
		},
	};
}

export function installCapability(snapshot: CapabilitySnapshot, input: CapabilityInstallInput, actor = "local", now = Date.now()): CapabilityInstall {
	const pack = getPack(snapshot, input.packId);
	const orgId = input.orgId ?? "file";
	const existing = snapshot.installs.find((item) => item.packId === pack.id && item.orgId === orgId && item.state !== "removed");
	if (existing) return existing;
	const install: CapabilityInstall = {
		id: stableId("install", `${orgId}:${pack.id}:${now}`),
		orgId,
		packId: pack.id,
		version: pack.version,
		checksum: pack.checksum,
		state: input.enable === false ? "approved" : "enabled",
		approvedBy: actor,
		overrides: input.overrides ?? {},
		bindings: materializeBindings(pack, "", input.enable !== false),
		contextPolicy: defaultContextPolicy("", pack),
		createdAt: now,
		updatedAt: now,
	};
	install.bindings = materializeBindings(pack, install.id, install.state === "enabled");
	install.contextPolicy = defaultContextPolicy(install.id, pack);
	snapshot.installs.push(install);
	recordVerification(snapshot, "install", install.id, "passed", "Install bindings materialized", now);
	recordAudit(snapshot, actor, "capability.install", install.id, { packId: pack.id, state: install.state }, now);
	return install;
}

export function updateCapabilityInstall(snapshot: CapabilitySnapshot, id: string, patch: CapabilityInstallPatch, actor = "local", now = Date.now()): CapabilityInstall {
	const install = snapshot.installs.find((item) => item.id === id);
	if (!install) throw new Error("capability install not found");
	if (patch.rollback) {
		if (!install.previous) throw new Error("no previous capability version to roll back");
		install.packId = install.previous.packId;
		install.version = install.previous.version;
		install.checksum = install.previous.checksum;
		install.bindings = install.previous.bindings.map((binding) => ({ ...binding, enabled: install.state === "enabled" }));
		install.previous = undefined;
		recordAudit(snapshot, actor, "capability.rollback", install.id, { packId: install.packId, checksum: install.checksum }, now);
	} else if (patch.upgradeToPackId) {
		const next = getPack(snapshot, patch.upgradeToPackId);
		install.previous = { packId: install.packId, version: install.version, checksum: install.checksum, bindings: install.bindings };
		install.packId = next.id;
		install.version = next.version;
		install.checksum = next.checksum;
		install.bindings = materializeBindings(next, install.id, install.state === "enabled");
		install.contextPolicy = defaultContextPolicy(install.id, next);
		recordVerification(snapshot, "upgrade", install.id, "passed", "Upgrade bindings staged", now);
		recordAudit(snapshot, actor, "capability.upgrade", install.id, { packId: next.id, checksum: next.checksum }, now);
	}
	if (patch.overrides) install.overrides = { ...install.overrides, ...patch.overrides };
	if (patch.removed) install.state = "removed";
	if (patch.enabled !== undefined) install.state = patch.enabled ? "enabled" : "disabled";
	if (patch.state) install.state = patch.state;
	const enabled = install.state === "enabled";
	install.bindings = install.bindings.map((binding) => ({ ...binding, enabled }));
	install.updatedAt = now;
	recordAudit(snapshot, actor, `capability.${install.state}`, install.id, { packId: install.packId }, now);
	return install;
}

export function capabilityProfiles(snapshot: CapabilitySnapshot): AgentProfile[] {
	return snapshot.installs
		.filter((install) => install.state === "enabled")
		.flatMap((install) => install.bindings.filter((binding) => binding.enabled && binding.type === "profile").map(bindingToProfile));
}

export function capabilityWorkflowDefinitions(snapshot: CapabilitySnapshot): WorkflowDefinition[] {
	return snapshot.installs
		.filter((install) => install.state === "enabled")
		.flatMap((install) => install.bindings.filter((binding) => binding.enabled && binding.type === "workflow").map(bindingToWorkflow));
}

export function diffCapabilityPacks(before: CapabilityPack, after: CapabilityPack): CapabilityDiffEntry[] {
	const fields: Array<[string, CapabilityDiffRisk]> = [
		["title", "low"],
		["description", "low"],
		["profiles", "high"],
		["workflows", "high"],
		["tools", "high"],
		["skills", "medium"],
		["requiredEnv", "medium"],
		["context", "high"],
		["files", "high"],
	];
	return fields.flatMap(([field, risk]) => {
		const left = readField(before, field);
		const right = readField(after, field);
		return stableJson(left) === stableJson(right) ? [] : [{ field, before: left, after: right, risk }];
	});
}

export function capabilityFederationMetadata(snapshot: CapabilitySnapshot): CapabilityFederationMetadata[] {
	const installed = new Set(snapshot.installs.filter((install) => install.state === "enabled").map((install) => install.packId));
	return snapshot.packs.filter((pack) => installed.has(pack.id)).map((pack) => ({
		packId: pack.id,
		sourceId: pack.sourceId,
		framework: pack.framework,
		slug: pack.slug,
		version: pack.version,
		checksum: pack.checksum,
		title: pack.title,
		description: pack.description,
		compatibility: pack.compatibility,
		context: { shareable: pack.context?.shareable === true, exports: pack.context?.exports ?? [] },
	}));
}

export function canExportCapabilityContext(install: CapabilityInstall, namespace: string, peer: string): boolean {
	const policy = install.contextPolicy;
	if (!policy?.shareable) return false;
	if (!policy.allowedPeers.includes(peer) && !policy.allowedPeers.includes("*")) return false;
	return policy.exports.includes(namespace) || policy.exports.includes("*");
}

export function redactCapabilityContext(value: string, policy: CapabilityContextPolicy): string {
	return policy.redactions.reduce((text, token) => token ? text.split(token).join("[redacted]") : text, value);
}

function materializeBindings(pack: CapabilityPack, installId: string, enabled: boolean): CapabilityBinding[] {
	const profileSpecs = pack.profiles.length ? pack.profiles : [{ name: pack.title, description: pack.description, instructions: pack.description, capabilities: pack.tools.map((tool) => tool.name) }];
	const flueWorkflow = pack.workflows[0];
	const driverBindings: CapabilityBinding[] = pack.framework === "flue" ? [{
		id: stableId("bind", `${installId}:${pack.id}:driver:flue`),
		installId,
		packId: pack.id,
		version: pack.version,
		checksum: pack.checksum,
		type: "driver",
		key: `cap:${pack.slug}:flue-service`,
		enabled,
		config: { runtime: "flue-service", workflow: flueWorkflow?.path ?? flueWorkflow?.id ?? pack.slug, target: "node" },
	}] : [];
	return [
		...profileSpecs.map((profile, index): CapabilityBinding => ({
			id: stableId("bind", `${installId}:${pack.id}:profile:${profile.id ?? index}`),
			installId,
			packId: pack.id,
			version: pack.version,
			checksum: pack.checksum,
			type: "profile",
			key: `cap:${pack.slug}:${profile.id ?? slugify(profile.name)}`,
			enabled,
			config: { ...profile, runtime: "omp-operator", origin: { packId: pack.id, version: pack.version, checksum: pack.checksum } },
		})),
		...pack.workflows.map((workflow, index): CapabilityBinding => ({
			id: stableId("bind", `${installId}:${pack.id}:workflow:${workflow.id ?? index}`),
			installId,
			packId: pack.id,
			version: pack.version,
			checksum: pack.checksum,
			type: "workflow",
			key: `cap:${pack.slug}:${workflow.id ?? slugify(workflow.label)}`,
			sourcePath: workflow.path,
			enabled,
			config: { ...workflow, origin: { packId: pack.id, version: pack.version, checksum: pack.checksum } },
		})),
		...driverBindings,
		...pack.tools.map((tool): CapabilityBinding => ({ id: stableId("bind", `${installId}:${pack.id}:tool:${tool.name}`), installId, packId: pack.id, version: pack.version, checksum: pack.checksum, type: "tool", key: tool.name, enabled, config: { ...tool } })),
		...pack.skills.map((skill): CapabilityBinding => ({ id: stableId("bind", `${installId}:${pack.id}:skill:${skill.name}`), installId, packId: pack.id, version: pack.version, checksum: pack.checksum, type: "skill", key: skill.name, enabled, config: { ...skill } })),
	];
}

function bindingToProfile(binding: CapabilityBinding): AgentProfile {
	const config = binding.config;
	const id = readString(config.id) ?? binding.key;
	return {
		id,
		name: readString(config.name) ?? id,
		description: readString(config.description),
		runtime: "omp-operator",
		model: readString(config.model),
		approvalMode: readApprovalMode(config.approvalMode),
		capabilities: readStringArray(config.capabilities),
		memory: readString(config.instructions) ?? readString(config.memory),
	};
}

function bindingToWorkflow(binding: CapabilityBinding): WorkflowDefinition {
	const config = binding.config;
	const steps = arrayOfRecords(config.steps).map((step) => ({ id: readString(step.id) ?? "step", label: readString(step.label) ?? "Step", owner: readString(step.owner) ?? "Capability", allowed: [], disallowed: [], next: readStringArray(step.next) }));
	return {
		id: binding.key,
		kind: "workflow",
		label: readString(config.label) ?? binding.key,
		description: readString(config.description) ?? "Capability workflow",
		assigned: ["Capability"],
		allowed: ["run approved capability binding"],
		disallowed: ["run unapproved manifest content"],
		steps,
	};
}

function defaultContextPolicy(installId: string, pack: CapabilityPack): CapabilityContextPolicy {
	return {
		installId,
		imports: pack.context?.imports ?? [],
		exports: pack.context?.exports ?? [],
		redactions: [],
		allowedPeers: [],
		retentionDays: 30,
		shareable: pack.context?.shareable === true,
	};
}

function getPack(snapshot: CapabilitySnapshot, id: string): CapabilityPack {
	const pack = snapshot.packs.find((item) => item.id === id);
	if (!pack) throw new Error("capability pack not found");
	return pack;
}

function recordVerification(snapshot: CapabilitySnapshot, scope: CapabilityVerification["scope"], targetId: string, status: CapabilityVerificationStatus, message: string, now: number): void {
	snapshot.verifications.push({ id: stableId("verify", `${scope}:${targetId}:${now}:${message}`), scope, targetId, status, message, createdAt: now });
}

function recordAudit(snapshot: CapabilitySnapshot, actor: string, action: string, target: string, detail: Record<string, unknown> | undefined, now: number): void {
	snapshot.audit.push({ id: stableId("audit", `${actor}:${action}:${target}:${now}:${snapshot.audit.length}`), actor, action, target, detail, at: now });
}

function readFiles(value: unknown): CapabilityFile[] {
	return arrayOfRecords(value).flatMap((file): CapabilityFile[] => {
		const path = readString(file.path) ?? readString(file.name);
		if (!path) return [];
		const content = readString(file.content) ?? readString(file.source);
		return [{ path, content, sha256: content === undefined ? readString(file.sha256) : sha256(content) }];
	});
}

function readProfiles(value: unknown, title: string, description: string): CapabilityProfileSpec[] {
	const profiles = arrayOfRecords(value).flatMap((profile): CapabilityProfileSpec[] => {
		const name = readString(profile.name) ?? readString(profile.id);
		if (!name) return [];
		return [{ id: readString(profile.id), name, description: readString(profile.description), model: readString(profile.model), approvalMode: readApprovalMode(profile.approvalMode), instructions: readString(profile.instructions), capabilities: readStringArray(profile.capabilities) }];
	});
	return profiles.length ? profiles : [{ name: title, description, instructions: description }];
}

function readWorkflows(value: unknown): CapabilityWorkflowSpec[] {
	return arrayOfRecords(value).flatMap((workflow): CapabilityWorkflowSpec[] => {
		const label = readString(workflow.label) ?? readString(workflow.name) ?? readString(workflow.id);
		if (!label) return [];
		const steps = arrayOfRecords(workflow.steps).flatMap((step) => {
			const id = readString(step.id);
			const stepLabel = readString(step.label);
			return id && stepLabel ? [{ id, label: stepLabel, owner: readString(step.owner), next: readStringArray(step.next) }] : [];
		});
		return [{ id: readString(workflow.id), label, description: readString(workflow.description), path: readString(workflow.path), steps }];
	});
}

function readNamedSpecs(value: unknown): Array<{ name: string; description?: string; required?: boolean }> {
	return Array.isArray(value) ? value.flatMap((item) => {
		if (typeof item === "string") return [{ name: item }];
		if (!isRecord(item)) return [];
		const name = readString(item.name);
		return name ? [{ name, description: readString(item.description), required: typeof item.required === "boolean" ? item.required : undefined }] : [];
	}) : [];
}

function readPreview(value: unknown): CapabilityPreviewSpec | undefined {
	if (!isRecord(value)) return undefined;
	const kind = value.kind === "markdown" || value.kind === "html" || value.kind === "artifact" ? value.kind : "markdown";
	return { kind, path: readString(value.path), content: readString(value.content) };
}

function readContext(value: unknown): CapabilityContextDeclaration | undefined {
	if (!isRecord(value)) return undefined;
	return { imports: readStringArray(value.imports), exports: readStringArray(value.exports), shareable: value.shareable === true };
}

function readCompatibility(value: unknown, framework: CapabilityFramework): CapabilityPack["compatibility"] {
	if (!isRecord(value)) return { ompSquad: ">=0.1.0", drivers: framework === "flue" ? ["flue-service"] : framework === "workflow" ? ["workflow"] : ["rpc-agent"] };
	return { ompSquad: readString(value.ompSquad) ?? ">=0.1.0", drivers: readStringArray(value.drivers) };
}

function readExtra(input: Record<string, unknown>): Record<string, unknown> {
	const known = new Set(["name", "slug", "id", "framework", "runtime", "version", "schemaVersion", "title", "description", "files", "profiles", "workflows", "tools", "skills", "requiredEnv", "preview", "context", "compatibility"]);
	return Object.fromEntries(Object.entries(input).filter(([key]) => !known.has(key)));
}

function readSource(value: Record<string, unknown>): CapabilitySource | undefined {
	const id = readString(value.id);
	const name = readString(value.name);
	return id && name ? { id, name, url: readString(value.url), trusted: value.trusted !== false, createdAt: readNumber(value.createdAt) ?? 0, updatedAt: readNumber(value.updatedAt) ?? 0, lastSyncAt: readNumber(value.lastSyncAt) } : undefined;
}

function readPack(value: Record<string, unknown>): CapabilityPack | undefined {
	const id = readString(value.id);
	const sourceId = readString(value.sourceId);
	const framework = readFramework(value.framework);
	const slug = readString(value.slug);
	const version = readString(value.version);
	const checksum = readString(value.checksum);
	const title = readString(value.title);
	if (!id || !sourceId || !framework || !slug || !version || !checksum || !title) return undefined;
	return { id, sourceId, framework, slug, version, checksum, schemaVersion: readString(value.schemaVersion) ?? "1", title, description: readString(value.description) ?? "", files: readFiles(value.files), profiles: readProfiles(value.profiles, title, readString(value.description) ?? ""), workflows: readWorkflows(value.workflows), tools: readNamedSpecs(value.tools), skills: readNamedSpecs(value.skills), requiredEnv: readStringArray(value.requiredEnv), preview: readPreview(value.preview), context: readContext(value.context), compatibility: readCompatibility(value.compatibility, framework), createdAt: readNumber(value.createdAt) ?? 0, extra: isRecord(value.extra) ? value.extra : {} };
}

function readInstall(value: Record<string, unknown>): CapabilityInstall | undefined {
	const id = readString(value.id);
	const orgId = readString(value.orgId);
	const packId = readString(value.packId);
	const version = readString(value.version);
	const checksum = readString(value.checksum);
	const state = readInstallState(value.state);
	if (!id || !orgId || !packId || !version || !checksum || !state) return undefined;
	return { id, orgId, packId, version, checksum, state, approvedBy: readString(value.approvedBy), overrides: isRecord(value.overrides) ? value.overrides : {}, bindings: arrayOfRecords(value.bindings).map(readBinding).filter(isDefined), contextPolicy: readContextPolicy(value.contextPolicy), createdAt: readNumber(value.createdAt) ?? 0, updatedAt: readNumber(value.updatedAt) ?? 0 };
}

function readBinding(value: Record<string, unknown>): CapabilityBinding | undefined {
	const id = readString(value.id);
	const installId = readString(value.installId);
	const packId = readString(value.packId);
	const version = readString(value.version);
	const checksum = readString(value.checksum);
	const type = readBindingType(value.type);
	const key = readString(value.key);
	if (!id || !installId || !packId || !version || !checksum || !type || !key) return undefined;
	return { id, installId, packId, version, checksum, type, key, sourcePath: readString(value.sourcePath), enabled: value.enabled === true, config: isRecord(value.config) ? value.config : {} };
}

function readContextPolicy(value: unknown): CapabilityContextPolicy | undefined {
	if (!isRecord(value)) return undefined;
	const installId = readString(value.installId);
	return installId ? { installId, imports: readStringArray(value.imports), exports: readStringArray(value.exports), redactions: readStringArray(value.redactions), allowedPeers: readStringArray(value.allowedPeers), retentionDays: readNumber(value.retentionDays) ?? 30, shareable: value.shareable === true } : undefined;
}

function readVerification(value: Record<string, unknown>): CapabilityVerification | undefined {
	const id = readString(value.id);
	const targetId = readString(value.targetId);
	const message = readString(value.message);
	const scope = value.scope === "pack" || value.scope === "install" || value.scope === "upgrade" || value.scope === "federation" || value.scope === "context" ? value.scope : undefined;
	const status = value.status === "passed" || value.status === "failed" || value.status === "warning" ? value.status : undefined;
	return id && targetId && message && scope && status ? { id, scope, targetId, status, message, createdAt: readNumber(value.createdAt) ?? 0 } : undefined;
}

function readAudit(value: Record<string, unknown>): CapabilityAuditEvent | undefined {
	const id = readString(value.id);
	const actor = readString(value.actor);
	const action = readString(value.action);
	const target = readString(value.target);
	return id && actor && action && target ? { id, actor, action, target, detail: isRecord(value.detail) ? value.detail : undefined, at: readNumber(value.at) ?? 0 } : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function readFramework(value: unknown): CapabilityFramework | undefined {
	return value === "omp" || value === "workflow" || value === "flue" || value === "external" ? value : undefined;
}

function readApprovalMode(value: unknown): AgentProfile["approvalMode"] | undefined {
	return value === "always-ask" || value === "write" || value === "yolo" ? value : undefined;
}

function readInstallState(value: unknown): CapabilityInstallState | undefined {
	return value === "imported" || value === "validated" || value === "approved" || value === "enabled" || value === "disabled" || value === "failed" || value === "removed" ? value : undefined;
}

function readBindingType(value: unknown): CapabilityBindingType | undefined {
	return value === "profile" || value === "workflow" || value === "tool" || value === "skill" || value === "driver" || value === "ui-action" || value === "preview" || value === "doc" ? value : undefined;
}

function readField(value: CapabilityPack, field: string): unknown {
	switch (field) {
		case "title": return value.title;
		case "description": return value.description;
		case "profiles": return value.profiles;
		case "workflows": return value.workflows;
		case "tools": return value.tools;
		case "skills": return value.skills;
		case "requiredEnv": return value.requiredEnv;
		case "context": return value.context;
		case "files": return value.files;
		default: return undefined;
	}
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

function upsert<T>(items: T[], item: T, key: (value: T) => string): void {
	const id = key(item);
	const index = items.findIndex((existing) => key(existing) === id);
	if (index >= 0) items[index] = item;
	else items.push(item);
}

function stableId(prefix: string, value: string): string {
	return `${prefix}-${sha256(value).slice(0, 16)}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "capability";
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
