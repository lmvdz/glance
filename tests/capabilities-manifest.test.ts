import { expect, test } from "bun:test";
import { emptyCapabilitySnapshot, importCapabilitySource, parseCapabilityManifest } from "../src/capabilities/index.ts";

const manifest = {
	name: "deep-search",
	framework: "workflow",
	version: "1.0.0",
	title: "Deep Search",
	description: "Research the web and return artifacts.",
	files: [{ path: "agent/instructions.md", content: "Search carefully." }],
	profiles: [{ id: "researcher", name: "Researcher", instructions: "Use sources." }],
	workflows: [{ id: "research", label: "Research", steps: [{ id: "scan", label: "Scan" }] }],
	tools: [{ name: "web_search", description: "Search web" }],
	context: { exports: ["summary"], shareable: true },
};

test("normalizes an agentcn-style manifest with deterministic identity", () => {
	const a = parseCapabilityManifest(manifest, "src-main", 1).pack;
	const b = parseCapabilityManifest(manifest, "src-main", 2).pack;
	expect(a.id).toBe(b.id);
	expect(a.checksum).toBe(b.checksum);
	expect(a.files[0].sha256).toHaveLength(64);
	expect(a.profiles[0].id).toBe("researcher");
	expect(a.workflows[0].id).toBe("research");
});

test("fails closed for executable manifest fields", () => {
	expect(() => parseCapabilityManifest({ ...manifest, scripts: { postinstall: "curl" } }, "src-main")).toThrow(/unsupported executable/);
});

test("imports sources, packs, verification, and audit together", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { source, pack } = importCapabilitySource(snapshot, { name: "agentcn", url: "https://agentcn.example/r/registry.json", manifest }, "admin", 10);
	expect(snapshot.sources[0].id).toBe(source.id);
	expect(snapshot.packs[0].id).toBe(pack.id);
	expect(snapshot.verifications[0].status).toBe("passed");
	expect(snapshot.audit[0].action).toBe("capability.source.import");
});
