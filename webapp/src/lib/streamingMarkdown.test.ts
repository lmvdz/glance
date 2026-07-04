import { describe, expect, test } from "bun:test";
import { findSettledBoundary, splitSettled, trimStreamingArtifacts } from "./streamingMarkdown";

// ---------------------------------------------------------------------------
// findSettledBoundary / splitSettled
// ---------------------------------------------------------------------------

describe("findSettledBoundary", () => {
  test("returns 0 when nothing can settle yet", () => {
    expect(findSettledBoundary("")).toBe(0);
    expect(findSettledBoundary("hello")).toBe(0);
    expect(findSettledBoundary("hello\nworld")).toBe(0); // no blank line
    expect(findSettledBoundary("\n\nleading blanks")).toBe(0); // no content above
  });

  test("splits a paragraph boundary; settled keeps the blank line", () => {
    const { settled, tail } = splitSettled("para\n\nnext para");
    expect(settled).toBe("para\n\n");
    expect(tail).toBe("next para");
  });

  test("the last qualifying blank line wins", () => {
    const { settled, tail } = splitSettled("a\n\nb\n\nc");
    expect(settled).toBe("a\n\nb\n\n");
    expect(tail).toBe("c");
  });

  test("never picks a blank line inside an open fence", () => {
    // Blank between code1/code2 is in-fence; boundary stays before the opener.
    const { settled, tail } = splitSettled("intro\n\n```js\ncode1\n\ncode2");
    expect(settled).toBe("intro\n\n");
    expect(tail).toBe("```js\ncode1\n\ncode2");
    // Entry that is one giant fence: boundary never advances.
    expect(findSettledBoundary("```\na\n\nb\n\nc")).toBe(0);
  });

  test("advances past a completed fence", () => {
    const { settled, tail } = splitSettled("intro\n\n```\ncode\n```\n\nafter");
    expect(settled).toBe("intro\n\n```\ncode\n```\n\n");
    expect(tail).toBe("after");
  });

  test("tilde fences with info strings track open/close state too", () => {
    const { settled, tail } = splitSettled("x\n\n~~~python\na\n\nb\n~~~\n\nend");
    expect(settled).toBe("x\n\n~~~python\na\n\nb\n~~~\n\n");
    expect(tail).toBe("end");
  });

  test("regression: never splits between loose-list items", () => {
    expect(findSettledBoundary("- a\n\n- b")).toBe(0);
    expect(findSettledBoundary("1. a\n\n2. b")).toBe(0);
    expect(findSettledBoundary("- a\n  more\n\n- b")).toBe(0); // indented content = list context
  });

  test("regression: never splits before an indented continuation", () => {
    expect(findSettledBoundary("- a\n\n    still item a")).toBe(0); // 4-space continuation
    expect(findSettledBoundary("para\n\n    indented code")).toBe(0);
    expect(findSettledBoundary("para\n\n  two-space continuation")).toBe(0);
    expect(findSettledBoundary("para\n\n\ttab continuation")).toBe(0);
  });

  test("a list followed by a genuine paragraph splits", () => {
    const { settled, tail } = splitSettled("- a\n\npara");
    expect(settled).toBe("- a\n\n");
    expect(tail).toBe("para");
  });

  test("a paragraph followed by a brand-new list splits", () => {
    const { settled, tail } = splitSettled("para\n\n- a\n- b");
    expect(settled).toBe("para\n\n");
    expect(tail).toBe("- a\n- b");
  });

  test("column-0 rule: whitespace-only blank lines are not boundaries", () => {
    expect(findSettledBoundary("para\n  \nnext")).toBe(0);
  });

  test("a trailing blank with no tail content yet is not a boundary", () => {
    expect(findSettledBoundary("para\n\n")).toBe(0);
    expect(findSettledBoundary("para\n\nnext\n")).toBe(6); // completed "next" stays in the tail
  });
});

// Fixtures for the property-style invariant loop — a spread of everything the
// boundary logic sees: fences, loose lists, tables, torn syntax, blank runs.
const SPLIT_FIXTURES = [
  "",
  "hello",
  "para\n\nnext para",
  "a\n\nb\n\nc",
  "intro\n\n```js\ncode1\n\ncode2",
  "intro\n\n```\ncode\n```\n\nafter",
  "x\n\n~~~python\na\n\nb\n~~~\n\nend",
  "- a\n\n- b",
  "- a\n\npara",
  "para\n\n- a\n- b",
  "para\n\n    indented code",
  "para\n  \nnext",
  "para\n\n",
  "has **bold\n\nnext",
  "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter table",
  "text with [unclosed\n\nmore ~~torn",
  "\n\n\n",
];

