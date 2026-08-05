# Operator install runbook — the GitHub-App wedge (glance#337, rail T9)

Gates agent-authored PRs on ONE external repo with a glance landing-rail receipt, via the Checks API,
with **zero adoption** by that repo — no workflow file, no Action, no dependency added to their CI.
This is the SPIKE build: the mechanism (`src/rail/wedge/`) is built and unit-tested against a mocked
GitHub API; this document is the missing piece — the exact steps an operator with admin rights on the
target repo runs to actually install it. Design source: `plans/landing-rail/research/github-app-wedge.md`
(R1, on `research/github-app-wedge` — the adjudicated recommendation this build implements verbatim).

No live install has been performed. This repo's build environment has no `GLANCE_GH_APP_*` credentials
and no admin rights on an external target repo — every step below is written from R1's research plus
GitHub's own API docs, not verified against a real App registration. Treat step 5 (the Ruleset JSON) as
the highest-risk unverified step: it's typed from the API reference, not round-tripped against a live
repo.

## HEADLINE OPEN PRODUCT QUESTION (gauntlet round 1, both lineages HIGH — for Lars, not solved here)

**"Gate only agent-authored PRs" is not safely representable by a static required-status-check
Ruleset.** A Ruleset's required check applies to EVERY PR update to the protected branch — there is no
"only require this check for agent PRs" option in GitHub's model. The wedge's original cut posted a
check only for PRs it classified as agent-authored and SKIPPED everything else; under an active
Ruleset that would have blocked every ordinary human PR too (no check ⇒ required check never
satisfied ⇒ can't merge), and the alternative — "no check posted ⇒ treat as passing" — recreates the
exact evasion the check exists to prevent (an attacker just avoids every authorship signal).

This build resolves it for the pilot by making **every PR get a check-run**: an agent-authored PR runs
the real receipt-verification pipeline (success/failure/action_required); a PR that does NOT classify
as agent-authored gets an honestly-labeled, INFORMATIONAL `success` (`notRequiredOutput` —
`src/rail/wedge/receipt-adapter.ts`) so the Ruleset stays coherent without silently gating human work.
**This is the simpler-and-honest choice, not "gate all PRs for real"** — a human PR is never asked to
produce a landing-rail receipt, its check just always passes. The two live options were (a) this
informational-pass-for-everyone posture, or (b) scope the pilot to a repo where every PR really is
agent-authored by convention and the skip branch is simply never exercised; (a) was picked because it
degrades safely on an arbitrary pilot repo instead of depending on an assumption about that repo's
traffic holding forever. Whether the wedge should ever gate a genuinely mixed human+agent repo for
real — which needs a trustworthy provenance signal glance does not have today, not merely a better
allowlist — is the open product question. Not invented or solved here; surfaced for a decision.

Composing point: the previous default authorship signal (`Co-Authored-By:` trailer) is now OFF by
default (see Step 5) because it's GitHub's own standard trailer for ANY multi-author human commit —
defaulting it on would classify an ordinary human pair-programming PR as agent-authored, sending it
down the RECEIPT-REQUIRED path (not the informational "not required" one) even though no landing-rail
receipt for it will ever exist, force-`action_required`-blocking normal human collaboration. This isn't
a full fix for the deeper question above; it just removes the worst false-positive from today's default.

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

Optional authorship-gate overrides (comma-separated; defaults live in
`src/rail/wedge/authorship.ts`'s `DEFAULT_AUTHORSHIP_CONFIG` and are almost certainly fine as-is for a
glance-only pilot repo):

```
GLANCE_GH_APP_BOT_LOGINS=copilot-swe-agent[bot]
GLANCE_GH_APP_BRANCH_PREFIXES=agent/,copilot/,codex/
GLANCE_GH_APP_TRAILER_KEYS=              # OFF by default — see the headline product question above
```

`GLANCE_GH_APP_TRAILER_KEYS` is empty by default (gauntlet round 1, both lineages): `Co-authored-by:`
is GitHub's own standard trailer for any multi-author human commit, so leaving it on by default
force-gated ordinary human collaboration PRs into the receipt-required path. Only set it if your repo's
own convention makes the trailer actually mean "an agent wrote this," e.g. a repo-specific practice of
tagging agent commits with a distinct trailer key.

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

Every invocation posts a check-run — never a skip (see the headline product question above). Which
outcome, by PR classification and receipt state:

| PR classification | Receipt state | Conclusion | Reason |
|---|---|---|---|
| not agent-authored | (irrelevant) | `success` (informational) | `human-not-required` |
| agent-authored | none supplied | `action_required` | `receipt-missing` |
| agent-authored | supplied, malformed (fails `LandReceiptSchema`) | `action_required` | `receipt-missing` (with a "malformed" note) |
| agent-authored | supplied, wrong repo/commit/gate-outcome/stale | `failure` | `receipt-rejected` (the summary says exactly which check failed) |
| agent-authored | supplied, verified against THIS PR's head | `success` | `receipt-verified` |

A receipt only reaches `success` after `verifyReceiptForPr` (`src/rail/wedge/receipt-verify.ts`) checks
ALL of: the receipt's `repo` matches this PR's repo, `receipt.commit` equals the PR's CURRENT head SHA
(fetched fresh from GitHub for this call, never trusted from the caller), the gate outcome is a proven
one (`landed === true`, `gate.status` is `"green"` or `"red-baseline"`, NOT `forcedWithoutProof`), and
the receipt is no older than the freshness window (Step 5). This is the gauntlet round-1 CRITICAL fix —
previously ANY truthy receipt object greened the check regardless of what it actually said.

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
- An ordinary human PR (no agent-authorship signal matched) shows `success` too — confirm its summary
  reads "Not required — human-authored PR" (`notRequiredOutput`), not the receipt-verified wording, so
  it's visibly distinguishable from a real landing-rail pass on the Checks tab even though both are
  green.
- Feed a receipt whose `commit` deliberately does NOT match the PR's head SHA (or one with
  `gate.status: "failed"`) through `--receipt` and confirm the check posts `failure`, not `success` —
  this is the gauntlet round-1 CRITICAL fix; a mismatched or unproven receipt must never green the
  check.

