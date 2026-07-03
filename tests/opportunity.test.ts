/**
 * Opportunity — the no-op tick must name WHY it did nothing. A tick that surfaces
 * no qualifying clusters is a heartbeat proving the loop is alive-but-idle, carrying
 * a structured skipReason so the automation digest can rank it against real work.
 */

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AutomationReport } from "../src/automation-log.ts";
import { Opportunity, type OpportunityDeps } from "../src/opportunity.ts";

const tmpDir = (): string => mkdtempSync(path.join(os.tmpdir(), "opportunity-"));

test("opportunity: a no-cluster tick emits an idle skip heartbeat with a reason", async () => {
	const events: AutomationReport[] = [];
	const deps: OpportunityDeps = {
		listIssues: async () => [],
		fileIssue: async () => null,
		scoutFacts: async () => [],
		hotAreas: async () => [],
		stateDir: tmpDir(),
		now: () => 1,
		record: (r) => events.push(r),
		log: () => {},
	};
	await new Opportunity(deps).tick();
	expect(events).toHaveLength(1);
	expect(events[0].found).toBe(0);
	expect(events[0].skipReason).toBe("idle");
	expect(events[0].detail).toBe("no qualifying opportunity clusters");
});
