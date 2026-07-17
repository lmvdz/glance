# Flow Marketplace — glance client + broker spec (Phase 3)

## Outcome
Orgs publish and sell agentic flows (capability packs) that other orgs buy and run — safely, with seller IP
protected by provenance + fingerprinting + licensing (not secrecy), and buyer data protected by least-privilege
sandboxed execution. **This plan builds the glance-client side + a written broker spec.** The broker service
(payments, publisher accounts, fingerprint registry, CRL) is a separate program of work.

The hard truth the design is built around: **as it stands today, an installed pack runs with full host-agent
privilege** (`runCapability` never sandboxes). So v1 ships the entire commerce/provenance/signing/entitlement/
revocation layer (no containment dependency) *now*, wires `runCapability` to a mandatory sandbox (M1, needs
Phase 0), and lets only a **narrow genuinely-containable executable subset** run — everything wider is
installable-but-run-blocked with a named missing link. Nothing untrusted ever runs host-side.

## Work
| Concern | Track | Why it exists | Complexity | Touches |
|---|---|---|---|---|
| [01 Raw-byte signing & verify-before-parse](01-signing-verify-before-parse.md) | commerce | Checksum signs a subset (preview unsigned); parse-before-verify | architectural | capabilities/index, new pack-signing, push-crypto reuse |
| [02 Import trust pipeline: default-untrusted + structural-verify relabel](02-import-trust-pipeline.md) | commerce | `trusted` defaults OPEN; verify is structural but reads as safety | architectural | capabilities/index, server, marketplace-client (new) |
| [03 Marketplace client — fetch/discover against a broker URL](03-marketplace-client.md) | commerce | No cross-org distribution exists (federation is NullBus per-org) | architectural | marketplace-client (new), server, webapp |
| [04 Entitlement client + instance identity (cooperative)](04-entitlement-client.md) | commerce | No entitlement primitive; `orgId="file"` can't identify a licensee | architectural | marketplace-client, secrets/keypair, capabilities/index |
| [05 Reason-typed revocation (fail-closed security, monotonic epoch)](05-revocation-crl.md) | commerce | Revocation is per-install operator action; no publisher kill-switch | architectural | marketplace-client, capabilities/index, squad-manager (run gate) |
| [06 Fingerprint L1 provenance + L2 ledger/marker (honest)](06-fingerprint-l1-l2.md) | commerce | Seller-IP forensic backbone; watermark is best-effort not tracing | architectural | marketplace-client, pack-signing, broker spec |
| [07 Capability-declaration schema (network/fs/tools/MCP)](07-capability-declaration-schema.md) | safety | Packs declare requiredEnv only; no network/fs/tool scope | mechanical | capabilities/index (schema), verify |
| [08 M1 — runCapability → mandatory sandbox + run-gate matrix](08-runcapability-sandbox-wiring.md) | safety | THE wiring gap: marketplace flows run unsandboxed today | architectural | squad-manager (runCapability, makeDriver) |
| [09 Broker protocol spec + local stub](09-broker-spec-and-stub.md) | spec | Client is built against a spec; broker is a separate program | architectural | docs/marketplace/broker-spec, tests/broker-stub (new) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 09 | The spec + stub is the contract every commerce concern codes against — write it first |
| 2 | 01, 07 | Signing + the declaration schema — foundational, disjoint files |
| 3 | 02, 03 | Import pipeline + the fetch client — 02 needs 01/09, 03 needs 09 |
| 4 | 04, 05, 06 | Entitlement, revocation, fingerprint — all ride the client (03) + spec (09); disjoint enough to parallelize |
| 5 | 08 | The safety wiring + run-gate matrix — needs the declaration schema (07), the untrusted marker (02), and **Phase 0** |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 09 | — | broker spec doc + stub exist |
| 01 | 09 | `verifyCapabilityPack` verifies a detached sig over raw bytes before parse |
| 07 | — | pack schema has network/fs/tools/mcp declaration fields |
| 02 | 01, 09 | marketplace import records `trusted:false`, `sourceKind:"marketplace"` |
| 03 | 09 | client fetches a pack from a (stub) broker URL |
| 04 | 03, 09 | instance keypair registered; entitlement verifies |
| 05 | 03, 09 | a `security` revocation fails closed at run |
| 06 | 03, 09, 01 | L1 lineage verifies; L2 mint record verifies with publisher base-sig preserved |
| 08 | 07, 02, **phase0-sandbox-hardening** | `runCapability` refuses a marketplace pack unless sandbox-constructible |

## Not yet specified
- (none — v2/v3 fog is deliberately out of scope; see Out of scope)

## Out of scope (v2 — needs Phase 3 links)
- **`framework:"workflow"` flows** — need WorkflowDriver inner-agent containment (Phase 0 concern 07). Most catalog
  flows sit here; this is the real catalog unlock and should sequence early in Phase 3.
- **Network-declaring flows** — need the egress allowlist proxy (Phase 3). v1 is `network:none` only.
- **In-container MCP** — v1 run-blocks MCP-declaring flows (daemon-adjacent RCE on the current path).
- **L3 behavioral fingerprint + publish-time originality gate** — a real project; nothing in v1 depends on it.
- **Diff-anomaly advisory scan** — a v2 non-guarantee over the authored-output exfil channel.
- **Transparency-log client verification** — protocol reserves the fields now; verification is v2.

## Out of scope (a separate program of work)
- **The broker service itself** — payments/Stripe, publisher onboarding/vetting, pack-byte serving, the fingerprint
  registry service, entitlement issuance, the CRL service, minting compute. Its own plan, security review, owner.
  This plan delivers the **spec** it must satisfy (concern 09) and codes the client against a stub.

## Out of scope (v3)
- **Flue as a marketplace framework** — structurally unsandboxable today (`create` rejects sandbox for non-omp-rpc,
  `:4348`); revisit only if protocol-agnostic containment ever covers it (open question 5).
- **Cryptographic secrecy tiers** (sealed / remote-node / TEE) — per the memo's own §11 declination.

## Decisions so far
- [v1 executable subset is narrow and honest](08-runcapability-sandbox-wiring.md) — sandboxed omp-rpc profile
  packs, `network:none`, no MCP, no flue, no workflow; everything wider installs but run-blocks with a named link.
- [Seller IP + entitlement are cooperative + forensic, not technical](04-entitlement-client.md) — the broker
  enforces download gating only; the buyer is root on their box.
- [Broker is a trusted broker holding no buyer data — scoped out as a separate program](09-broker-spec-and-stub.md).
- [Signed ≠ safe](08-runcapability-sandbox-wiring.md) — a signature is attribution; the container is the boundary.

## Notes
- Adversarial panel 2026-07-14; both red teams found the same critical (safety rests on a sandbox that's neither
  built nor wired) from crypto and buyer-safety lenses. Detail + all rulings in DESIGN.md.
- **Hard dependency on Phase 0** (`plans/phase0-sandbox-hardening`, PR #175) for concern 08's executable surface.
  Everything else ships in parallel.
- Five MODE:hitl open questions (staleness budget, catalog seeding, instance-identity privacy, transparency-log
  MUST/SHOULD, flue's future) in DESIGN.md.
- Proceeded over the existing WIP pile with the operator's explicit go (this session).
