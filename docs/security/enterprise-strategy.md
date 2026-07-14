# Glance: Enterprise Security & Compliance Strategy

Status: draft strategy memo (2026-07-14). Audience: engineering leadership, enterprise security reviewers,
auditors, investors. Grounded in a three-part read-only audit of `main` @ 9a3aefc (secrets posture, tenant
isolation, identity/access/audit-ops).

---

## 1. Decision & thesis

Glance's enterprise vision is **federated cross-organization agentic collaboration** — organizations publishing
proprietary skills, profiles, catalogs, and workflows and selling those *flows* to other companies. The
architecture that makes this **compliant, IP-preserving, and secure** is:

> **Single-tenant instances + a trust-minimized marketplace + signed, sandboxed, capability-scoped flows.**

Each enterprise runs its own glance instance (its VPC or a dedicated one we operate). Flows are distributed as
signed capability packs through a marketplace that holds *metadata, signatures, entitlements, and usage counts —
never anyone's data or plaintext IP*. A bought flow runs inside the **buyer's** sandbox, against the **buyer's**
data, under the **buyer's** policy and secrets. The seller never sees the buyer's data; the buyer's data never
leaves their boundary; the marketplace operator is a sub-processor of neither.

This is not the "many companies commingled in one daemon" model. That model was audited and found unshippable
(§3). The single-tenant + marketplace model is simultaneously the *safer* architecture and the *easier sell* —
"your data never leaves your cloud" closes enterprise deals faster than any audit report.

**The keystone that unlocks all of it is the agent sandbox** (§5) — one workstream with three payoffs: it is the
fix for the isolation findings, the precondition for safely running a third-party flow, and a core SOC 2 /
ISO 42001 control.

---

## 2. Why glance's threat model is not normal SaaS

Glance runs **arbitrary, model-authored code** — bash, file writes, git operations — on behalf of its users.
That is the threat model of a CI system or a cloud IDE (GitHub Actions, Replit, Vercel build), not of a CRUD
SaaS. The question every enterprise security team asks first is: *"If another customer's AI agent writes a
malicious shell command, what stops it from reading my source off your disk?"*

In the audited shared-daemon model, the honest answer is "path conventions and an environment variable" — and
neither survives an agent that runs `printenv`. The companies that made shared code-execution multi-tenancy work
(Replit, Devin, Vercel) spent years on microVM / gVisor / per-tenant-kernel isolation. Single-tenant deployment
sidesteps that entire cost: **with one org per instance, the cross-tenant threat model does not exist.**

---

## 3. What the audit found (why shared multi-tenancy is an inversion, not a gap)

The data and API layers are actually well-built. The DAL routes every app-table operation through an
org-scoped helper with an explicit `where org_id` predicate; Postgres RLS `FORCE`s org isolation; API org
identity is derived from the session, never a request parameter. On its own, that layer would hold.

But it sits on top of an **unsandboxed agent process holding every secret**. A tenant agent (arbitrary bash by
design) can today:

- Read `DATABASE_URL` from its own environment, open its own Postgres connection, and
  `set_config('app.current_org', '<victim>')` — **RLS is defeated because the attacker now controls the GUC the
  policy trusts.** Full read/write of every tenant's data. (`src/agent-host.ts:172`, `src/db/migrations.ts:196`)
- Read `BETTER_AUTH_SECRET` and forge a valid session cookie for any user in any org.
  (`src/agent-host.ts:172`, `src/server.ts:1124`)
- Connect to sibling orgs' agent-host sockets in a shared global directory and drive, kill, or read their
  streams. (`src/agent-host.ts:52`)
- Read other tenants' worktrees off disk — same uid, no sandbox, deterministic paths. `cat .env` also works: the
  repo's `.env` is mode 0644. (`src/rpc-agent.ts:172`; `.env` perms)

