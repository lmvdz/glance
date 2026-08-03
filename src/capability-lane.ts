/**
 * The capability lane — pack import, install lifecycle, diff/federation metadata, and capability
 * runs — extracted from SquadManager (concern 04 of plans/deepen-modules, island #2). Unlike the
 * feedback lane this one OWNS its state: the `CapabilitySnapshot` that used to live as
 * `SquadManager.capabilityStore` lives here, and the manager hydrates/reads it only at the
 * persistence seam (`hydrate` on load, `snapshot` inside persist()).
 *
 * The one fleet coupling is deliberate and explicit: `runCapability` spawns a unit, so the deps
 * port carries a `create` thunk (the manager's own create). Everything else is audit/persist
 * fan-out. Deps are closures — the manager constructs this lane as a field initializer, before
 * its constructor finishes wiring (same init-order contract as FeedbackLane/DecisionLedger).
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
	capabilityFederationMetadata,
	capabilityProfiles,
	capabilityWorkflowDefinitions,
	diffCapabilityPacks,
	emptyCapabilitySnapshot,
	importCapabilitySource,
	installCapability,
	normalizeCapabilitySnapshot,
	updateCapabilityInstall,
	type CapabilityImportInput,
	type CapabilityInstallInput,
	type CapabilityInstallPatch,
	type CapabilitySnapshot,
} from "./capabilities/index.ts";
import { LOCAL_ACTOR } from "./federation.ts";
import type { Actor, AgentDTO, AgentProfile } from "./types.ts";
import { parseWorkflow } from "./workflow/dot.ts";
import { capabilityWorkflowToDot, slugifyForFile } from "./workflow-source.ts";

type CapabilityInstall = CapabilitySnapshot["installs"][number];
type CapabilityBinding = CapabilityInstall["bindings"][number];

/** The slice of SquadManager.create a capability run needs — kept structural so the lane never
 *  imports the manager's full CreateAgentOptions surface. */
export interface CapabilityRunSpawn {
	repo: string;
	name?: string;
	task?: string;
	autoRoute?: boolean;
	profileId?: string;
	workflow?: string;
	flue?: { dir: string; workflow: string; target: "node" | "cloudflare" };
}

export interface CapabilityLaneDeps {
	stateDir(): string;
	/** Durable audit row, best-effort (the manager wraps appendAudit with warn logging). */
	audit(entry: { actor: string; action: string; target: string; detail?: Record<string, unknown> }): void;
	/** Operator-visible audit — used when a run is refused (missing required env). */
	recordAudit(actor: Actor, action: string, target: string, status: "ok" | "error", detail?: string): void;
	persist(): void;
	changed(): void;
	/** Spawn the unit a capability run resolves to — the lane's single fleet coupling. */
	create(opts: CapabilityRunSpawn, actor: Actor): Promise<AgentDTO>;
}

export class CapabilityLane {
	private state: CapabilitySnapshot = emptyCapabilitySnapshot();

	constructor(private readonly deps: CapabilityLaneDeps) {}

	/** Replace state from a persisted snapshot (load/reload path). Unknown shapes normalize safely. */
	hydrate(raw: unknown): void {
		this.state = normalizeCapabilitySnapshot(raw as CapabilitySnapshot | undefined);
	}

	/** The live snapshot — read by the manager's persist() and the HTTP surface. */
	snapshot(): CapabilitySnapshot {
		return this.state;
	}

	/** Installed capability profiles, for the manager's profiles() merge (base → override chain). */
	profileOptions(): AgentProfile[] {
		return capabilityProfiles(this.state);
	}

	import(input: CapabilityImportInput, actor: Actor = LOCAL_ACTOR): { source: CapabilitySnapshot["sources"][number]; pack: CapabilitySnapshot["packs"][number]; warnings: string[] } {
		const out = importCapabilitySource(this.state, input, actor.id);
		this.deps.audit({ actor: actor.id, action: "capability.source.import", target: out.source.id, detail: { packId: out.pack.id, checksum: out.pack.checksum } });
		this.deps.persist();
		this.deps.changed();
		return out;
	}

	install(input: CapabilityInstallInput, actor: Actor = LOCAL_ACTOR): CapabilityInstall {
		const install = installCapability(this.state, { ...input, orgId: input.orgId ?? actor.orgId ?? "file" }, actor.id);
		this.deps.audit({ actor: actor.id, action: "capability.install", target: install.id, detail: { packId: install.packId, checksum: install.checksum } });
		this.deps.persist();
		this.deps.changed();
		return install;
	}

	update(id: string, patch: CapabilityInstallPatch, actor: Actor = LOCAL_ACTOR): CapabilityInstall {
		const install = updateCapabilityInstall(this.state, id, patch, actor.id);
		this.deps.audit({ actor: actor.id, action: `capability.${install.state}`, target: install.id, detail: { packId: install.packId, checksum: install.checksum } });
		this.deps.persist();
		this.deps.changed();
		return install;
	}

