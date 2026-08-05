# Self-land ledger — dogfood window (#339)

The evidence the 2-week destination gate reviews: one weekly row per drain, each stating how many of
glance's own PRs the rail landed WITH measured reviewer precision. Rows are appended by
`scripts/append-selfland-drain.ts` (reads `<stateDir>/land-receipts/index.jsonl`), which refuses to
fabricate an unmeasurable zero and never writes a verdict — the gate SUCCESS/KILL call is Lars's
alone.

A row is not the gate. Two continuous weeks of measured self-lands here is the *input* to the gate
review, held with Lars, whose verdict he records himself.

## Ledger
