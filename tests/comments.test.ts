import { describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCommentEvent, commentsPath, listComments, nextCommentId } from "../src/comments.ts";

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "comments-"));
}

describe("comment store", () => {
  test("add → list returns both; resolve folds at read", async () => {
    const dir = await tmp();
    try {
      const a = nextCommentId();
      const b = nextCommentId();
      await appendCommentEvent(dir, { type: "add", id: a, repo: "/r", subject: "OMPSQ-1", body: "first", author: "lars", at: 1 });
      await appendCommentEvent(dir, { type: "add", id: b, repo: "/r", subject: "OMPSQ-1", body: "second", author: "lars", at: 2 });

      let all = await listComments(dir, { repo: "/r", subject: "OMPSQ-1" });
      expect(all.map((c) => c.body)).toEqual(["first", "second"]);

      await appendCommentEvent(dir, { type: "resolve", id: a, at: 3 });
      const open = await listComments(dir, { repo: "/r", subject: "OMPSQ-1", unresolved: true });
      expect(open.map((c) => c.body)).toEqual(["second"]);
      all = await listComments(dir, { repo: "/r", subject: "OMPSQ-1" });
      expect(all.find((c) => c.id === a)?.resolvedAt).toBe(3);
      expect(all.find((c) => c.id === b)?.resolvedAt).toBeUndefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by repo + subject", async () => {
    const dir = await tmp();
    try {
      await appendCommentEvent(dir, { type: "add", id: "x", repo: "/r", subject: "OMPSQ-1", body: "a", author: "u", at: 1 });
      await appendCommentEvent(dir, { type: "add", id: "y", repo: "/r", subject: "OMPSQ-2", body: "b", author: "u", at: 2 });
      await appendCommentEvent(dir, { type: "add", id: "z", repo: "/other", subject: "OMPSQ-1", body: "c", author: "u", at: 3 });
      const got = await listComments(dir, { repo: "/r", subject: "OMPSQ-1" });
      expect(got.map((c) => c.id)).toEqual(["x"]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("a torn trailing line is skipped, not thrown", async () => {
    const dir = await tmp();
    try {
      await appendCommentEvent(dir, { type: "add", id: "x", repo: "/r", subject: "s", body: "ok", author: "u", at: 1 });
      await fsp.appendFile(commentsPath(dir), '{"type":"add","id":"y","repo":"/r"'); // truncated
      const got = await listComments(dir, { repo: "/r", subject: "s" });
      expect(got.map((c) => c.id)).toEqual(["x"]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("missing log → []", async () => {
    const dir = await tmp();
    try {
      expect(await listComments(dir, { repo: "/r", subject: "s" })).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
