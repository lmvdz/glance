import { expect, test } from "bun:test";
import { diffCapabilityPacks, emptyCapabilitySnapshot, importCapabilitySource, installCapability, updateCapabilityInstall } from "../src/capabilities/index.ts";

function manifest(version: string, instruction: string, tools: string[]) {
	return {
		name: "security-audit",
		framework: "workflow",
		version,
		title: "Security Audit",
		description: "Audit code security.",
		files: [{ path: "agent/instructions.md", content: instruction }],
		profiles: [{ id: "security-auditor", name: "Security Auditor", instructions: instruction }],
		tools,
	};
}

test("upgrades are staged, diffed, and rollback restores previous checksum", () => {
	const snapshot = emptyCapabilitySnapshot();
	const first = importCapabilitySource(snapshot, { manifest: manifest("1.0.0", "Read only.", ["search"]) }, "admin", 1).pack;
	const second = importCapabilitySource(snapshot, { manifest: manifest("1.1.0", "Read and verify.", ["search", "bash"]) }, "admin", 2).pack;
	const install = installCapability(snapshot, { packId: first.id, enable: true }, "admin", 3);
	const changes = diffCapabilityPacks(first, second);
	expect(changes.some((change) => change.field === "tools" && change.risk === "high")).toBe(true);

	const upgraded = updateCapabilityInstall(snapshot, install.id, { upgradeToPackId: second.id }, "admin", 4);
	expect(upgraded.checksum).toBe(second.checksum);
	expect(upgraded.previous?.checksum).toBe(first.checksum);

	const rolledBack = updateCapabilityInstall(snapshot, install.id, { rollback: true }, "admin", 5);
	expect(rolledBack.checksum).toBe(first.checksum);
	expect(snapshot.verifications.some((record) => record.scope === "upgrade" && record.status === "passed")).toBe(true);
});