The isolation is therefore **decorative**: anyone who can make an agent run one command owns the daemon. This is
the precise reason the recommendation is *don't ship shared multi-tenant in the current architecture* — and why
the single-tenant pivot is a strategic simplification, not a retreat.

Residual API-level cross-tenant reads exist even without code execution and must be closed regardless of model
(they matter for intra-company team isolation too): `/api/graph/commit?repo=<daemon cwd>` discloses the
operator's own source (`src/server.ts:2701`), and `registerProject` accepts any absolute git path on the host —
the PR #152 class, only half-closed (`src/squad-manager.ts:2404`).

---

## 4. Target architecture: single-tenant instances + trust-minimized marketplace

```
   Enterprise A (their VPC)          Marketplace (data-neutral)         Enterprise B (their VPC)
  ┌───────────────────────┐        ┌──────────────────────────┐       ┌───────────────────────┐
  │  glance instance A     │        │  pack registry:           │       │  glance instance B     │
  │  • A's code, secrets,  │        │   manifests, signatures,  │       │  • B's code, secrets,  │
  │    org/team RBAC       │        │   checksums, licenses,    │       │    org/team RBAC       │
  │  • A's sandbox         │        │   entitlements, usage $   │       │  • B's sandbox         │
  │                        │        │  • NO customer data       │       │                        │
  │  publishes ──────────────pack──▶│  • NO plaintext flow IP*  │◀──pack── imports & runs        │
  │  "flow X" (signed)     │        │                           │       │   flow X in B's sandbox │
  └───────────────────────┘        └──────────────────────────┘       └───────────────────────┘
        seller                          broker / neutral party                buyer
```

Only three cross-boundary flows exist, and each is clean:

1. **Pack: seller → marketplace → buyer.** Signed, checksum-pinned, licensed. The marketplace stores it (sealed
   or as a pointer, per the IP tier in §6); it is never anyone's *data*.
2. **Entitlement / license: marketplace → buyer instance.** A token proving the buyer may run the pack;
   revocable.
3. **Usage / billing: buyer → marketplace.** Counts (mints, runs), never content.

The buyer's data, the buyer's secrets, and the seller's plaintext flow (in the sealed/remote tiers) each stay on
exactly one side. **The marketplace operator is a sub-processor of none of them** — which is what makes the
platform's own compliance surface small.

The existing capability-pack system (checksum-pinned packs of profiles/workflows/recipes) is the substrate; the
marketplace is that plus signing, entitlement, revocation, and vetting (§7).

---

## 5. The keystone: default sandbox + capability-scoped execution

A container/microVM agent sandbox that is **on by default** and hardened — no daemon environment, no host
filesystem, controlled network egress, resource limits — is the single highest-leverage investment, because it
is three things at once:

1. **The fix** for the isolation findings in §3 (no daemon secrets to steal, no sibling fs to read).
2. **The precondition for the marketplace.** Running a bought flow *is* running untrusted third-party code.
   Only a sandbox makes that safe — which is why the sandbox is required **even in single-tenant deployments**,
   where cross-tenant isn't a concern but "run a stranger's flow against my code" very much is.
3. **A core control** for SOC 2 (logical access / CC6) and ISO 42001 (AI system controls).

`SandboxAgentDriver` exists but is opt-in and omp-only; making it the default path and extending it to every
harness is the work.

Pair it with **capability-scoped execution**: a pack *declares* what it needs — which models, which tools,
network egress yes/no, which data scopes — and the buyer's policy grants a least-privilege subset the sandbox
enforces. This is what lets a buyer run a seller's flow with a hard, technical guarantee that it *cannot phone
home with their code*: egress is denied except to declared, buyer-approved endpoints. This is the heart of the
marketplace's safety and a genuine AI-governance differentiator.

---

## 6. Preserving seller IP — the honest tier menu

There is an unavoidable tension: if the buyer can *run* a flow, they can usually *read* it. Most flows are
declarative (prompts, model routing, graph structure, tool bindings) — their value is curation, maintenance, and
domain expertise, not a secret binary. Name the protection tier per flow:

