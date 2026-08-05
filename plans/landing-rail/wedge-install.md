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
        "strict_required_status_checks_policy": false
      }
    }
  ]
}
```

Replace `123456` with the real numeric App ID from Step 1 (`GLANCE_GH_APP_ID`). `context` must exactly
match `DEFAULT_CHECK_NAME` (or whatever `--check-name` override the daemon posts with — the two must
agree or the Ruleset never sees a matching check).

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
GLANCE_GH_APP_TRAILER_KEYS=co-authored-by
```

See `.env.example`'s "GitHub-App wedge" section for the same, inline.

## Step 6 — Post a check-run (the one-command daemon invocation)

```
bun run scripts/post-wedge-check.ts --owner <o> --repo <r> --pr <n> [--receipt <path-to-LandReceipt.json>] [--details-url <url>]
```

- **With `--receipt`**: posts `success`, `output.text` carries the full T6 receipt (identical to the
  PR-comment renderer's markdown — `src/rail/receipt/render-comment.ts`).
- **Without `--receipt`**: posts `action_required` with an explanation of why the PR was gated (only
  if the PR is classified agent-authored at all — a human-authored PR is skipped, no check posted).
- The receipt JSON file is a serialized `LandReceipt` (`src/rail/receipt/types.ts`) — the daemon's own
  land path would call `postAgentPrCheck` (`src/rail/index.ts`) directly with the in-memory object
  instead of going through a file; the CLI's file form exists for this manual/spike invocation.

Re-running against the same PR (same head SHA) **updates** the existing check-run (`PATCH`) rather than
creating a duplicate — `findExistingCheckRun` in `src/rail/wedge/check-run.ts` looks up this App's own
prior check by name before deciding POST vs PATCH.

## Verification

- The PR's **Checks** tab shows `glance/landing-rail-receipt` with the posted conclusion.
- `output.summary` (the short verdict) shows in the merge-box "Show all checks" popover.
- `output.text` (the full receipt) is on the check-run's own detail page — click through from the
  Checks tab, not visible inline in the merge box.
- With the Ruleset from Step 4 active, a PR whose check is `action_required`/`failure` cannot merge
  through the UI's "Merge" button (rules-required-check enforcement) — an admin can still bypass via the
  Ruleset's bypass list if one is configured, by design (audit-trailed, not a wedge concern).

## Live-vs-test-proven status of this build

No `GLANCE_GH_APP_*` credentials were available in the build environment (checked; none present), and
registering a real App + installing it on an external repo + provisioning a Ruleset needs admin rights
this build could not obtain headlessly — exactly the reality constraint the ticket named. So: the
mechanism (JWT mint → installation-token exchange → PR fetch → authorship gate → check-run
create/update) is built and covered by **50 unit tests** against a mocked GitHub API (`tests/rail-wedge-*.test.ts`),
covering the auth flow, both check-run outcomes (receipt present/absent), the idempotent
find-existing-then-PATCH path, all three authorship signals plus the "no signal" honest-refusal case,
and the trust-boundary escaping into the check-run's markdown output. This document is what closes the
gap between "the mechanism works" and "the mechanism is installed on a real repo" — running it end to
end against a real target repo is the next, not-yet-taken step.

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
   new SHA. The real fix (per R1) is the `pull_request: synchronize` webhook fast-follow — mark the
   prior check `neutral`/`stale` the moment a new commit lands, so a stale-but-green required check
   never sits load-bearing. Not built; webhooks are entirely unused in this spike (Step 1 explicitly
   disables the webhook).
