# License & provenance — AGPL-3.0 + attribution for the lifted UI
STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/LICENSE, webapp/NOTICE, README.md

## Goal
Make the AGPL obligation explicit before any piyaz source lands. The user accepted AGPL for the
clone; `webapp/` must carry the AGPL-3.0 license text, a NOTICE crediting the upstream, and a clear
README statement so the obligation is discoverable and the copyleft boundary is documented.

## Approach
1. **`webapp/LICENSE`** — full GNU AGPL-3.0 text (verbatim from gnu.org / piyaz's `LICENSE`). This
   scopes the copyleft to the `webapp/` subtree; the rest of omp-squad (`src/`, etc.) is unaffected
   by this file alone — but note in README that serving the webapp triggers AGPL §13 source-offer.
2. **`webapp/NOTICE`** — attribution: the canvas force-graph engine (`src/components/graph/*`) and
   the design-token CSS are derived from **FrkAk/piyaz** (https://github.com/FrkAk/piyaz),
   AGPL-3.0-or-later, © its authors. List the specific lifted paths.
3. **SPDX headers** — each lifted file gets a top-of-file comment:
   `// SPDX-License-Identifier: AGPL-3.0-or-later` + `// Adapted from FrkAk/piyaz (AGPL-3.0).`
   (Applied by concerns 03/05 as they create the files; this concern establishes the required header
   string in NOTICE so later concerns copy it verbatim.)
4. **README** — under the existing "Web framework rewrite (in progress)" section (`plan.md` step 5),
   add a short subsection: the new `webapp/` graph UI adapts AGPL-3.0 code from FrkAk/piyaz;
   `webapp/` is therefore AGPL-3.0; running the dashboard with `OMP_SQUAD_WEBAPP=1` distributes it,
   so the corresponding source must be offered to users per AGPL §13.

ponytail: paperwork, not code — but it's the trust-boundary item (license compliance) that the
ponytail ladder explicitly never skips. Do it first so no engine file lands un-headered.

## Cross-Repo Side Effects
Sets the licensing precedent for the repo: `webapp/` is AGPL; `src/` keeps its current status.
If omp-squad later wants a non-AGPL webapp, it must take the "recreate clean" path instead.

## Verify
- `test -f webapp/LICENSE && head -1 webapp/LICENSE | grep -qi "GNU AFFERO"`.
- `grep -q "FrkAk/piyaz" webapp/NOTICE` and the NOTICE lists `src/components/graph/*`.
- README renders the AGPL/`OMP_SQUAD_WEBAPP=1` note.

## Resolution
Added webapp/LICENSE (AGPL-3.0), webapp/NOTICE (FrkAk/piyaz attribution + lifted paths), SPDX headers on lifted files, and the README AGPL note. Branch `omp-graph-ui`; gate green (root `bun run check` + `bun test` 492/0, webapp `bun run test` 8/0 + `bun run build`).