| Tier | Mechanism | Seller IP exposure | Buyer data exposure | Use for |
|---|---|---|---|---|
| **A — Licensed-open** | Signed, checksummed, revocable; buyer can read it | Readable (protected legally + by value-in-updates) | None | Most flows |
| **B — Sealed** | Encrypted pack, decrypted just-in-time in buyer memory under an entitlement token | Blocks casual copying; a root user can still dump memory (stated honestly) | None | Flows with modest secrecy needs |
| **C — Remote node** | Seller hosts the flow; buyer's graph calls it as a remote node | None (never leaves the seller) | Buyer *inputs* go to the seller → needs a buyer↔seller DPA the marketplace brokers | Genuinely secret algorithms, data-tolerant buyers |
| **D — Confidential compute** | TEE (SEV-SNP / TDX) + remote attestation | None — buyer, seller, and platform all blind | None | Gold standard; v3+ effort |

Tiers A and B keep the clean single-tenant data topology (nothing leaves the buyer). Tier C deliberately trades
data locality for IP secrecy and must be surfaced to the buyer as such. Tier D is the long-horizon ambition.

---

## 6a. The two-sided confidentiality problem (mutual distrust)

The marketplace has two confidentiality guarantees to make, and **they pull in opposite directions**: the
buyer's data must not be read, stored, trained on, or exfiltrated by the seller's flow; and the seller's flow
must not be scraped or copied by the buyer. No single mechanism delivers both — you tier by flow sensitivity,
and full mutual distrust is only resolved by hardware.

### Protecting the buyer's data (enforced by the buyer's sandbox, not by trusting the seller)

The seller's flow is untrusted code; the guarantee is containment the *buyer* controls. Load-bearing control:

- **Egress-deny-by-default.** The sandbox blocks all network egress except a declared, buyer-approved allowlist.
  This makes "your data can't leave" a technical fact: no egress path to the seller ⇒ the seller structurally
  *cannot* receive, store, or train on the buyer's data. Stronger than any contract because it's enforced.
- **"Doesn't train on my data" decomposes into three layers**, only the first structural: (1) the seller never
  receives the data (no egress to them) ⇒ training is impossible; (2) for the LLM calls the flow legitimately
  makes, the egress allowlist points only at zero-retention / no-train endpoints (OpenAI ZDR tier, Anthropic
  no-train), backed by a DPA, with the buyer approving *which* model endpoints are reachable; (3) every egress
  attempt (including blocked ones) is logged in the buyer's audit trail, so exfiltration is answerable after
  the fact.
- **Capability-scoped least privilege** — the flow declares which repos/files/tools it reads; the buyer grants a
  subset; the sandbox enforces. A flow scoped to repo X cannot touch repo Y or the buyer's secrets.
- **Ephemerality** — the sandbox is torn down per run; no buyer data accumulates or caches across invocations.
- **Structural cross-enterprise isolation (free from single-tenancy)** — a flow bought by Enterprise A runs in
  A's instance; B's runs in B's. The marketplace never co-locates two buyers' data, so "the seller's flow reads
  *another enterprise's* data" is not mitigated — it is **impossible**: there is no other enterprise's data in
  the instance to read.

### The paradox and its resolution

Tiers A/B run the flow locally (buyer data safe) but let the buyer observe it (weaker IP protection). Tier C
hides the IP but sends the buyer's inputs to the seller (weaker data protection). You can have naive
IP-secrecy **or** naive data-locality, not both — *unless* the execution environment is one **neither** party's
host can introspect. That is **confidential computing** (Tier D), and its elegance is that a single primitive —
**remote attestation** — proves both guarantees at once:

- **To the buyer:** the enclave runs the flow's certified measurement *and* the attested egress policy is locked
  ⇒ it cannot exfiltrate my data.
- **To the seller:** the enclave's memory is hardware-encrypted (SEV-SNP / TDX) ⇒ the buyer's root and
  hypervisor cannot read my flow.

