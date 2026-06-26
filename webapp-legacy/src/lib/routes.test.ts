import { describe, expect, test } from "bun:test";
import { CORE_VIEWS, consoleHandoffHash, fencedRouteContext, featureHash, parseHash, taskHash } from "./routes";

describe("hash routes", () => {
  test("parses feature workspace routes", () => {
    expect(parseHash(featureHash("feat/123"))).toEqual({
      view: "features",
      sel: "feat/123",
      taskId: null,
      handoffContext: null,
    });
  });

  test("parses project task workspace routes without folding task into repo", () => {
    expect(parseHash(taskHash("/repo/omp-squad", "task/7"))).toEqual({
      view: "project",
      sel: "/repo/omp-squad",
      taskId: "task/7",
      handoffContext: null,
    });
  });

  test("parses console handoff route context", () => {
    const context = fencedRouteContext({ route: "#/features/f1", kind: "feature", title: "Control Tower" });
    expect(parseHash(consoleHandoffHash(context))).toEqual({
      view: "console",
      sel: null,
      taskId: null,
      handoffContext: "```route-context\nroute: #/features/f1\nkind: feature\ntitle: Control Tower\n```",
    });
  });

  test("keeps visible navigation focused on core product surfaces", () => {
    expect([...CORE_VIEWS]).toEqual(["console", "agents", "features", "inbox", "audit"]);
  });
});
