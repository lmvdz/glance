import { parseCapabilityManifest } from "./index.ts";

export interface PublicCapabilityCatalogEntry {
	id: string;
	source: string;
	manifest: Record<string, unknown>;
}

export const PUBLIC_CAPABILITY_CATALOG: PublicCapabilityCatalogEntry[] = [
	{
		id: "plan-context-reviewer",
		source: "omp public catalog",
		manifest: {
			name: "plan-context-reviewer",
			framework: "omp",
			version: "1.0.0",
			title: "Plan Context Reviewer",
			description: "Reviews task context bundles before agents run, checking acceptance criteria, prerequisites, decisions, and downstream impact.",
			files: [{ path: "instructions.md", content: "Review the selected feature's context bundle. Flag missing acceptance criteria, blockers, decisions, linked tickets, and downstream agents before implementation starts." }],
			profiles: [{ id: "plan-context-reviewer", name: "Plan Context Reviewer", instructions: "Review feature context before implementation. Be terse. Return missing context, risky assumptions, and one concrete fix list." }],
			skills: [{ name: "context-review", description: "Audit feature context for agent readiness." }],
			tools: [{ name: "read", description: "Read plan docs and linked context." }],
			context: { imports: ["plan.*", "feature.*", "ticket.*"], exports: ["review.comments"], shareable: false },
		},
	},
	{
		id: "implementation-scout",
		source: "omp public catalog",
		manifest: {
			name: "implementation-scout",
			framework: "workflow",
			version: "1.0.0",
			title: "Implementation Scout",
			description: "Small workflow for gathering plan docs, linked issues, prerequisites, and decisions before an implementation agent starts.",
			files: [{ path: "workflow.md", content: "1. Read the feature spec and linked plan docs.\n2. Extract acceptance criteria, prerequisites, decisions, and downstream risks.\n3. Hand back a compact implementation brief." }],
			workflows: [{ id: "implementation-scout", label: "Implementation Scout", description: "Prepare an implementation brief from feature context.", steps: [{ id: "read", label: "Read context", owner: "Scout", next: ["brief"] }, { id: "brief", label: "Write brief", owner: "Scout", next: [] }] }],
			skills: [{ name: "implementation-brief", description: "Turn task context into an agent-ready brief." }],
			context: { imports: ["plan.*", "feature.*", "ticket.*", "decision.*"], exports: ["brief.*"], shareable: true },
		},
	},
	{
		id: "collaborative-plan-reviser",
		source: "omp public catalog",
		manifest: {
			name: "collaborative-plan-reviser",
			framework: "workflow",
			version: "1.0.0",
			title: "Collaborative Plan Reviser",
			description: "Planner loop that consumes live plan annotations, revises linked markdown plans, and hands updated context back to implementation agents.",
			files: [{ path: "instructions.md", content: "Read the linked feature, plan docs, and unresolved plan annotations. Patch the plan markdown only. Preserve the plan structure, update acceptance criteria/prerequisites/decisions when needed, and summarize what changed for downstream agents." }],
			profiles: [{ id: "plan-reviser", name: "Plan Reviser", instructions: "Revise plan markdown from anchored annotations. Do not implement product code. Return the markdown changes and downstream context implications." }],
			workflows: [
				{ id: "annotate-review-revise", label: "Annotate → Review → Revise", description: "Collaborative planning loop: collect annotations, revise plan docs, review, then refresh agent context.", steps: [
					{ id: "collect", label: "Collect annotations", owner: "Planner", next: ["revise"] },
					{ id: "revise", label: "Revise plan markdown", owner: "Planner", next: ["review"] },
					{ id: "review", label: "Human review", owner: "Operator", next: ["refresh"] },
					{ id: "refresh", label: "Refresh agent context", owner: "Planner", next: [] },
				] },
			],
			skills: [{ name: "plan-revision", description: "Turn collaborative plan annotations into reviewed markdown plan revisions." }],
			tools: [{ name: "edit", description: "Patch plan markdown documents." }, { name: "read", description: "Read plan docs, annotations, decisions, and linked task context." }],
			context: { imports: ["plan.*", "feature.*", "annotation.*", "decision.*", "ticket.*"], exports: ["plan.patch", "decision.*", "agent.context"], shareable: false },
		},
	},
	{
		id: "verified-feature-delivery",
		source: "omp public catalog",
		manifest: {
			name: "verified-feature-delivery",
			framework: "workflow",
			version: "1.0.0",
			title: "Verified Feature Delivery",
			description: "Research → plan → Plane → implement → verify loop for shipping a feature through reviewable checkpoints.",
			files: [{ path: "recipe.md", content: "Run the research-plan-implement workflow: research the repo and prior art, write a plan, gate human approval, file concerns to Plane, promote/claim/implement each issue, then verify and fix up until green." }],
			profiles: [
				{ id: "feature-researcher", name: "Feature Researcher", instructions: "Gather prior art, repo patterns, constraints, and concrete files before planning. Do not write production code." },
				{ id: "plan-decomposer", name: "Plan Decomposer", instructions: "Turn research into STATUS/PRIORITY/COMPLEXITY/TOUCHES plan docs with explicit verification gates and dependency order." },
				{ id: "issue-implementer", name: "Issue Implementer", approvalMode: "write", instructions: "Promote one issue, implement only its declared scope, run its verification gate, commit logically, and close the issue." },
			],
			workflows: [{ id: "research-plan-implement", label: "Research → Plan → Plane → Implement", description: "Autonomous delivery spine with one human approval gate before filing issues and writing code.", steps: [
				{ id: "research", label: "Research", owner: "Feature Researcher", next: ["plan"] },
				{ id: "plan", label: "Plan", owner: "Plan Decomposer", next: ["approve"] },
				{ id: "approve", label: "Approve plan", owner: "Operator", next: ["to-plane"] },
				{ id: "to-plane", label: "File to Plane", owner: "Plan Decomposer", next: ["implement"] },
				{ id: "implement", label: "Implement issues", owner: "Issue Implementer", next: ["verify"] },
				{ id: "verify", label: "Verify", owner: "WorkflowDriver", next: ["fixup"] },
				{ id: "fixup", label: "Fixup", owner: "Issue Implementer", next: [] },
			] }],
			skills: [
				{ name: "research", description: "Gather prior art and repo context." },
				{ name: "plan", description: "Decompose the goal into executable concerns." },
				{ name: "plan-to-plane", description: "File plan concerns as Plane work items." },
				{ name: "promote-issue", description: "Upgrade issues into implementation-ready briefs." },
				{ name: "claim-and-implement", description: "Execute one promoted issue end-to-end." },
			],
			tools: [
				{ name: "read", description: "Read source, plans, and linked context." },
				{ name: "search", description: "Locate relevant code and docs before editing." },
				{ name: "edit", description: "Patch source and plan docs." },
				{ name: "bash", description: "Run declared verification gates." },
				{ name: "plane", description: "Create, promote, claim, and close Plane work items." },
			],
			context: { imports: ["repo.*", "research.*", "plan.*", "ticket.*", "decision.*"], exports: ["plan.*", "ticket.*", "verification.*", "resolution.*"], shareable: false },
		},
	},
	{
		id: "parallel-solution-race",
		source: "omp public catalog",
		manifest: {
			name: "parallel-solution-race",
			framework: "workflow",
			version: "1.0.0",
			title: "Parallel Solution Race",
			description: "Fan-out recipe that compares simple, fast, and minimal-dependency branches before selecting the best implementation.",
			files: [{ path: "recipe.md", content: "Spawn three worktree-isolated branch agents with different optimization lenses, wait for all results, then run a reviewer that reads parallel_results.json and picks the best branch." }],
			profiles: [
				{ id: "simplicity-branch", name: "Simplicity Branch", instructions: "Implement the goal in the simplest clear way. Delete abstraction before adding any." },
				{ id: "performance-branch", name: "Performance Branch", instructions: "Implement the goal optimizing runtime cost, allocations, and hot-path behavior without changing scope." },
				{ id: "minimal-deps-branch", name: "Minimal Deps Branch", instructions: "Implement the goal with the fewest dependencies and native platform features first." },
				{ id: "race-reviewer", name: "Race Reviewer", instructions: "Compare branch outputs and worktrees. Pick the best approach by correctness, maintainability, and verification evidence." },
			],
			workflows: [{ id: "fan-out", label: "Fan out → Merge → Review", description: "Parallel branch race with wait-all merge and final reviewer.", steps: [
				{ id: "fan-out", label: "Fan out", owner: "WorkflowDriver", next: ["simplicity", "performance", "minimal-deps"] },
				{ id: "simplicity", label: "Simplicity", owner: "Simplicity Branch", next: ["merge"] },
				{ id: "performance", label: "Performance", owner: "Performance Branch", next: ["merge"] },
				{ id: "minimal-deps", label: "Minimal deps", owner: "Minimal Deps Branch", next: ["merge"] },
				{ id: "merge", label: "Merge results", owner: "WorkflowDriver", next: ["review"] },
				{ id: "review", label: "Review", owner: "Race Reviewer", next: [] },
			] }],
			skills: [{ name: "fan-out", description: "Run independent worktree agents under different optimization lenses." }],
			tools: [
				{ name: "worktree", description: "Isolate each branch in its own checkout." },
				{ name: "read", description: "Read branch outputs and source." },
				{ name: "edit", description: "Patch source in branch worktrees." },
				{ name: "bash", description: "Run branch-local verification gates." },
			],
			context: { imports: ["goal.*", "repo.*"], exports: ["parallel_results.*", "selected_branch.*"], shareable: true },
		},
	},
	{
		id: "conflict-resolution-doctor",
		source: "omp public catalog",
		manifest: {
			name: "conflict-resolution-doctor",
			framework: "workflow",
			version: "1.0.0",
			title: "Conflict Resolution Doctor",
			description: "Integration-layer resolver that merges main into a branch, combines both intents, verifies, and leaves the branch fast-forwardable.",
			files: [{ path: "recipe.md", content: "Use rerere first, then an intent-aware resolver for remaining conflict markers. Combine both sides' behavior, run the repo verification gate, fix only gate failures, and commit the resolved merge." }],
			profiles: [
				{ id: "intent-resolver", name: "Intent Resolver", approvalMode: "write", instructions: "Resolve conflict markers by preserving both branch and main behavior. Never choose one side without reading surrounding code." },
				{ id: "verify-doctor", name: "Verify Doctor", approvalMode: "write", instructions: "Fix only verification failures introduced by the merge resolution. Do not widen scope." },
			],
			workflows: [{ id: "resolve-conflict", label: "Merge main → Resolve → Verify → Commit", description: "Branch-local conflict resolution loop gated by the repo verifier.", steps: [
				{ id: "merge-main", label: "Merge main", owner: "WorkflowDriver", next: ["resolve"] },
				{ id: "resolve", label: "Resolve conflicts", owner: "Intent Resolver", next: ["verify"] },
				{ id: "verify", label: "Verify", owner: "WorkflowDriver", next: ["fixup"] },
				{ id: "fixup", label: "Fixup", owner: "Verify Doctor", next: ["commit"] },
				{ id: "commit", label: "Commit merge", owner: "WorkflowDriver", next: [] },
			] }],
			skills: [{ name: "conflict-resolution", description: "Resolve branch/main integration conflicts without dropping either side's behavior." }],
			tools: [
				{ name: "git", description: "Run rerere-backed merge and commit resolved integration." },
				{ name: "read", description: "Read conflicted files and surrounding code." },
				{ name: "edit", description: "Patch conflict resolution." },
				{ name: "bash", description: "Run the repo verification gate." },
			],
			context: { imports: ["branch.*", "main.*", "verification.*"], exports: ["resolution.commit", "verification.*"], shareable: false },
		},
	},
	{
		id: "agent-factory-architect",
		source: "omp public catalog",
		manifest: {
			name: "agent-factory-architect",
			framework: "workflow",
			version: "1.0.0",
			title: "Agent Factory Architect",
			description: "Commission loop for authoring scoped Flue workers, validating them against acceptance, and onboarding only green workers.",
			files: [{ path: "recipe.md", content: "Seed the worker skeleton, ask an OmpArchitect to write only the workflow module, run the acceptance gate, feed failures back into authoring, and onboard the worker only after validation passes." }],
			profiles: [
				{ id: "omp-architect", name: "Omp Architect", approvalMode: "write", instructions: "Author one Flue workflow module from the worker spec. Do not edit the fixed skeleton or install packages." },
				{ id: "acceptance-gate", name: "Acceptance Gate", instructions: "Validate the authored worker against the declared payload and expected result. Reject overbuilt, unsafe, or unverified workers." },
			],
			workflows: [{ id: "commission-worker", label: "Author → Gate → Onboard", description: "Bounded author/gate/onboard loop for scoped workers.", steps: [
				{ id: "author", label: "Author", owner: "Omp Architect", next: ["gate"] },
				{ id: "gate", label: "Acceptance gate", owner: "Acceptance Gate", next: ["onboard"] },
				{ id: "onboard", label: "Onboard", owner: "CommissionExecutor", next: [] },
			] }],
			skills: [{ name: "commission", description: "Create and validate scoped agent workers." }, { name: "worker-validation", description: "Run acceptance checks before onboarding a worker." }],
			tools: [
				{ name: "read", description: "Read worker specs and generated files." },
				{ name: "edit", description: "Author the workflow module." },
				{ name: "bash", description: "Run the acceptance gate." },
				{ name: "flue", description: "Execute generated worker workflows." },
			],
			context: { imports: ["worker.spec", "acceptance.*", "feedback.*"], exports: ["worker.manifest", "validation.report"], shareable: false },
		},
	},
	{
		id: "fleet-autonomy-steward",
		source: "omp public catalog",
		manifest: {
			name: "fleet-autonomy-steward",
			framework: "workflow",
			version: "1.0.0",
			title: "Fleet Autonomy Steward",
			description: "Operating recipe for the dispatcher, orchestrator, observer, scout, and Plane curator loop that keeps autonomous work moving safely.",
			files: [{ path: "recipe.md", content: "Curate repeated issues, promote one root-cause task, dispatch only unblocked work under WIP/rate-limit caps, verify and land green branches, then feed observer/scout findings back into triage." }],
			profiles: [
				{ id: "plane-curator", name: "Plane Curator", instructions: "Group recurring issues into root-cause triage items. Do not dispatch or close work." },
				{ id: "dispatcher", name: "Dispatcher", instructions: "Start eligible work by priority while respecting blockers, WIP caps, rate limits, and do-not-auto-land labels." },
				{ id: "orchestrator", name: "Orchestrator", instructions: "Verify, land, close landed issues, and stop on red gates or silent catastrophes." },
				{ id: "observer-scout", name: "Observer Scout", instructions: "Harvest regressions and learnings into deduplicated triage-safe findings. Never auto-land your own findings." },
			],
			workflows: [{ id: "autonomy-meta-loop", label: "Curate → Triage → Dispatch → Execute → Land → Observe", description: "Workflow-of-workflows for safe fleet autonomy.", steps: [
				{ id: "curate", label: "Group recurring Plane issues", owner: "Plane Curator", next: ["triage"] },
				{ id: "triage", label: "Promote one root-cause issue", owner: "Operator", next: ["dispatch"] },
				{ id: "dispatch", label: "Dispatch eligible work", owner: "Dispatcher", next: ["execute"] },
				{ id: "execute", label: "Run workflow/agent", owner: "WorkflowDriver", next: ["land"] },
				{ id: "land", label: "Verify and land", owner: "Orchestrator", next: ["observe"] },
				{ id: "observe", label: "Audit and harvest learnings", owner: "Observer Scout", next: [] },
			] }],
			skills: [{ name: "fleet-supervision", description: "Supervise autonomous work by exception." }, { name: "plane-triage", description: "Curate and promote Plane issues safely." }],
			tools: [
				{ name: "plane", description: "Read, group, promote, and close work items." },
				{ name: "workflow-driver", description: "Start and resume workflow agents." },
				{ name: "read", description: "Inspect plans, transcripts, and verification output." },
				{ name: "bash", description: "Run verification and land gates." },
			],
			context: { imports: ["plane.*", "agent.*", "workflow.*", "verification.*", "land.*"], exports: ["dispatch.*", "finding.*", "resolution.*"], shareable: false },
		},
	},
];

export function publicCapabilityCatalog(now = Date.now()) {
	return PUBLIC_CAPABILITY_CATALOG.map((entry) => {
		const parsed = parseCapabilityManifest(entry.manifest, `catalog:${entry.id}`, now).pack;
		return {
			id: entry.id,
			source: entry.source,
			title: parsed.title,
			description: parsed.description,
			framework: parsed.framework,
			version: parsed.version,
			slug: parsed.slug,
			checksum: parsed.checksum,
			requiredEnv: parsed.requiredEnv,
			profiles: parsed.profiles.map(({ id, name, description, model }) => ({ id, name, description, model })),
			tools: parsed.tools.map(({ name, description }) => ({ name, description })),
			skills: parsed.skills.map(({ name, description }) => ({ name, description })),
			workflows: parsed.workflows.map(({ id, label, description }) => ({ id, label, description })),
		};
	});
}

export function publicCapabilityManifest(id: string): PublicCapabilityCatalogEntry | undefined {
	return PUBLIC_CAPABILITY_CATALOG.find((entry) => entry.id === id);
}
