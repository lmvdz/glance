# Design: Flow Marketplace — glance Client + Broker Spec (Phase 3, re-cut)

Adversarial design panel, 2026-07-14 (designer → 2 red teams → arbiter). Every load-bearing claim is code-verified
on `main` @ 9a3aefc. This is Phase 3 of the enterprise strategy (`docs/security/enterprise-strategy.md`).

## Arbiter's verdict up front

Both red teams converged on one load-bearing defect and the code confirms it: **the safety story rested on a
sandbox that is neither built to contract (Phase 3) nor wired to the capability path today.** `runCapability`
(`squad-manager.ts:2024-2067`) dispatches every binding through `create` with **no `sandbox` field** — an
installed marketplace flow runs as a plain host `RpcAgent` with full agent privilege. Flue packs execute arbitrary
host binaries via `Bun.spawn` (`flue-service-driver.ts:142`) and *cannot* be sandboxed (`create` rejects sandbox
for non-omp-rpc, `:4348`). Core-tool enforcement is an acknowledged advisory FLAG (`:4134-4140`).

**So v1 executes only the narrow slice genuinely containable today, blocks everything else fail-closed at run
time, and ships the full commerce/provenance layer in parallel** (that layer is real, buildable, and independent
of containment). No marketplace flow ever runs untrusted with host privilege under this design.

## The hard dependency chain (before any untrusted flow runs safely)

**Phase 0 (sandbox substrate) → M1 (this plan: wire `runCapability` → mandatory `SandboxAgentDriver` for
marketplace packs) → Phase 3 (protocol-agnostic containment, default flip, egress proxy, WorkflowDriver
inner-agent containment) → the full untrusted catalog.**

- **Phase 0** ships `--network none`|bridge (no per-domain proxy), worktree mount, omp-rpc-only sandbox. Hard
  external dependency; nothing executable proceeds without it.
- **M1 (built here)** closes the wiring gap: `runCapability` refuses a marketplace (untrusted) pack unless the run
  is constructible as a sandboxed omp-rpc agent with `network:none`. Profile bindings can be; **flue** (`:4348`)
  and **workflow** (inner coder/tester are hardcoded host `RpcAgent`, Phase-0 concern 07) **cannot** → both
  run-blocked, fail closed, with an explicit "requires containment (v2)" reason.
- **Phase 3** unblocks the rest: flue/non-omp (protocol-agnostic containment), `framework:"workflow"`
  (WorkflowDriver containment — *most of the catalog*), network-declaring flows (egress proxy), the default flip.

v1 is **not** gated entirely behind Phase 3 (that over-corrects). Commerce/provenance/signing/entitlement/
revocation/import ship first (no containment dependency). The *executable* surface is gated behind Phase 0 + M1
and is deliberately narrow. A blocked pack names exactly which link it waits on.

## Scope: client + spec, not the broker

This plan builds the **glance-client side + a written broker protocol spec**. The broker — publisher accounts,
vetting, payments/Stripe, pack-byte serving, entitlement issuance, fingerprint minting/registry, CRL service — is
a **separate hosted service and a separate program of work** with its own plan, security review, and owner. v1
must not silently absorb standing up a payment SaaS. The client is built against the spec with a **local stub
broker** for tests; no v1 acceptance requires the production broker.

## Seller IP — cooperative + forensic (the one-sentence truth)

> **The broker technically enforces exactly one thing — who may download paid pack bytes; once installed, a flow
> is readable and modifiable by the buyer (root on their own single-tenant instance), there is no crypto-enforced
> entitlement or technical IP protection on the buyer's box, and seller protection is fingerprint-based
> *detection* plus license terms and legal recourse.**

Coherent with the memo (mostly-open flows; IP = provenance + fingerprinting + licensing, not secrecy). The draft's
error was DRM-shaped offline entitlement against a root-controlling buyer. Entitlement verification on the instance
is **cooperative** — it makes honest instances behave; it does not stop a determined copier. UI copy and spec say
so.

## Signing & provenance