describe("splitSettled invariants", () => {
  test("settled + tail === input, for every fixture", () => {
    for (const text of SPLIT_FIXTURES) {
      const { settled, tail } = splitSettled(text);
      expect(settled + tail).toBe(text);
      expect(settled.length).toBe(findSettledBoundary(text));
    }
  });

  test("operates on RAW input — the settled prefix is never trimmed", () => {
    // The prefix contains trimmable artifacts; splitSettled must preserve them
    // byte-for-byte (suppression is applied to the tail only, downstream).
    const raw = "has **bold\n\nnext";
    const { settled, tail } = splitSettled(raw);
    expect(settled).toBe("has **bold\n\n"); // unclosed ** intact
    expect(settled + tail).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// trimStreamingArtifacts
// ---------------------------------------------------------------------------

describe("trimStreamingArtifacts: inline rules", () => {
  test("trims a trailing unclosed [ link opener", () => {
    expect(trimStreamingArtifacts("see [exam")).toBe("see ");
    expect(trimStreamingArtifacts("see [a](htt")).toBe("see ");
    expect(trimStreamingArtifacts("[a [b")).toBe(""); // stacked openers all trim
  });

  test("trims a trailing unclosed ![ image opener including the bang", () => {
    expect(trimStreamingArtifacts("photo ![al")).toBe("photo ");
  });

  test("keeps completed links and bare [text] brackets", () => {
    expect(trimStreamingArtifacts("a [link](https://x) b")).toBe("a [link](https://x) b");
    expect(trimStreamingArtifacts("item [1] noted")).toBe("item [1] noted");
  });

  test("trims trailing unpaired backticks", () => {
    expect(trimStreamingArtifacts("run `")).toBe("run ");
    expect(trimStreamingArtifacts("see `code`")).toBe("see `code`"); // paired — kept
  });

  test("trims trailing unpaired stars", () => {
    expect(trimStreamingArtifacts("bold **")).toBe("bold ");
    expect(trimStreamingArtifacts("a *")).toBe("a ");
  });

  test("auto-closes mid-line unclosed bold/italic instead of hiding it", () => {
    expect(trimStreamingArtifacts("this is **bold")).toBe("this is **bold**");
    expect(trimStreamingArtifacts("an *em")).toBe("an *em*");
    expect(trimStreamingArtifacts("done **bold** ok")).toBe("done **bold** ok");
  });

  test("stars inside complete code spans are not emphasis markers", () => {
    expect(trimStreamingArtifacts("use `a*b` now")).toBe("use `a*b` now");
  });

  test("a leading `* ` bullet is not an emphasis opener", () => {
    expect(trimStreamingArtifacts("* item text")).toBe("* item text");
  });

  test("trims unpaired strikethrough markers", () => {
    expect(trimStreamingArtifacts("x ~~")).toBe("x ");
    expect(trimStreamingArtifacts("x ~")).toBe("x ");
    expect(trimStreamingArtifacts("a ~~strike")).toBe("a ");
    expect(trimStreamingArtifacts("kept ~~gone~~ ok")).toBe("kept ~~gone~~ ok");
  });

  test("only the final line is rewritten", () => {
    expect(trimStreamingArtifacts("**done**\nsee [x")).toBe("**done**\nsee ");
  });
});

describe("trimStreamingArtifacts: structural rules", () => {
  test("holds back a trailing bare bullet with no content", () => {
    expect(trimStreamingArtifacts("list:\n- ")).toBe("list:");
    expect(trimStreamingArtifacts("list:\n* ")).toBe("list:");
    expect(trimStreamingArtifacts("steps:\n1. ")).toBe("steps:");
    expect(trimStreamingArtifacts("- item")).toBe("- item"); // content present — kept
  });

  test("holds back a lone table-header line until its separator arrives", () => {
    expect(trimStreamingArtifacts("| a | b |")).toBe("");
    expect(trimStreamingArtifacts("para\n\n| a | b")).toBe("para");
    expect(trimStreamingArtifacts("| a | b |\n| --- | --- |")).toBe("| a | b |\n| --- | --- |");
  });

  test("holds back an orphan separator row", () => {
    expect(trimStreamingArtifacts("|---|")).toBe("");
    expect(trimStreamingArtifacts("text\n\n|---|---|")).toBe("text");
  });

  test("once a table is established, new rows pass through immediately", () => {
    const table = "| h |\n| --- |\n| r1 |\n| r2 |";
    expect(trimStreamingArtifacts(table)).toBe(table);
    const partialRow = "| h |\n| --- |\n| r";
    expect(trimStreamingArtifacts(partialRow)).toBe(partialRow);
  });

  test("never rewrites code: a tail ending inside an open fence is untouched", () => {
    expect(trimStreamingArtifacts("```\nconst a = b * c")).toBe("```\nconst a = b * c");
    expect(trimStreamingArtifacts("```\n- ")).toBe("```\n- ");
    expect(trimStreamingArtifacts("```\n| not | a | table")).toBe("```\n| not | a | table");
  });
});

const WELL_FORMED = [
  "plain paragraph.",
  "# Title\n\nA paragraph with **bold**, *em*, `code`, ~~strike~~ and a [link](https://x).\n",
  "- item one\n- item two",
  "```ts\nconst x = 1;\n```",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "intro\n\n```\nfenced\n```\n\noutro line.\n",
];

const TORN = [
  "see [exam",
  "see [a](htt",
  "photo ![al",
  "run `",
  "bold **",
  "a *",
  "this is **bold",
  "an *em",
  "a *b **c",
  "x ~~",
  "x ~",
  "a ~~strike",
  "list:\n- ",
  "steps:\n1. ",
  "| a | b |",
  "para\n\n| a | b",
  "|---|",
  "```\nconst a = b * c",
  "**done**\nsee [x",
  "",
];

describe("trimStreamingArtifacts invariants", () => {
  test("idempotency: trim(trim(x)) === trim(x)", () => {
    for (const text of [...WELL_FORMED, ...TORN, ...SPLIT_FIXTURES]) {
      const once = trimStreamingArtifacts(text);
      expect(trimStreamingArtifacts(once)).toBe(once);
    }
  });

  test("completed-syntax pass-through: well-formed markdown is the identity", () => {
    for (const text of WELL_FORMED) {
      expect(trimStreamingArtifacts(text)).toBe(text);
    }
  });
});
