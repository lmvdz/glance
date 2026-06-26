import { expect, test } from "bun:test";
import { capabilityFederationMetadata, emptyCapabilitySnapshot, importCapabilitySource, installCapability } from "../src/capabilities/index.ts";

test("federated capability metadata excludes source files and tenant bindings", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, {
		manifest: {
			name: "incident-response",
			framework: "workflow",
			version: "1.0.0",
			title: "Incident Response",
			description: "Handle incidents.",
			files: [{ path: "secret.md", content: "private runbook" }],
			context: { exports: ["incident-summary"], shareable: true },
		},
	}, "admin", 1);
	installCapability(snapshot, { packId: pack.id, enable: true }, "admin", 2);
	const metadata = capabilityFederationMetadata(snapshot)[0];
	expect(metadata).toMatchObject({ packId: pack.id, checksum: pack.checksum, context: { shareable: true, exports: ["incident-summary"] } });
	expect(Object.keys(metadata)).not.toContain("files");
	expect(Object.keys(metadata)).not.toContain("bindings");
});
