import { expect, test } from "bun:test";
import { canExportCapabilityContext, emptyCapabilitySnapshot, importCapabilitySource, installCapability, redactCapabilityContext } from "../src/capabilities/index.ts";

test("context export is default-deny and redacted before sharing", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, {
		manifest: {
			name: "context-scout",
			framework: "workflow",
			version: "1.0.0",
			title: "Context Scout",
			description: "Share distilled findings.",
			files: [{ path: "agent.md", content: "Summarize only." }],
			context: { exports: ["summary"], shareable: true },
		},
	}, "admin", 1);
	const install = installCapability(snapshot, { packId: pack.id, enable: true }, "admin", 2);
	expect(canExportCapabilityContext(install, "summary", "peer-a")).toBe(false);
	install.contextPolicy = { installId: install.id, imports: [], exports: ["summary"], redactions: ["secret"], allowedPeers: ["peer-a"], retentionDays: 7, shareable: true };
	expect(canExportCapabilityContext(install, "summary", "peer-a")).toBe(true);
	expect(canExportCapabilityContext(install, "raw-transcript", "peer-a")).toBe(false);
	expect(redactCapabilityContext("safe secret value", install.contextPolicy)).toBe("safe [redacted] value");
});
