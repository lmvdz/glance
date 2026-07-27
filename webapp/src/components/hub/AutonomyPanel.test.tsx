import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutonomyPanel, type AutonomyState } from "./AutonomyPanel";

const boundary = [
  { class: "credentials", because: "A credential you did not hand over is not one you agreed to spend." },
  { class: "spend", because: "Money leaves and does not come back." },
];

const state: AutonomyState = {
  rules: [{
    id: "r1",
    sentence: "If it can be undone in under a minute, just do it and tell me afterwards.",
    authorId: "db:lars",
    since: Date.now() - 5 * 86_400_000,
    settles: ["reversible-change"],
    invocations: 12,
    wouldNotHaveCaught: ["the credential rotation on the 14th"],
  }],
  neverAlone: boundary,
  proposals: [],
};

const render = (over: Partial<AutonomyState> = {}) => renderToStaticMarkup(<AutonomyPanel state={{ ...state, ...over }} />);

test("a rule is QUOTED, with who wrote it and when", () => {
  const html = render();
  // Paraphrasing someone's sentence into a toggle label is how it stops being theirs.
  expect(html).toContain("If it can be undone in under a minute, just do it and tell me afterwards.");
  expect(html).toContain("db:lars");
  expect(html).toContain("used 12×");
});

test("a rule states what it does NOT cover", () => {
  expect(render()).toContain("does not cover: the credential rotation on the 14th");
});

test("a rule that has never fired says so rather than showing a bare zero", () => {
  const html = render({ rules: [{ ...state.rules[0]!, invocations: 0 }] });
  expect(html).toContain("not used yet");
  expect(html).not.toContain("used 0");
});

test("no rules is a sentence about why, not an empty list", () => {
  const html = render({ rules: [] });
  expect(html).toContain("it has not been told otherwise");
  expect(html).toContain("there is no settings page behind this");
  expect(html).not.toContain("0 rules");
});

test("the boundary is shown as reasons, not as disabled switches", () => {
  const html = render();
  expect(html).toContain("THE ONES IT WILL NOT DO ALONE");
  expect(html).toContain("A credential you did not hand over");
  // A disabled switch invites you to look for the enable; a reason invites you to disagree.
  expect(html).not.toContain("disabled");
  expect(html).toContain("No rule widens this");
  expect(html).toContain("refused when it is written, not when it is used");
});

test("a proposal shows its evidence AND what it would still not have caught", () => {
  const html = render({
    proposals: [{
      action: "take the reversible option?",
      sentence: "4 times you were asked … Should the fleet stop asking?",
      evidence: [
        { id: "d1", question: "Take the reversible option?", chose: "yes" },
        { id: "d2", question: "Take the reversible option?", chose: "yes" },
      ],
      wouldNotHaveCaught: [{ id: "c1", question: "Rotate the production credential?" }],
    }],
  });
  expect(html).toContain("THE 2 THAT WOULD NOT HAVE REACHED YOU");
  // Its own block, in the alarm tone: a rule that oversells its reach is worse than no rule.
  expect(html).toContain("AND THE ONE THAT WOULD STILL HAVE REACHED YOU");
  expect(html).toContain("Rotate the production credential?");
  expect(html).toContain("we are not proposing one");
});

test("accepting is offered with its consequence, and narrowing in words is offered beside it", () => {
  const html = renderToStaticMarkup(
    <AutonomyPanel
      state={{ ...state, proposals: [{ action: "a", sentence: "s", evidence: [{ id: "d", question: "q", chose: "yes" }], wouldNotHaveCaught: [] }] }}
      onAccept={() => {}}
    />,
  );
  expect(html).toContain("Stop asking me this");
  expect(html).toContain("1 fewer stops and nothing you would have decided differently");
  expect(html).toContain("only inside a plan, never on main");
  expect(html).toContain("stored as your sentence and quoted wherever it takes effect");
});

test("the panel can be closed from inside it", () => {
  // It takes the standing rail's place, so the rail's own close control goes with it. A surface you
  // can open and not shut is a trap.
  const html = renderToStaticMarkup(<AutonomyPanel state={state} onClose={() => {}} />);
  expect(html).toContain("esc closes");
});
