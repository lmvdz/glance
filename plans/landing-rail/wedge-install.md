# Operator install runbook — the GitHub-App wedge (glance#337, rail T9)

Requires every pull request on ONE external repo to carry a verified glance landing-rail receipt, via
the Checks API, with **zero adoption** by that repo — no workflow file, no Action, no dependency added
to their CI. (An earlier design gated only PRs classified agent-authored; two gauntlet rounds proved
that's not a safe posture with a static Ruleset and no provenance signal — see the headline section
below for why this now gates ALL PRs, fail-closed, with agent-authorship rendered as informational
context only.) This is the SPIKE build: the mechanism (`src/rail/wedge/`) is built and unit-tested
against a mocked GitHub API; this document is the missing piece — the exact steps an operator with
admin rights on the target repo runs to actually install it. Design source:
`plans/landing-rail/research/github-app-wedge.md` (R1, on `research/github-app-wedge` — the adjudicated
recommendation this build's MECHANICS implement verbatim; the gating POSTURE was corrected post-R1 by
the gauntlet, see below).

No live install has been performed. This repo's build environment has no `GLANCE_GH_APP_*` credentials
and no admin rights on an external target repo — every step below is written from R1's research plus
GitHub's own API docs, not verified against a real App registration. Treat step 5 (the Ruleset JSON) as
the highest-risk unverified step: it's typed from the API reference, not round-tripped against a live
repo.

## HEADLINE OPEN PRODUCT QUESTION (gauntlet rounds 1 and 2 — for Lars, not solved here)

**"Gate only agent-authored PRs" is not safely representable by a static required-status-check
Ruleset, full stop.** This took TWO gauntlet rounds to converge on the real answer, and the failure
mode in between is the important part to understand:

- **Round 1** flagged: a Ruleset's required check applies to EVERY PR update — there is no "only
  require this check for agent PRs" option in GitHub's model. The wedge's original cut posted a check
  only for PRs it classified agent-authored and SKIPPED everything else, which would have blocked
  every ordinary human PR outright under an active Ruleset.
- **Round 1's OWN fix** — post an honestly-labeled, INFORMATIONAL `success` for any PR NOT classified
  agent-authored, so the Ruleset stays satisfiable without gating humans — was ITSELF the round 2
  CRITICAL finding (codex delta-verify): that `success` is **Ruleset-indistinguishable** from a real
  verified one. Same context string, same head SHA, same `integration_id`, same `conclusion` — a
  Ruleset can only see `conclusion`, never `output.text`. So an agent posing as human (or simply
  avoiding the classification signals, which cost it nothing since they're avoidable by construction —
  a login name and a branch name are both attacker-chosen) got classified non-agent, received the
  automatic `success`, and **merged with no receipt ever verified.** Round 1's fix turned "missing-check
  blocks everyone" into "green bypass for anyone who dodges the signals" — strictly worse than the
  original bug, because it LOOKS like a working gate on the Checks tab.

**THE ACTUAL ANSWER (round 2, closing): gate ALL PRs, fail-closed, no authorship exception.**
`success` now requires a receipt that verifies through `verifyReceiptForPr` — repo/SHA/gate-outcome/
freshness, all four — for EVERY PR, regardless of what `classifyAgentAuthorship` says.
Authorship classification is now **purely informational**: it's rendered as an "agent-authored:
yes/no" context tag on every check-run output (`receipt-adapter.ts`), but it never changes
`conclusion` (`post-check.ts`). A security gate cannot key pass/fail on a signal the actor being
gated can set or avoid — that is the literal shape of round 2's finding, proven by construction, not
a theoretical concern.

**What this means for a deployer — TWO coherent postures, and this build implements only the first:**