- **Sign raw canonical bytes, full manifest** — not the field-subset checksum (`index.ts:379` provably excludes
  `preview` (the pre-purchase trust surface), `requiredEnv`, `compatibility`, `extra`; `diffCapabilityPacks`
  doesn't diff preview/compat). Detached ES256 (P-256/SHA-256, `push.ts:106-107` precedent) over the exact bytes
  the broker serves → "which fields are covered" becomes a non-question.
- **Verify before parse** — today the checksum is computed *inside* `parseCapabilityManifest` (`:366-379`), forcing
  a structured parse of untrusted input first. Invert: receive `(rawBytes, signature, publisherKeyId)`, verify over
  `rawBytes`, only then parse.
- **Allowlist top-level keys** — convert the `EXECUTABLE_TOP_LEVEL` denylist (`:199`, applied `:368`) to an
  allowlist; unknown keys reject, not silently stashed in `extra`.
- **Key model** — two sets: *sign-authorized* (may produce new sigs; current key only) vs *accept* (existing sigs
  stay valid; includes rotated-out keys until re-signed/expired). Client pins the broker publisher-key directory.

## Entitlement & licensing (cooperative)

The enforced control is **download gating** (broker-side, the entire technical surface). Entitlement tokens are
cooperative state: broker-signed (licensee, pack, terms, expiry, seats); the client verifies, stores, displays,
refuses-by-default to run unentitled marketplace packs, syncs revocations — all honest-instance behavior a root
buyer can bypass. Offline verification retained for the honest path, never described as operator-resistant.
**Licensee identity ≠ `orgId`** (collapses to `"file"` in single-tenant, `:409`): the instance generates a keypair
at first marketplace connect and registers it with the broker; entitlements bind to that instance identity + the
purchaser's broker account. DB-mode orgs layer on later; file-mode works day one.

## Buyer-safety enforcement

- **The wiring gap (M1):** marketplace packs get a non-operator-editable `sourceKind:"marketplace"` marker;
  `runCapability` requires an untrusted-source run to be constructible as `SandboxAgentDriver` (omp-rpc, worktree
  mount, `network:none`) or refuses it, naming the missing link. **Signed ≠ safe** is an axiom — a signature is
  attribution, never a safety property; the advisory core-tool grant is defense-in-depth UX, never a boundary.
- **Egress: v1 = `network:none` flows only.** A network-declaring flow imports/displays fine, run-blocked until the
  egress proxy exists (Phase 3, *not* this plan — jamming a TLS-intercept/SNI-allowlist proxy into the marketplace
  critical path would ship it badly).
- **MCP: run-blocked in v1.** A granted MCP server is arbitrary `{command,args}` spawned host/daemon-side
  (`:4419-4420`), and `sanitizeRepoProfile`'s mcp-drop is bypassed by `opts.mcp ?? profile.mcp` (`:4163`) —
  daemon-adjacent RCE. v2 = MCP spawned *inside* the flow's container only.
- **The output channel — buyer-code confidentiality is NOT a guarantee, verbatim.** The worktree is mounted RW
  because the flow edits the buyer's repo (`:4377`); the flow reads any file (unscoped core read) and its **authored
  diff** — landed and possibly published — is an exfil channel `network:none` cannot close without closing the
  product. What v1 *does* guarantee for a contained run: no network egress, no fs beyond the mounted worktree, no
  host persistence, no daemon-env exposure. The diff is the buyer's control surface (existing land-gates/review
  apply); a diff-anomaly advisory scan is a v2 non-guarantee. Install UI states the boundary in one sentence.

## Fingerprinting

- **L1 (v1):** provenance lineage — publisher identity, signed version chain, full-raw-byte content hashes.
- **L2 (v1, re-founded honestly):** the **durable** tracing signal is the broker's **purchase ledger**
  (payload-hash → licensee at mint) + L1 exact/near-copy matching. The embedded watermark (NL-prompt / DOT-comment
  variation) is **labeled "best-effort forensic marker"** — near-zero carrier capacity, dies to a formatter/LLM
  rewrite; **no collusion-resistance / Boneh–Shaw claim anywhere.** Mechanics: preserve the publisher's signature
  over base `F`; the broker signs only a small **mint record** (base-hash, licensee, watermark delta) with a
  **separate short-lived minting key** — the offline root/CRL key is never a hot per-purchase signer.
- **L3 (v2):** behavioral fingerprinting + publish-time originality gate — deferred; nothing in v1 depends on it.

## Revocation (reason-typed, fail-closed for security)

- **`reason: security` ⇒ fail closed:** blocked the moment the revocation syncs; an instance whose CRL is staler
  than a bounded budget (default 72h, operator-tightenable, never loosenable past 7 days) refuses to *run*
  marketplace packs until it refreshes (install untouched, execution gated). `reason: license/commercial` ⇒
  warn-and-continue (cooperative; blocking buys nothing against root, punishes honest offline use).
- **Monotonic signed epoch** — client persists the high-water mark, rejects older CRLs (defeats rollback/pin).
- **Dedicated revocation key**, offline with the root key, distinct from serving/minting keys.

## Import trust pipeline (sequenced, default-untrusted, structural-verify labeled)

1. **Fetch** raw bytes + detached sig + publisher key id (download entitlement-gated broker-side).
2. **Verify signature over raw bytes** vs the pinned publisher directory. Fail ⇒ bytes discarded unparsed.
3. **Parse** under the top-level allowlist; unknown keys reject.
4. **Structural verification** (`verifyCapabilityPack`, `:236-270`) — **relabeled everywhere (API/UI/audit) as
   "structural verification": provenance + well-formedness only, never behavioral safety.** No content/behavior
   scan; the design forbids presenting it as one.
