export const meta = {
  name: 'wave1-trust-execute',
  description: 'Execute the 8 wave1-trust concerns in 4 sequential batches with a review gate per batch',
  phases: [
    { title: 'Batch 1', detail: 'done-proof-ledger, gate-class-guard, regression-gate-default' },
    { title: 'Review 1' },
    { title: 'Batch 2', detail: 'done-write-gating, land-mode-probe' },
    { title: 'Review 2' },
    { title: 'Batch 3', detail: 'pr-land-path' },
    { title: 'Review 3' },
    { title: 'Batch 4', detail: 'pr-reconciler-backstop, webapp-pr-surface' },
    { title: 'Review 4' },
  ],
}

const REPO = '/home/lars/sui/omp-squad/.claude/worktrees/research-direct-vs-glance'
const BASELINE = 'e44cc35'

const IMPL_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'files', 'tests', 'commit'],
  properties: {
    status: { type: 'string', enum: ['done', 'already-done', 'blocked', 'partial'] },
    summary: { type: 'string', description: '3-6 sentences: what was built, key decisions, anything that drifted from the concern file' },
    files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string', description: 'test commands run and their results' },
    commit: { type: 'string', description: 'commit sha (short) of the commit made, or empty if none' },
    notes: { type: 'string', description: 'anomalies, out-of-TOUCHES edits with justification, follow-ups' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['pass', 'issues', 'summary'],
  properties: {
    pass: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'description'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'significant', 'minor'] },
          file: { type: 'string' },
          description: { type: 'string' },
          fixHint: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    testsGreen: { type: 'boolean' },
  },
}

function implPrompt(file, name, prior) {
  return `You are implementing ONE concern of the plan wave1-trust in the repo checkout at ${REPO} (a git worktree on branch worktree-research-direct-vs-glance). Edit IN PLACE in that directory. Do NOT create worktrees, switch branches, or push.

READ FIRST, fully: ${REPO}/plans/wave1-trust/DESIGN.md (the authoritative, adversarially-ruled design), then your concern file ${REPO}/plans/wave1-trust/${file}. Implement exactly that concern — its Goal, Approach, and Verify sections.

PRIOR CHANGES already landed in this plan (later concerns build on them):
${prior.length ? prior.map(p => '- ' + p).join('\n') : '- none (first concern)'}

RULES:
- Read the relevant source regions before editing. The concern's file:line anchors were verified recently but code moves — trust the code you read over the anchor.
- If you modify a shared type/interface, update ALL downstream consumers including tests (and webapp/src/lib/dto.ts mirror where the concern says so).
- Match the surrounding code's style, naming, and comment density. Comments only for constraints the code cannot show.
- Stay inside the concern's TOUCHES list; if a type change forces an edit elsewhere, do it and report it in notes.
- Do NOT touch AgentStatus/pending write-path semantics in squad-manager.ts (the sibling lifecycle-truth plan owns those).
- Write the tests the concern's Verify section names. Run targeted tests with: export PATH="$PWD/node_modules/.bin:$PATH" && bun test <pattern>. The full suite was green (948 pass / 0 fail) at baseline commit ${BASELINE}.
- If the repo has a typecheck script in package.json run it; otherwise skip.
- IMPORTANT: if you discover the task is already done, partially done, or blocked differently than expected, REPORT (status already-done/blocked with notes) instead of forcing.
- When done: git add ONLY the files you changed, then commit with message: "feat(wave1): ${name} — <one-line summary>" followed by a blank line and the trailer line exactly: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
- Do not push. Do not amend other commits.

Your final message is consumed by a script: return the structured output only.`
}

function reviewPrompt(n, batch, results) {
  const commits = results.filter(Boolean).map(r => r.commit).filter(Boolean).join(', ')
  return `You are the batch reviewer for batch ${n} of plan wave1-trust in ${REPO} (git worktree, branch worktree-research-direct-vs-glance). Baseline commit before the plan: ${BASELINE} (full suite green: 948 pass / 0 fail).

This batch implemented concerns: ${batch.map(b => b.file).join(', ')} in commits: ${commits || 'unknown — inspect git log'}.

Implementer reports:
${results.filter(Boolean).map((r, i) => `--- ${batch[i].name} (${r.status}) commit ${r.commit}\n${r.summary}\nfiles: ${(r.files || []).join(', ')}\ntests: ${r.tests}\nnotes: ${r.notes || '-'}`).join('\n')}

DO:
1. Read each concern file (${REPO}/plans/wave1-trust/) and ${REPO}/plans/wave1-trust/DESIGN.md for what SHOULD have been built.
2. Inspect the actual diffs: git show <commit> for each commit above (run git log --oneline ${BASELINE}..HEAD to orient).
3. Judge: correctness bugs, incomplete wiring (created but not connected/not cleaned up in shutdown), type drift (consumers/tests/webapp dto mirror not updated), silent scope creep, violations of the design's rulings (e.g. AgentStatus write-path touched, skip-dispatch proof-gated when it must stay proofless, gate enforced in only one of the two auto-answer engines), and tests that don't actually assert the new behavior.
4. Run the full suite: export PATH="$PWD/node_modules/.bin:$PATH" && bun test 2>&1 | tail -5. Report testsGreen accordingly (pre-existing failures: there were none at baseline).
Severity: critical = must fix before next batch; significant = should fix now; minor = note only. pass=false if any critical or significant issues, or tests not green.
Return the structured output only.`
}