1. **Gate-all, fail-closed, for a repo where every merge is expected to carry a glance receipt** — an
   agent-only pilot repo, or a repo that deliberately opts into "every PR needs a landing-rail receipt
   to merge." This is what the wedge does now. **The known, correct cost: a human PR with no glance
   receipt is BLOCKED too** (`action_required`, same as an agent PR with no receipt). That's not a bug
   to work around — a gate that greens un-verified PRs is not a gate, which is exactly what round 2
   proved about the alternative.
2. **Don't deploy the required check on a genuinely mixed human+agent repo at all**, until a
   trustworthy provenance signal exists that can't be spoofed or avoided by the actor being classified
   — glance does not have one today. This build deliberately does NOT invent one (codex's explicit
   instruction, and the right call: a fabricated provenance mechanism would just be a more elaborate
   version of the same bypass).

Composing point on the authorship signal itself: the `Co-Authored-By:` trailer default is still OFF
(see Step 5) — not because it could force-gate humans anymore (it can't; authorship no longer decides
`conclusion`), but because `Co-authored-by:` is GitHub's own standard trailer for ANY multi-author
human commit, and defaulting it on would MISLABEL ordinary human pair-programming PRs as
"agent-authored: yes" in the informational context, which is misleading even though harmless to the
actual gate outcome.

## Prerequisites

- Repo-admin (or org-admin, for an org-owned repo) rights on the target repo, to install the App and
  edit its Ruleset.