Realized as AWS Nitro Enclaves, Azure Confidential VMs, or **GCP Confidential Space** (purpose-built for
"workload from party A, data from party B, neither trusts the host"). The enclave can be provisioned **inside
the buyer's own VPC**: data residency preserved (never leaves the buyer's cloud), buyer cannot introspect it
(seller IP), egress attested-policy-locked (buyer data cannot leak). This is the north star the earlier tiers
approximate — hardware-dependent and heavy, hence v3, but the only architecture that resolves mutual distrust by
technology rather than contract.

### The load-bearing subtlety: confidentiality follows the plaintext, not the enclave

A TEE protects state *inside* its boundary; it does nothing for data the enclave deliberately sends *out* in
cleartext. **The most common mistake is to enclave the workflow but leave inference as a normal API call.** If
the flow (seller B's IP) runs in an enclave but calls the data-owner A's model endpoint, the inference request —
which carries B's prompts, and *the prompts are most of B's IP* — crosses the boundary into A's plane in
plaintext, and A reads it. The enclave protected B's code and then handed A the prompts through the front door.

So the boundary must be drawn to **enclose the inference itself**, not stop at the workflow. Three configurations,
only the last two safe:

- **Model outside, A-hosted (the trap):** A sees every prompt. Broken.
- **Model in the same enclave:** B's workflow and A's weights co-reside; the workflow calls the model over
  localhost *inside* the enclave; no prompt crosses the boundary in cleartext.
- **Model in a second attested enclave:** A runs a *confidential-inference* endpoint (A's weights, but in an
  enclave A's own operators cannot read), and the workflow-enclave sends prompts over an attested encrypted
  channel. A provides model capacity while structurally blind to request contents.

For the canonical split **A = data + inference, B = workflow**: one confidential VM on A's infra holds all three —
B's workflow, A's weights, A's data (never leaves A's cloud). The workflow calls the model in-process; only a
mutually-agreed *output* leaves. Dual attestation, rooted in the CPU vendor (not either party): A attests the
workflow measurement (egress-locked, won't exfiltrate A's data); B attests the model+runtime measurement (won't
log or persist B's prompts anywhere A can read).

Honest residuals — this is very high assurance, not absolute:
1. **The in-enclave runtime is part of the TCB.** An in-enclave model server that logs prompts to a volume A can
   read defeats everything; the attested measurement must cover the whole stack, incl. "no prompt logging,
   egress-locked."
2. **Side channels** (timing, cache, memory-access, power) have repeatedly leaked from SEV-SNP/TDX in the
   literature. Encryption + attestation raise the bar enormously; padding/constant-time/batching reduce the
   residual; never market it as information-theoretically perfect.
3. **The output channel** returns to A (who owns the data), so A learns what the flow produced — usually fine,
   task-dependent.
4. **Independent discovery is not a technical boundary.** A owns the model and can always run candidate prompts
   to mimic B's behavior — not *reading* B's prompt but re-deriving it; a licensing/legal matter, the flip side
   of "most flow IP is curation, not an unguessable secret."

### What ships when

- **Now (Phase 0–3):** egress-deny-by-default + capability least-privilege + ephemeral runs + full audit +
  publish-time static analysis (buyer-data side) and licensed-open / sealed packs (seller-IP side) — safe for
  the ~90% of flows whose value is curation, not secrecy.
- **Later (Tier C):** remote-node protocol + brokered buyer↔seller DPA — for a secret algorithm with a
  data-tolerant buyer.
- **North star (Tier D):** TEE + dual attestation — for a secret algorithm with a data-sensitive buyer.

---

## 7. Marketplace supply-chain security

A malicious or compromised pack is a supply-chain attack on every buyer that installs it. The marketplace needs:

- **Signing + provenance** — every pack cryptographically signed (sigstore/cosign model), SLSA provenance
  attestation, building on the checksum-pinning that already exists.
- **A revocation channel** — a compromised or malicious pack must be killable across all installs (a CRL-like
  feed the buyer's instance honors).
- **Publisher vetting** — identity verification for sellers; optional pack review / static analysis.
- **Capability declaration as the enforcement contract** — a pack that declares "no network egress, models
  only" and then attempts egress is *blocked by the buyer's sandbox*, not trusted. Declaration + least-privilege
  grant + sandbox enforcement is the trust model (§5).

---

## 8. Compliance framework stack

| Framework | What it is | Priority | Notes for glance |
|---|---|---|---|
| **SOC 2 Type II** | Auditor's opinion that claimed controls operated over a 3–12 month window | **Primary** | ~60% policy / 40% technical. Change-management (CC8) is already strong here — see below |
| **SOC 3** | Public-facing summary of the SOC 2 audit | Free byproduct | No extra work once SOC 2 is done |
| **ISO 27001** | International ISMS standard | Secondary | Often required in EU deals; overlaps ~70% with SOC 2 |
| **ISO 42001** | AI management system standard | **Differentiator** | For an agentic platform this is a real edge, not a checkbox — the sandbox + capability-scoping + decision audit trail is most of it |
| **GDPR / CCPA + sub-processors** | Data-privacy law + processor disclosure | **Mandatory regardless** | OpenAI/Anthropic/xAI see customer source → explicit disclosure + ideally zero-retention agreements. Single-tenant shrinks this dramatically |
| **HIPAA** | US health data | Only if applicable | Requires a BAA; decline unless a health customer needs it |
| **FedRAMP** | US government cloud | **Decline** | Multi-year, multi-million-dollar; not worth it pre-scale |

**The good news on evidence.** SOC 2's change-management criteria (CC8) is where most startups fail, and glance
is unusually strong: a 310-file test suite, defect-class ratchets, adversarial cross-lineage review gates,
PR-based merges, and an audit trail of design decisions. That is real, already-generated evidence. The gaps are
almost entirely in *technical logical-access controls* (CC6) and *operational paperwork not yet written*.

**Practical sequence to Type II:** pick a compliance-automation platform (Vanta / Drata / Secureframe — they
auto-collect evidence from GitHub/cloud/HR) → write the policy set → remediate technical gaps (§9) → readiness
assessment → Type I → begin the Type II observation window → third-party pentest in parallel. Realistically ~3–4
months to Type I with focus, plus the observation window for Type II.

---

## 9. Gap register (from the audit), by control family

Prioritized worst-first. Single-tenant deployment neutralizes most of the **Isolation** bucket for free, but the
sandbox and the intra-company items remain (a member must not read another team's secrets; running a marketplace
flow is still untrusted code).

### P0 — Isolation & secrets (the keystone bucket)
- No default OS sandbox; agents run at the daemon's uid with full filesystem access (`rpc-agent.ts:172`,
  `agent-host.ts:167`).
- Full-environment inheritance leaks `DATABASE_URL`, `BETTER_AUTH_SECRET`, all provider keys to every agent
  (`agent-host.ts:172`; only `SandboxAgentDriver` scrubs). Defeats RLS + enables session forgery.
- Shared global agent-socket directory → cross-org agent RPC injection (`agent-host.ts:52`).
- `.env` and state files (`state.json`, `audit.jsonl`, **raw un-redacted gate logs**) are mode 0644,
  world-readable (`gate-logs.ts:41`).
- No at-rest encryption of any secret; better-auth stores OAuth tokens plaintext in the DB.
- Redaction is best-effort regex — misses `DATABASE_URL`, `ek_` tokens, WorkOS `sk_` keys, non-`authorization`
  header creds (`redact.ts`).
- Residual cross-tenant/operator source reads: `/api/graph/commit?repo=<daemon cwd>` (`server.ts:2701`);
  `registerProject` accepts arbitrary host repos (`squad-manager.ts:2404`); `/api/info` leaks cwd at viewer tier.

### P1 — Identity & access (CC6)
- No MFA/2FA, no email verification, no password policy (better-auth defaults only).
- **Sessions survive deprovisioning** — member removal and SCIM delete null the active org but leave the session
  live (downgraded to viewer), not revoked (`org-admin.ts:112`, `workos-provision.ts:264`).
- An org admin can promote any member to admin (by design; no owner/admin split).
- File mode: auth is fully open when no token is configured (every request → admin); a weak `BETTER_AUTH_SECRET`
  is a total bypass, only refused on non-loopback binds.
- No rotation/revocation for the daemon bearer token, coordinator token, or VAPID key.

### P1 — Audit & change-management evidence (CC7, CC8)
- **Identity/access mutations are unaudited** — role grants, member add/remove, SCIM events, join approvals, org
  rename write no audit entry.
- DB-mode audit drops the `outcome` field; append-only is not DB-enforced; SQLite self-host has no RLS; no
  retention/rotation policy.
- **No CI** — the ratchets and 310 tests run only when a human types `bun test`; no branch protection, no
  CODEOWNERS. This is the cheapest high-value SOC 2 win: wire the existing suite into required CI checks.

### P2 — Data lifecycle (Confidentiality / Privacy)
- **No org-deletion / right-to-erasure** — on-disk worktrees, transcripts, and digests are never cascaded; DB
  FKs cascade only if an org row is deleted, which no code path does.
- No data-export endpoint; no backup/DR tooling or runbook.
- Sub-processor DPAs + zero-retention agreements with the LLM vendors are unwritten.

### P2 — Operational (CC7)
- Rate limiting covers 3 routes; the entire mutating control plane (spawn, command, land, org mutations) is
  unthrottled.
- Unbounded audit-log growth with linear reads.

---

## 10. Roadmap (phased)

- **Phase 0 — Sandbox & secret hardening (foundational, needed for every model).** Default hardened agent
  sandbox (no daemon env, no host fs, egress control, resource limits); at-rest secret encryption; fix
  file perms; redaction hardening; close the residual API source-reads. *Down-payment already in flight:* the
  voice-DB-mode plan's concern 01 (spawn-env scrub) and concern 02 (encrypted secret store) — though the scrub
  is only defense-in-depth; the sandbox is the real boundary.
- **Phase 1 — Identity & audit (SOC 2 CC6/CC7/CC8).** MFA, email verification, password policy, session
  revocation on deprovision; audit every mutating action + immutability + retention; **CI with branch
  protection** (fastest evidence win).
- **Phase 2 — Data lifecycle (Confidentiality/Privacy).** Org deletion + right-to-erasure with on-disk cascade;
  data export; backup/DR runbook; sub-processor DPAs + zero-retention with LLM vendors.
- **Phase 3 — Marketplace.** Signing + SLSA provenance; entitlement/licensing; revocation channel; publisher
  vetting; capability-declaration + least-privilege enforcement (consumes Phase 0's sandbox).
- **Phase 4 — Formalize.** Compliance-automation platform; policy set; readiness assessment; Type I; pentest;
  Type II observation window; ISO 27001/42001 to follow.

Each phase is a candidate `/plan` with its own adversarial design pass. Phase 0 is the natural next one — it is
on the critical path for both the security story and the marketplace.

---

## 11. Explicitly deferred / declined

- **Shared multi-tenant SaaS for mutually-untrusting tenants** — declined in the current architecture; it
  requires microVM-grade isolation (a year+ of platform work) and offers a worse compliance story than
  single-tenant. Revisit only as a deliberate, separately-designed prosumer posture.
- **Confidential-computing (TEE) flow execution (IP tier D)** — a v3+ ambition, not a v1 requirement.
- **FedRAMP** — declined pre-scale.
- **HIPAA** — deferred until a health-data customer requires it (then: BAA + the Phase 0–2 controls likely
  suffice as the technical base).