5. **Record `sourceKind:"marketplace"`, `trusted:false` unconditionally** — flips today's trusted-OPEN default
   (`trusted: input.trusted !== false`, `:348`). Admin-only import stays; admin ≠ trusted content.
6. **Run-gate evaluation at execution time** (sandbox-constructible? network:none? no MCP? binding runnable?) —
   never at import, so the gate reflects the instance's *current* containment capability.

## Broker spec (a spec, not a build)

**"Trusted broker, holds no buyer data" — "data-neutral" is retired as an overclaim.** True and load-bearing: the
broker never holds any buyer's code/repos/runtime data. But it *is* a trust anchor (publisher keys = root of
trust; fingerprint/payload→licensee registry; CRL + root keys; pack bytes; payments). Spec mandates:
- **Key separation:** offline root (publisher-directory attestation, CRL) ✕ online serving key ✕ short-lived
  minting key. An online-key compromise never forges revocations or publisher attestations.
- **Separate trust domain** for the fingerprint registry + payload→licensee map (leak = mass watermark evasion +
  licensee deanonymization): distinct service/KMS, access-audited, not on the catalog/serving path.
- **Transparency log (SHOULD):** append-only Merkle log of manifest hashes + key events; client verifies inclusion
  proofs when present (protocol reserves the fields now).
- **Client-facing API:** publisher directory, catalog listing (signed metadata incl. full signature-covered
  `preview`), entitlement purchase/issue/verify, entitlement-gated download, epoch-monotonic CRL fetch, mint
  endpoint (L2), instance-identity registration.

## Key decisions

| # | Decision | Ruling |
|---|---|---|
| 1 | Gate behind containment? | Commerce/provenance ship now; *execution* gated per-pack by the run-gate matrix. v1 executable = sandboxed omp-rpc profile packs, `network:none`. Nothing untrusted runs host-side. |
| 2 | Entitlement | Cooperative + forensic; broker enforces download gating only; on-box verify is honest-instance behavior. |
| 3 | Signing | ES256 over raw canonical bytes, full manifest, verify-before-parse, top-level allowlist, accept/sign key sets. |
| 4 | Broker | "Trusted broker, holds no buyer data" (not "neutral"); key separation; registry in a separate trust domain; transparency-log SHOULD. Broker scoped OUT as a separate program; this plan = client + spec. |
| 5 | Revocation | Reason-typed; `security` fails closed (72h budget); monotonic signed epoch; dedicated offline key. |
| 6 | L2 minting | Kept; broker ledger is the durable signal; watermark = best-effort forensic; publisher base-sig preserved; separate short-lived minting key; no collusion-resistance claim. |
| 7 | Buyer-code confidentiality | **Not a guarantee.** Authored diff is a named unclosable exfil channel; guarantee = no egress / no fs-beyond-worktree / no persistence. |
| 8 | Egress | v1 = `network:none` only; proxy stays in Phase 3. |
| 9 | MCP | Run-blocked v1 (daemon-adjacent RCE); v2 = in-container only. |
| 10 | Substrate | Marketplace sources hard-set `trusted:false`; licensee = broker-registered instance keypair (not `orgId="file"`); catalog broker-side + local cache; `verifyCapabilityPack` relabeled structural. |

## Risks

- **v1 catalog thinness** — profile-only + `network:none` + no-workflow excludes most existing catalog flows
  (`framework:"workflow"`). Accepted: a thin honest catalog beats a wide one running untrusted code host-side.
  v2 (WorkflowDriver containment) is the real unlock — sequence it early in Phase 3.
- **Phase 0/3 slippage** → a browsable store where little runs. Mitigation: the run-gate matrix makes the gap
  legible per-pack; commerce layers lose no work either way.
- **Broker program divergence** from the spec. Mitigation: versioned spec, conformance-tested via the stub.
- **Watermark over-trust by sellers** despite labeling. Mitigation: repeat the ledger-not-watermark framing in
  publisher-facing copy at listing time.
- **Sandbox escape** collapses the v1 guarantee. Mitigation: Phase 0 hardening is a prerequisite; marketplace runs
  pin the most restrictive profile.

## Open questions (MODE: hitl)

1. Security-revocation staleness budget — 72h default; right for mostly-online single-tenant instances? Documented
   (never silent) opt-out for offline-heavy deployments?
2. v1 catalog seeding — author first-party profile-shaped flows to seed the thin v1 catalog, or hold launch until
   v2 widens the runnable set?
3. Instance-identity privacy — the broker-registered keypair links purchases to instances; a pseudonymous purchase
   mode (entitlement bound to account, instance binding optional) worth the seat-enforcement loss?
4. Transparency log — SHOULD in the spec; promote to MUST for the broker program's v1 given the trust concentration?
5. Flue's future — structurally unsandboxable today (`:4348`); ever a marketplace framework, or ruled out
   permanently to simplify the matrix?