- A machine (or the glance daemon's own host) that can run `bun run scripts/post-wedge-check.ts` and
  reach `api.github.com` outbound.

## Step 1 — Register the GitHub App

Go to **github.com/settings/apps/new** (personal account) or the org's equivalent
(`github.com/organizations/<org>/settings/apps/new`) and fill in:

| Field | Value |
|---|---|
| GitHub App name | `glance-landing-rail` (or similar — must be globally unique across all of GitHub; this is USER-FACING the moment it posts its first check, so pick the public name deliberately) |
| Homepage URL | the glance project's public URL, or the operator's own site — required by the form, not otherwise load-bearing for v1 |
| Webhook | **Uncheck "Active"** — v1 is daemon-triggered (push-only), no webhook receiver exists yet (see Fog #4 below) |
| Repository permissions → Checks | **Read & write** |
| Repository permissions → Pull requests | **Read-only** (upgrade to **Read & write** only if a later iteration mirrors the receipt as a PR comment too — the spike doesn't) |
| Repository permissions → Metadata | Read-only — GitHub sets this automatically on every App, no action needed |
| Subscribe to events | none required for v1 |
| Where can this GitHub App be installed? | **Only on this account** (single-operator/single-repo posture, matching R1's scoping) |

Click **Create GitHub App**. Note the **App ID** shown on the resulting settings page — this is
`GLANCE_GH_APP_ID`.

## Step 2 — Generate and store the private key

On the App's settings page, scroll to **Private keys** → **Generate a private key**. GitHub downloads a
`.pem` file immediately (this is the only time the raw key is available — GitHub does not store a copy
you can re-download).

Move that file to a path only the daemon's process user can read (`chmod 600`), e.g.:

```
mkdir -p ~/.glance/secrets
mv ~/Downloads/glance-landing-rail.*.private-key.pem ~/.glance/secrets/gh-app-private-key.pem
chmod 600 ~/.glance/secrets/gh-app-private-key.pem
```

`GLANCE_GH_APP_PRIVATE_KEY` is set to this **path**, never the PEM content inline (mirrors
`GLANCE_SECRETS_KEY_FILE`'s file-over-inline convention in `.env.example` — the key material spends as
little time as possible sitting directly in `process.env`). See Fog #2 below for where this file should
live in an actual production deployment; a home-directory path is a placeholder, not a recommendation.

## Step 3 — Install the App on the target repo

From the App's settings page, **Install App** → pick the target repo (or org, then select "Only select
repositories" and pick the one repo). Confirm.

After install, the URL bar shows `github.com/settings/installations/<installation-id>` (personal) or
`github.com/organizations/<org>/settings/installations/<installation-id>` (org) — that trailing number
is `GLANCE_GH_APP_INSTALLATION_ID`. It's also readable via the API:
`GET /orgs/{org}/installations` (or `GET /user/installations` for a personal-account App), authenticated
with the App JWT (`mintAppJwt` in `src/rail/wedge/jwt.ts` produces one — `bun run` a one-off script that
calls it and hits that endpoint if the UI number is ambiguous).

## Step 4 — Configure the Ruleset (the actual gate)

This is the step that makes the check **required** and **spoof-proof** — without `integration_id`, any
collaborator with write access could satisfy the same `context` string via the legacy Status API and
the gate would be theater (R1's core finding).

In the target repo: **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.

- **Ruleset name**: `glance-landing-rail`
- **Enforcement status**: Active
- **Target branches**: the default branch (`main`), or whichever branch(es) receive agent PRs
- **Rules → Require status checks to pass**: enable, then **Add checks** → search for the App's check
  name (`glance/landing-rail-receipt` — see `DEFAULT_CHECK_NAME` in `src/rail/wedge/post-check.ts`) and
  select it. GitHub's UI resolves `integration_id` for you when you pick a check that's actually posted
  by an installed App with a matching name — **this means the App must post at least one check-run
  before the Ruleset UI offers it as a selectable option** (the same bootstrapping wrinkle R1's brief
  flags for classic branch protection; Rulesets don't fully escape it either). Run Step 6 (post one
  check-run manually, e.g. against a scratch PR) BEFORE this step if the UI doesn't show the check yet.

Equivalent API call (`POST /repos/{owner}/{repo}/rulesets`, authenticated as a repo admin — a personal
access token or an admin's OAuth token, NOT the App's own credentials, since Rulesets are configured by
a human/admin identity, not by the App being gated):

```json
{
  "name": "glance-landing-rail",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [
          {
            "context": "glance/landing-rail-receipt",
            "integration_id": 123456
          }
        ],
        "strict_required_status_checks_policy": true
      }
    }
  ]
}
```

Replace `123456` with the real numeric App ID from Step 1 (`GLANCE_GH_APP_ID`). `context` must exactly
match `DEFAULT_CHECK_NAME` (or whatever `--check-name` override the daemon posts with — the two must
agree or the Ruleset never sees a matching check).

**`strict_required_status_checks_policy: true`, not `false`** (gauntlet round 1, codex MEDIUM): strict
mode requires the PR be up to date with its base branch before the check can satisfy the merge
requirement. Without it, a receipt validated back when the PR's base was commit B0 stays load-bearing
even after `main` has advanced to an incompatible B1 — the receipt's SHA-binding (`verifyReceiptForPr`
in `src/rail/wedge/receipt-verify.ts`) proves the receipt matches the PR's HEAD commit, but says nothing
about whether that head is still tested against the CURRENT base. Strict mode is GitHub's own answer to
exactly that gap — it composes with, rather than duplicates, the wedge's own commit-binding check.

## Step 5 — Set the daemon's environment

```
GLANCE_GH_APP_ID=123456
GLANCE_GH_APP_INSTALLATION_ID=78901234
GLANCE_GH_APP_PRIVATE_KEY=/home/glance/.glance/secrets/gh-app-private-key.pem
```

Optional authorship-CLASSIFICATION overrides (comma-separated; informational only since the round 2
gauntlet fix — see the headline section above — defaults live in `src/rail/wedge/authorship.ts`'s
`DEFAULT_AUTHORSHIP_CONFIG` and are almost certainly fine as-is for a glance-only pilot repo):

```
GLANCE_GH_APP_BOT_LOGINS=copilot-swe-agent[bot]
GLANCE_GH_APP_BRANCH_PREFIXES=agent/,copilot/,codex/
GLANCE_GH_APP_TRAILER_KEYS=              # OFF by default — see below
```

`GLANCE_GH_APP_TRAILER_KEYS` is empty by default: `Co-authored-by:` is GitHub's own standard trailer
for any multi-author human commit, so leaving it on by default would MISLABEL ordinary human
collaboration PRs as "agent-authored: yes" in the check-run's informational text (it can no longer
force-gate them into anything — the gate outcome doesn't depend on this classification). Only set it if
your repo's own convention makes the trailer actually mean "an agent wrote this," e.g. a repo-specific
practice of tagging agent commits with a distinct trailer key.

Optional freshness override (defaults to 24h — `DEFAULT_MAX_RECEIPT_AGE_MS`,
`src/rail/wedge/receipt-verify.ts`):

```
GLANCE_GH_APP_RECEIPT_MAX_AGE_MS=86400000
```

See `.env.example`'s "GitHub-App wedge" section for all of the above, inline.

## Step 6 — Post a check-run (the one-command daemon invocation)

```
bun run scripts/post-wedge-check.ts --owner <o> --repo <r> --pr <n> [--receipt <path-to-LandReceipt.json>] [--details-url <url>]
```

Every invocation posts a check-run — never a skip, and **authorship classification never changes the
outcome** (round 2 gauntlet fix). Which outcome, by receipt state ONLY:

| Receipt state | Conclusion | Reason |
|---|---|---|
| none supplied | `action_required` | `receipt-missing` |
| supplied, malformed (fails `LandReceiptSchema`) | `action_required` | `receipt-missing` (with a "malformed" note) |
| supplied, wrong repo/commit/gate-outcome/stale | `failure` | `receipt-rejected` (the summary says exactly which check failed) |
| supplied, verified against THIS PR's head | `success` | `receipt-verified` |

This table is IDENTICAL for an agent-classified PR and a human-classified PR — that symmetry is the
whole point of the round 2 fix. `classifyAgentAuthorship`'s result is rendered as an "agent-authored:
yes/no" informational tag inside every one of the four outcomes above, but never picked as, or
substituted for, one of the outcomes themselves.

A receipt only reaches `success` after `verifyReceiptForPr` (`src/rail/wedge/receipt-verify.ts`) checks
ALL of: the receipt's `repo` matches this PR's repo, `receipt.commit` equals the PR's CURRENT head SHA
(fetched fresh from GitHub for this call, never trusted from the caller), the gate outcome is a proven
one (`landed === true`, `gate.status` is `"green"` or `"red-baseline"`, NOT `forcedWithoutProof`), and
the receipt is no older than the freshness window (Step 5). This is the gauntlet round-1 CRITICAL fix —
previously ANY truthy receipt object greened the check regardless of what it actually said.

**Freshness caveat (codex, round 2)**: `receipt.at` is SELF-ASSERTED by whatever produced the receipt —
there is no external signature or timestamp anchor. An actor who can construct/rewrite a receipt file
can reset its `at` field to "now" and pass the freshness check trivially; freshness alone is not an
authenticity guarantee. Accepted as a documented limitation, not a spike blocker: the SHA-binding and
gate-outcome checks are the load-bearing ones (they bind the receipt to a specific commit and a
specific proven outcome, which a self-asserted timestamp can't fake around), and freshness is a
secondary hygiene check (catches accidental staleness, not a determined forger). A future fast-follow
would sign receipts (e.g. with the same App private key, or a daemon-held signing key) so `at` — and
the rest of the receipt — carries real provenance instead of being trusted as-typed.

- `output.text` carries the full T6 receipt (identical to the PR-comment renderer's markdown —
  `src/rail/receipt/render-comment.ts`) only on the `success` path; the other paths explain what's
  missing/wrong instead.
- The receipt JSON file is a serialized `LandReceipt` (`src/rail/receipt/types.ts`), decoded through
  `LandReceiptSchema` (`src/rail/wedge/receipt-schema.ts`) — never a bare parse-and-cast. The daemon's
  own land path would call `postAgentPrCheck` (`src/rail/index.ts`) directly with the in-memory object
  instead of going through a file; the CLI's file form exists for this manual/spike invocation.

Re-running against the same PR (same head SHA) **updates** the existing check-run (`PATCH`) rather than
creating a duplicate — `findExistingCheckRun` in `src/rail/wedge/check-run.ts` looks up this App's own
prior check by name before deciding POST vs PATCH. **Known residual race** (gauntlet round 1, codex LOW,
not fixed — documented instead): find-then-decide is not atomic. Two `postAgentPrCheck` invocations
racing for the SAME PR/SHA can both find "no existing check," and both POST, leaving two
`glance/landing-rail-receipt` check-runs instead of one updated in place. The `name`+`app.id` filter in
`findExistingCheckRun` still correctly prevents clobbering a DIFFERENT app's check (that part is sound);
the residual is cosmetic duplication of the wedge's OWN check, not a merge-bypass — GitHub's required-
check evaluation is satisfied by any one matching successful check-run, so a duplicate doesn't weaken
the gate. Acceptable for a spike invoked at most once per land event; a real fix needs either a
distributed lock the CLI doesn't have infrastructure for, or accepting occasional duplicates as normal
and periodically pruning them — neither built here.

## Verification

- The PR's **Checks** tab shows `glance/landing-rail-receipt` with the posted conclusion.
- `output.summary` (the short verdict) shows in the merge-box "Show all checks" popover.
- `output.text` (the full receipt) is on the check-run's own detail page — click through from the
  Checks tab, not visible inline in the merge box.
- With the Ruleset from Step 4 active, a PR whose check is `action_required`/`failure` cannot merge
  through the UI's "Merge" button (rules-required-check enforcement) — an admin can still bypass via the
  Ruleset's bypass list if one is configured, by design (audit-trailed, not a wedge concern).
- Open an ordinary human PR with NO glance receipt (no agent-authorship signal matched, nothing
  supplied via `--receipt`) and confirm it gets `action_required`, exactly like an agent PR with no
  receipt would — **this IS the correct, intended behavior** (round 2 gauntlet fix: gate-all,
  fail-closed, no authorship exception). If this PR instead shows `success`, the gate-all fix
  regressed — that is the ONE thing to check before trusting this build in production.
  See the headline product question above for why a human-authored PR being blocked here is the known,
  accepted cost of this posture, not a bug.
- Feed a receipt whose `commit` deliberately does NOT match the PR's head SHA (or one with
  `gate.status: "failed"`) through `--receipt` and confirm the check posts `failure`, not `success` —
  this is the gauntlet round-1 CRITICAL fix; a mismatched or unproven receipt must never green the
  check, for ANY PR regardless of its authorship classification.
- Confirm the check-run's `output.text` shows an "Authorship classification (informational only —
  never affects this check's conclusion)" block on every outcome — that label is the visible proof the
  classification is context, not a gate decision.

## Live-vs-test-proven status of this build

No `GLANCE_GH_APP_*` credentials were available in the build environment (checked; none present), and
registering a real App + installing it on an external repo + provisioning a Ruleset needs admin rights
this build could not obtain headlessly — exactly the reality constraint the ticket named. So: the
mechanism (JWT mint → installation-token exchange → PR fetch → receipt verification → check-run
create/update, with authorship classification as informational context only) is built and covered by
**96 unit tests** against a mocked GitHub API (`tests/rail-wedge-*.test.ts`), covering the auth flow,
the receipt-verification policy (repo/SHA/gate-outcome/freshness — every gauntlet round-1 CRITICAL
scenario: mismatched commit, mismatched repo, a failed-land receipt, a stale receipt, each asserted
NON-success), the `LandReceiptSchema` decode (well-formed and malformed shapes), all THREE check-run
outcomes (verified/rejected/missing) proven IDENTICAL for an agent-classified and a human-classified
PR (the round 2 CRITICAL fix — no authorship exception on either the success or failure path), the
idempotent find-existing-then-PATCH path, every authorship signal plus the default opt-out of the
trailer signal, and the trust-boundary escaping into the check-run's markdown output (including the
informational authorship block itself). This document is what closes the gap between "the mechanism
works" and "the mechanism is installed on a real repo" — running it end to end against a real target
repo is the next, not-yet-taken step.

## Fog — open product questions this spike deliberately doesn't solve

1. **Which repo is the pilot target?** Not chosen yet. Whoever picks it needs repo-admin (or org-admin)
   rights to run Steps 3–4 above — confirm that's a real capability before committing to a repo, not
   something requested mid-rollout (R1's own open question #1, still open).
2. **Where does the App's private key live in production?** Step 2 above uses a placeholder home-dir
   path. A real deployment needs this behind the same secret-handling posture `src/secrets.ts` documents
   for the master key (ideally a mounted secret file with restrictive permissions, not a path under a
   developer's home directory) — not designed here.
3. **The concrete receipt→check schema** is `LandReceipt` (`src/rail/receipt/types.ts`) end to end — no
   new schema was invented; `receiptToCheckOutput` (`src/rail/wedge/receipt-adapter.ts`) is a thin
   adapter, not a new data model. If a future iteration wants check-run-SPECIFIC fields (e.g. a
   shorter/differently-prioritized summary than the PR-comment's first line), that's new design work,
   not present here.
4. **Stale-receipt invalidation on a new push.** v1 is push-only: the daemon posts a check-run for the
   head SHA it verified. If a human pushes a NEW commit to the same PR afterward, the OLD check-run
   stays green against the OLD SHA — GitHub's Ruleset re-evaluates required checks per-SHA, so the new
   SHA has NO check at all (not a stale green one) unless the daemon re-runs and re-posts. This CLI's
   idempotent PATCH only updates a check for the SAME SHA it's given; it does nothing for a differing
   new SHA. Note this is DIFFERENT from the SHA-binding fix above: `verifyReceiptForPr` guarantees a
   receipt can't be REUSED across commits it wasn't proof for, but says nothing about the NEW commit
   simply having no check yet at all. The real fix (per R1) is the `pull_request: synchronize` webhook
   fast-follow — mark the prior check `neutral`/`stale` the moment a new commit lands, so a
   stale-but-green required check never sits load-bearing. Not built; webhooks are entirely unused in
   this spike (Step 1 explicitly disables the webhook).
5. **Conditional agent-only gating needs a real provenance signal — CLOSED by gating everyone instead
   (round 2).** The headline open product question at the top of this document, restated for the fog
   list: two gauntlet rounds converged on "there is no safe middle ground between gate-all and
   gate-nothing without a provenance signal glance doesn't have." This build now gates ALL PRs,
   fail-closed. The genuinely open piece for Lars is which of the two coherent postures the headline
   section lists (gate-all-fail-closed on an opt-in/agent-only repo, vs. don't deploy the required
   check on a mixed repo at all) fits the actual pilot target once #1 above is answered — not whether
   conditional gating can be made safe (it can't, without a provenance signal this spike deliberately
   didn't invent).
6. **Receipt authenticity has no anchor (round 2, codex).** `receipt.at`, and every other field on a
   `LandReceipt`, is self-asserted — there is no signature or external timestamp binding it to the
   process that produced it. `verifyReceiptForPr`'s SHA-binding and gate-outcome checks are the
   load-bearing security properties (they tie the receipt to a specific commit and a specific proven
   pipeline outcome); freshness is a hygiene check on top, not an authenticity guarantee — an actor who
   can construct a receipt file can set its timestamp to whatever passes. Accepted as a documented
   limitation for the spike (see Step 6's freshness caveat); a signed-receipt fast-follow (the App's own
   key, or a daemon-held signing key) is the real fix, not built here.