## Live-vs-test-proven status of this build

No `GLANCE_GH_APP_*` credentials were available in the build environment (checked; none present), and
registering a real App + installing it on an external repo + provisioning a Ruleset needs admin rights
this build could not obtain headlessly — exactly the reality constraint the ticket named. So: the
mechanism (JWT mint → installation-token exchange → PR fetch → authorship gate → receipt verification →
check-run create/update) is built and covered by **93 unit tests** against a mocked GitHub API
(`tests/rail-wedge-*.test.ts`), covering the auth flow, the receipt-verification policy (repo/SHA/gate-
outcome/freshness — every gauntlet round-1 CRITICAL scenario: mismatched commit, mismatched repo, a
failed-land receipt, a stale receipt, each asserted NON-success), the `LandReceiptSchema` decode
(well-formed and malformed shapes), all four check-run outcomes (verified/rejected/missing/
not-required), the idempotent find-existing-then-PATCH path, every authorship signal plus the default
opt-out of the trailer signal, and the trust-boundary escaping into the check-run's markdown output.
This document is what closes the gap between "the mechanism works" and "the mechanism is installed on a
real repo" — running it end to end against a real target repo is the next, not-yet-taken step.

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
5. **Conditional agent-only gating needs a real provenance signal, or the wedge gates everyone.** The
   headline open product question at the top of this document, restated here for the fog list: this
   build's answer for the pilot is "post an informational success for every non-agent PR" (option (a)
   in that section), not "invent a trustworthy way to tell agent PRs from human ones." If a future
   iteration wants the check to be MEANINGFUL for human PRs too (not just a pass-through), that needs a
   provenance mechanism glance doesn't have today — not a better allowlist. Explicitly not designed
   here; this is Lars's call.
