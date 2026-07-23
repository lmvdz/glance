import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assemblePlanBrief } from "../src/plan-brief.ts";

describe("assemblePlanBrief", () => {
	test("projects a plan directory into a deterministic human brief", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-brief-"));
		const dir = path.join(repo, "plans", "human-comprehension");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "00-overview.md"), `# Human comprehension plan

## Outcome
Humans can see what this plan intends before the fleet executes it.

## Dependency graph
| Concern | BLOCKED_BY |
| --- | --- |
| 01 | none |
| 02 | 01 |

## Out of Scope
- LLM narrative rewriting
`);
		await fs.writeFile(path.join(dir, "DESIGN.md"), `# Design

## Decisions
- Deterministic projection ships before narrative prose.
`);
		await fs.writeFile(path.join(dir, "01-foundation.md"), `# Foundation
STATUS: done
PRIORITY: p1
COMPLEXITY: small
TOUCHES: src/foundation.ts

## Acceptance Criteria
- Data is parsed.
`);
		await fs.writeFile(path.join(dir, "02-ui.md"), `# UI
STATUS: open
COMPLEXITY: medium
TOUCHES: webapp/src/App.tsx

## Decisions
- Use existing web shell.
`);

		const brief = await assemblePlanBrief(repo, "human-comprehension");
		expect(brief?.planDir).toBe("plans/human-comprehension");
		expect(brief?.title).toBe("Human comprehension plan");
		expect(brief?.outcome).toBe("Humans can see what this plan intends before the fleet executes it.");
		expect(brief?.status).toMatchObject({ total: 2, done: 1, open: 1, blocked: 1 });
		expect(brief?.concerns.find((c) => c.file === "02-ui.md")?.blockedBy).toEqual(["01-foundation.md"]);
		expect(brief?.timeline.map((item) => item.phase)).toEqual([1, 2]);
		expect(brief?.outOfScope).toEqual(["LLM narrative rewriting"]);
		expect(brief?.decisions.map((d) => d.text)).toContain("Deterministic projection ships before narrative prose.");
		expect(brief?.touches).toEqual(["src/foundation.ts", "webapp/src/App.tsx"]);
	});

	test("rejects unsafe plan names", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-brief-"));
		expect(await assemblePlanBrief(repo, "../secrets")).toBeUndefined();
	});
});
