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
	// Identity is always advertised, but no source files / tenant bindings ever cross the boundary.
	expect(metadata).toMatchObject({ packId: pack.id, checksum: pack.checksum });
	expect(Object.keys(metadata)).not.toContain("files");
	expect(Object.keys(metadata)).not.toContain("bindings");
});

test("context exports are default-deny to an anonymous peer and require an allowed-peer policy", () => {
	const snapshot = emptyCapabilitySnapshot();
	const { pack } = importCapabilitySource(snapshot, {
		manifest: {
			name: "incident-response",
			framework: "workflow",
			version: "1.0.0",
			title: "Incident Response",
			description: "Handle incidents for tenant secret-corp.",
			files: [{ path: "secret.md", content: "private runbook" }],
			context: { exports: ["incident-summary"], shareable: true },
		},
	}, "admin", 1);
	const install = installCapability(snapshot, { packId: pack.id, enable: true }, "admin", 2);

	// Default install policy has allowedPeers: [] → nothing is exported to an arbitrary federation reader,
	// even though the pack itself declares the namespace shareable. This is the regression fix: the boundary
	// previously leaked every enabled pack's exports unconditionally.
	const anon = capabilityFederationMetadata(snapshot)[0];
	expect(anon.context).toEqual({ shareable: false, exports: [] });

	// Once the operator opens the policy to a named peer, only the allowed namespaces are advertised to that
	// peer, and the description is redacted per the policy tokens.
	install.contextPolicy = { installId: install.id, imports: [], exports: ["incident-summary"], redactions: ["secret-corp"], allowedPeers: ["peer-a"], retentionDays: 30, shareable: true };
	const forPeerA = capabilityFederationMetadata(snapshot, "peer-a")[0];
	expect(forPeerA.context).toEqual({ shareable: true, exports: ["incident-summary"] });
	expect(forPeerA.description).toBe("Handle incidents for tenant [redacted].");

	// A different, non-allowed peer still gets nothing.
	const forPeerB = capabilityFederationMetadata(snapshot, "peer-b")[0];
	expect(forPeerB.context).toEqual({ shareable: false, exports: [] });
});