function fixPrompt(n, review, batch) {
  return `You are the fixer for batch ${n} of plan wave1-trust in ${REPO} (git worktree, branch worktree-research-direct-vs-glance). Edit in place; do not push.

A reviewer found these issues in the batch that implemented ${batch.map(b => b.file).join(', ')} (concern files in ${REPO}/plans/wave1-trust/, design in DESIGN.md):

${JSON.stringify(review.issues, null, 2)}

Reviewer summary: ${review.summary}

Fix every critical and significant issue (minors too if trivial). Read the code first; keep fixes targeted. Re-run: export PATH="$PWD/node_modules/.bin:$PATH" && bun test 2>&1 | tail -5 and make the suite green. Commit as "fix(wave1): batch ${n} review fixes" with trailer line: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Return the structured output only.`
}

const BATCHES = [
  { n: 1, phase: 'Batch 1', review: 'Review 1', concerns: [
    { file: '01-done-proof-ledger.md', name: 'done-proof-ledger' },
    { file: '02-gate-class-guard.md', name: 'gate-class-guard' },
    { file: '03-regression-gate-default.md', name: 'regression-gate-default', effort: 'low' },
  ]},
  { n: 2, phase: 'Batch 2', review: 'Review 2', concerns: [
    { file: '04-done-write-gating.md', name: 'done-write-gating' },
    { file: '05-land-mode-probe.md', name: 'land-mode-probe' },
  ]},
  { n: 3, phase: 'Batch 3', review: 'Review 3', concerns: [
    { file: '06-pr-land-path.md', name: 'pr-land-path' },
  ]},
  { n: 4, phase: 'Batch 4', review: 'Review 4', concerns: [
    { file: '07-pr-reconciler-backstop.md', name: 'pr-reconciler-backstop' },
    { file: '08-webapp-pr-surface.md', name: 'webapp-pr-surface', effort: 'low' },
  ]},
]

const prior = []
const report = { batches: [], blocked: [] }

for (const b of BATCHES) {
  phase(b.phase)
  const results = []
  for (const c of b.concerns) {
    log(`implementing ${c.name}`)
    const r = await agent(implPrompt(c.file, c.name, prior), {
      label: `impl:${c.name}`, phase: b.phase, schema: IMPL_SCHEMA,
      model: 'sonnet', ...(c.effort ? { effort: c.effort } : {}),
    })
    results.push(r)
    if (r) {
      prior.push(`${c.name} [${r.status}] commit ${r.commit}: ${r.summary} (files: ${(r.files || []).join(', ')})`)
      if (r.status === 'blocked') { report.blocked.push({ concern: c.name, notes: r.notes }); log(`BLOCKED: ${c.name} — ${r.notes}`) }
    } else {
      report.blocked.push({ concern: c.name, notes: 'agent died/skipped' }); log(`AGENT LOST: ${c.name}`)
    }
  }

  phase(b.review)
  const review = await agent(reviewPrompt(b.n, b.concerns, results), {
    label: `review:batch${b.n}`, phase: b.review, schema: REVIEW_SCHEMA,
  })
  let fix = null
  if (review && !review.pass) {
    log(`batch ${b.n} review FAILED (${review.issues.length} issues) — fixing`)
    fix = await agent(fixPrompt(b.n, review, b.concerns), {
      label: `fix:batch${b.n}`, phase: b.review, schema: IMPL_SCHEMA, model: 'sonnet',
    })
    if (fix) prior.push(`batch${b.n}-review-fixes [${fix.status}] commit ${fix.commit}: ${fix.summary}`)
  }
  report.batches.push({ batch: b.n, results, review, fix })
  const sev = review ? review.issues.filter(i => i.severity !== 'minor').length : 'n/a'
  log(`batch ${b.n} done — review pass=${review ? review.pass : 'lost'}, non-minor issues=${sev}${fix ? ', fixes applied' : ''}`)
}

return report