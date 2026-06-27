import { expect, test } from "bun:test";
import { capabilityProfiles, capabilityWorkflowDefinitions, emptyCapabilitySnapshot, importCapabilitySource, installCapability } from "../src/capabilities/index.ts";

const manifest = {
	name: "claim-and-land",
	framework: "workflow",
	version: "1.0.0",
	title: "Claim and Land",
	description: "Claim an issue and land it.",
	files: [{ path: "agent/instructions.md", content: "Claim, implement, verify, land." }],
	profiles: [{ id: "claimer", name: "Claim Agent", approvalMode: "write", instructions: "Use the issue context." }],
	workflows: [{ id: "claim-land", label: "Claim → Land", description: "End-to-end issue flow", steps: [{ id: "claim", label: "Claim" }, { id: "land", label: "Land" }] }],
};

test("enabled installs materialize profiles and workflows", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, { manifest }, "admin", 1);
	installCapability(snapshot, { packId: pack.id, enable: true }, "admin", 2);
	// Profile id is the binding key (cap:<slug>:<id>), matching how the workflow id is keyed below —
	// runCapability spawns with profileId: binding.key, so the id MUST be that key to resolve.
	expect(capabilityProfiles(snapshot)[0]).toMatchObject({ id: "cap:claim-and-land:claimer", name: "Claim Agent", runtime: "omp-operator" });
	expect(capabilityWorkflowDefinitions(snapshot)[0]).toMatchObject({ id: "cap:claim-and-land:claim-land", label: "Claim → Land" });
});

test("a profile binding resolves to its profile by binding key (regression: was a silent generic-agent fallback)", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, { manifest }, "admin", 1);
	const install = installCapability(snapshot, { packId: pack.id, enable: true }, "admin", 2);
	const profileBinding = install.bindings.find((binding) => binding.type === "profile" && binding.enabled);
	expect(profileBinding?.key).toBe("cap:claim-and-land:claimer");
	// runCapability does `create({ profileId: binding.key })`, and create resolves via
	// `profiles().find(p => p.id === profileId)`. Before the fix the profile id was "claimer", so this
	// lookup returned undefined and the capability spawned a generic agent with none of its instructions.
	const resolved = capabilityProfiles(snapshot).find((profile) => profile.id === profileBinding!.key);
	expect(resolved).toBeDefined();
	expect(resolved).toMatchObject({ name: "Claim Agent", memory: "Use the issue context." });
});

test("disabled installs remove runtime bindings without deleting audit", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, { manifest }, "admin", 1);
	const install = installCapability(snapshot, { packId: pack.id, enable: false }, "admin", 2);
	expect(install.state).toBe("approved");
	expect(capabilityProfiles(snapshot)).toEqual([]);
	expect(snapshot.audit.length).toBeGreaterThan(0);
});

test("flue manifests expose a FlueServiceDriver binding", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, {
		manifest: {
			name: "extract-email",
			framework: "flue",
			version: "1.0.0",
			title: "Extract Email",
			description: "Run a Flue worker.",
			files: [{ path: "worker.ts", content: "export default {}" }],
			workflows: [{ id: "extract", label: "Extract", path: "extract" }],
		},
	}, "admin", 1);
	const install = installCapability(snapshot, { packId: pack.id, enable: true }, "admin", 2);
	const driver = install.bindings.find((binding) => binding.type === "driver");
	expect(driver).toMatchObject({ key: "cap:extract-email:flue-service", enabled: true });
	expect(driver?.config).toMatchObject({ runtime: "flue-service", workflow: "extract", target: "node" });
});
