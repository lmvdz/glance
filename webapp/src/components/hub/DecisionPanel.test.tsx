import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionPanel, type DecisionRequest } from "./DecisionPanel";

const request: DecisionRequest = {
  id: "gate_1",
  agentName: "Wren",
  address: "3.2 retry-budget",
  stoppedAgoMs: 14 * 60_000,
  question: "Should the retry budget be counted per customer, or per endpoint?",
  context: "Both are about the same amount of work. They behave very differently in a spike, which is why I stopped rather than pick.",
  findings: ["The spike on Tuesday came from one customer, not many endpoints.", "Per-endpoint is what the dashboard already assumes."],
  options: [
    { label: "Per endpoint", consequence: "Wren resumes in about twenty seconds and finishes 3.2 today. 3.2.1 starts behind her.", preferred: true },
    { label: "Per customer", consequence: "Wren rewrites the counter and 3.2 lands tomorrow instead." },
  ],
  index: 1,
  total: 3,
};

const render = (over: Partial<DecisionRequest> = {}) =>
  renderToStaticMarkup(<DecisionPanel request={{ ...request, ...over }} onAnswer={() => {}} onClose={() => {}} />);

test("the question is legible before any evidence is", () => {
  const html = render();
  const question = html.indexOf("Should the retry budget");
  const findings = html.indexOf("The spike on Tuesday");
  expect(question).toBeGreaterThan(-1);
  // A person reads the question first; evidence comes second, in the reference's own words.
  expect(question).toBeLessThan(findings);
});

test("answering in words is the primary affordance, not the fallback", () => {
  const html = render();
  const words = html.indexOf("ANSWER IN WORDS");
  const firstOption = html.indexOf("Per endpoint");
  // Words come BEFORE the buttons. Most real answers are "per endpoint is right, but make the window
  // configurable", which no button can express and a form-shaped screen quietly discourages.
  expect(words).toBeLessThan(firstOption);
  // And the box is the one thing bordered in the action colour.
  expect(html).toContain("1px solid #F0A35A");
});

test("every option carries what will happen if it is taken", () => {
  const html = render();
  expect(html).toContain("Wren resumes in about twenty seconds");
  expect(html).toContain("Wren rewrites the counter and 3.2 lands tomorrow");
});

test("a recommendation is visible but never pre-selected", () => {
  const html = render();
  expect(html).toContain("she prefers this");
  // Nothing is checked or defaulted — a recommendation you can see is advice; one already chosen for
  // you is a decision somebody else made.
  expect(html).not.toContain("checked");
  expect(html).not.toContain("aria-selected=\"true\"");
});

test("it says what leaving costs, before you leave", () => {
  expect(render()).toContain("esc closes · nothing is lost");
});

test("it states which of several this is, rather than pretending it arrived alone", () => {
  expect(render()).toContain("ANSWERING · 1 OF 3");
  // A single question does not get a counter that implies a queue.
  expect(render({ total: 1, index: 1 })).toContain("ANSWERING");
  expect(render({ total: 1, index: 1 })).not.toContain("1 OF 1");
});

test("what the agent already worked out is named with the agent, not generically", () => {
  expect(render()).toContain("WHAT WREN ALREADY WORKED OUT");
});

test("a question with no options is still answerable", () => {
  // Open questions are the common case: an agent that stopped because it could not choose often has
  // nothing to offer as a list.
  const html = render({ options: [], findings: [] });
  expect(html).toContain("ANSWER IN WORDS");
  expect(html).toContain("Should the retry budget");
});

test('a decision about a plan admits when the plan did not come with it', () => {
  // Found by using the product: an "Approve plan" gate arrived carrying only a title and two
  // buttons. Answering it meant answering blind, and nothing on screen said so.
  const html = renderToStaticMarkup(
    <DecisionPanel
      request={{ id: 'g', agentName: 'ompsq-480', address: 'ompsq-480', question: 'Approve plan', options: [{ label: 'Approve' }, { label: 'Revise' }], unitHref: '#/channel/node%3Aompsq-480' }}
      onAnswer={() => {}}
    />,
  );
  expect(html).toContain('THE PLAN ITSELF DID NOT COME WITH THE QUESTION');
  expect(html).toContain('answering blind');
  expect(html).toContain('open the unit');
});

test('a decision that is not about a document does not apologise for having none', () => {
  const html = renderToStaticMarkup(
    <DecisionPanel
      request={{ id: 'g', agentName: 'wren', address: 'wren', question: 'Allow tool: bash', options: [{ label: 'Allow' }] }}
      onAnswer={() => {}}
    />,
  );
  expect(html).not.toContain('DID NOT COME WITH THE QUESTION');
});