	diff(beforeId: string, afterId: string) {
		const before = this.state.packs.find((pack) => pack.id === beforeId);
		const after = this.state.packs.find((pack) => pack.id === afterId);
		if (!before || !after) throw new Error("capability pack not found");
		return diffCapabilityPacks(before, after);
	}

	federation() {
		return capabilityFederationMetadata(this.state);
	}

	workflowDefinitions() {
		return capabilityWorkflowDefinitions(this.state);
	}

	async run(installId: string, bindingKey: string | undefined, opts: { repo?: string; prompt?: string } = {}, actor: Actor = LOCAL_ACTOR): Promise<AgentDTO> {
		const install = this.state.installs.find((item) => item.id === installId);
		if (!install || install.state !== "enabled") throw new Error("enabled capability install not found");
		const pack = this.state.packs.find((item) => item.id === install.packId);
		if (!pack) throw new Error("capability pack not found");
		const binding = bindingKey ? install.bindings.find((item) => item.enabled && item.key === bindingKey) : install.bindings.find((item) => item.enabled && (item.type === "profile" || item.type === "workflow" || item.type === "driver"));
		if (!binding) throw new Error("capability binding not found");
		// requiredEnv ENFORCEMENT (#5): packs declare env vars they need, but it was parsed and never checked
		// — an agent would spawn blind and fail opaquely downstream. Refuse up front with a clear error naming
		// the missing vars, before any worktree/host is created.
		const missingEnv = pack.requiredEnv.filter((name) => !(process.env[name] && process.env[name]!.trim()));
		if (missingEnv.length) {
			this.deps.recordAudit(actor, "capability.run.blocked", binding.key, "error", `missing required env: ${missingEnv.join(", ")}`);
			throw new Error(`capability "${pack.slug}" requires environment variable(s) not set: ${missingEnv.join(", ")}`);
		}
		const repo = opts.repo ?? process.cwd();
		const prompt = opts.prompt ?? `Run capability ${binding.key}`;
		const name = binding.key.replace(/^cap:/, "").replace(/[^a-z0-9-]+/gi, "-").slice(0, 24) || "capability";
		if (binding.type === "driver" && binding.config.runtime === "flue-service") {
			const dir = path.join(this.deps.stateDir(), "capabilities", install.id);
			await fs.mkdir(dir, { recursive: true });
			await Promise.all(pack.files.map(async (file) => {
				if (file.content === undefined) return;
				const target = path.join(dir, file.path);
				if (!target.startsWith(dir + path.sep)) throw new Error("capability file path escapes install dir");
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, file.content);
			}));
			const workflow = typeof binding.config.workflow === "string" ? binding.config.workflow : pack.workflows[0]?.path ?? pack.workflows[0]?.id ?? pack.slug;
			const target = binding.config.target === "cloudflare" ? "cloudflare" : "node";
			return this.deps.create({ repo, name, task: prompt, autoRoute: false, flue: { dir, workflow, target } }, actor);
		}
		if (binding.type === "workflow") {
			// WORKFLOW binding execution (#2): previously this passed `workflow: binding.sourcePath`, which is
			// undefined for inline step-graph bindings → `create` classified the agent as a plain omp-operator
			// and the step graph never ran. Resolve the workflow path to actually drive a WorkflowDriver:
			//  - an authored file (binding.sourcePath) is used directly;
			//  - an inline step-graph binding is materialized to a DOT graph file in the install dir, so the
			//    same engine that runs authored workflows executes the capability's declared steps.
			const workflowPath = await this.resolveWorkflowPath(install, binding);
			return this.deps.create({ repo, name, workflow: workflowPath, task: prompt, autoRoute: false }, actor);
		}
		return this.deps.create({ repo, name, profileId: binding.key, task: prompt, autoRoute: false }, actor);
	}

	/**
	 * Resolve a workflow binding to a graph file path the WorkflowDriver can run. An authored `sourcePath`
	 * is returned as-is. Otherwise the binding's WorkflowDefinition (resolved by binding key via
	 * capabilityWorkflowDefinitions) is rendered to a DOT graph and written into the per-install dir, and
	 * that path is returned — so an inline capability step graph actually executes instead of being dropped.
	 */
	private async resolveWorkflowPath(install: CapabilityInstall, binding: CapabilityBinding): Promise<string> {
		if (binding.sourcePath) return binding.sourcePath;
		const definition = capabilityWorkflowDefinitions(this.state).find((def) => def.id === binding.key);
		if (!definition || definition.steps.length === 0) {
			throw new Error(`capability workflow "${binding.key}" has no resolvable steps to run`);
		}
		const dir = path.join(this.deps.stateDir(), "capabilities", install.id, "workflows");
		await fs.mkdir(dir, { recursive: true });
		const dot = capabilityWorkflowToDot(definition);
		// Validate the synthesized graph round-trips through the same parser the driver uses (exactly one
		// start/exit, well-formed edges) before persisting it — fail loudly here, not at spawn time.
		parseWorkflow(dot);
		const file = path.join(dir, `${slugifyForFile(binding.key)}.fabro`);
		await fs.writeFile(file, dot);
		return file;
	}
}
