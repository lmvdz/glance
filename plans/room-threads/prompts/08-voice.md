# Design prompt — round 08: the voice surface

Hand this to a designer with no prior context. It describes a situation and names the hard questions;
it does not describe a layout. Deliberately no existing design of this product is shown.

---

## THE SITUATION

A person talks out loud to a system that reads, writes and runs code in real repositories on their own
machine.

A realtime voice model handles the conversation and answers immediately. It does not do the work. It
hands each request to a separate coding agent, which opens files, runs searches and commands, and can
spawn further agents of its own. When that work finishes, the voice model speaks the result as its own.

Two clocks, and the gap between them is the whole problem. Conversation moves at human speed — under a
second, or it feels broken. The work takes tens of seconds to several minutes, and happens somewhere the
person cannot see.

And for most of that time the person is not looking at the screen. They are talking. Their hands are
away from the keyboard. They are looking at something else, or at nothing. This is the premise, not an
edge case: **you are designing a screen for someone who is not looking at it.** What that means for what
belongs on it — and what belongs in sound instead, or nowhere — is the central question of this brief.

## THE MATERIALS

Everything here is live, arrives as it changes, and is available to you. **Anything not listed does not
exist and cannot be obtained.** Where a fact is missing from this list, it is missing from the product;
inventing a source for it is the one thing that will make the design wrong rather than merely different.

**Session state**

- Phase, exactly one of: connecting, listening, working, speaking, muted, error.
- Muted: whether the microphone is currently off.
- Microphone level: a continuous number from 0 to 1, updating about sixteen times a second.
- Speaker level: the same, for the system's own voice.
- Attachment: whether this view is connected to a running session at all, plus a distinct "the session
  ended" event that may carry an error message.
- Session identity: a new id each time a session starts.

**The spoken conversation**

- Turns, each with a speaker (the person or the system), text, and a flag for whether the turn is
  finished. Unfinished turns grow as the words arrive.
- The person can also type instead of speaking. Typed and spoken turns are the same conversation.
- The last 24 turns are retained. Older ones are gone.

**The delegated work**

- Tool calls. Each has the tool's name (read, write, bash, grep, …), a subject — a file path, a search
  pattern, or a command line — a start time, and once it finishes, whether it ended in error and which
  agent ran it. A call in progress is distinguishable from a finished one. The last 64 are retained.
- An agent roster. Each agent has a display name, a kind (the main agent, a subagent, or an advisor), a
  status (running, idle, parked, aborted), its parent agent, and a short free-text gist of what it is
  doing right now. Agents appear and disappear as work fans out and completes.
- The agent's own plan: a list of phases, each phase a list of tasks. Each task has text, a status (not
  started, in progress, done, abandoned, blocked) and, when blocked, free text naming what it is waiting
  on. The plan is rewritten repeatedly during a run, and only the current version is available — there
  is no history of what it used to say.
- Each delegated agent's own conversation: its messages in Markdown (headings, lists, tables, fenced
  code), streaming as they are written, with its tool calls attached. This is a full conversation per
  agent, not a summary.

**What the person can do**

- Start a session, end it, mute or unmute the microphone.
- Speak, or type.
- Send typed text into the delegated work to redirect it mid-run. This capability can be switched off,
  and when it is off the interface is told so explicitly rather than discovering it by trying.

## WHAT THE DATA DOES AND DOES NOT MEAN

These are properties of the material, not preferences. Most of them are cases where the obvious reading
of a value is wrong, and every one of them is a place a design can accidentally lie.

- **A tool call is an action, not a result.** "The tool finished" means it ran. It does not mean it
  succeeded at the person's actual goal. Tool output and full arguments never cross into this interface
  at all — you cannot show them, because they are not there.
- **An agent's status is not its correctness.** "Running" says it is alive. Nothing more.
- **The plan is written by the agent about itself.** A task marked done is the agent's claim, not a
  verified fact.
- **The gist is free text the agent wrote about itself**, in whatever register it chose.
- **Progress arrives irregularly** — several events a second, then nothing for a minute. Silence does
  not mean stalled, and there is no way to tell the difference from the data alone.
- **History runs out.** Sessions routinely last long enough to pass 24 turns and 64 tool calls. What
  falls off the end is gone, and the interface knows it fell off.

There are exactly three things this system can honestly say about any claim: it was **checked**, it is
**on an agent's word**, or it **cannot be verified right now**. There is no fourth. Most of what is on
this list is the second kind, and a design that renders agent claims and checked facts in the same
voice has converted the second into the first for free.

## THE LAWS THIS PRODUCT ALREADY LIVES BY

These are carried forward from the rest of the product and are not open for redesign. They constrain
honesty and register, never form — every decision about layout, hierarchy, motion and medium remains
entirely yours.

- **The copy is the design.** Every string states a fact *and* what it means. Not "blocked" but "waiting
  on a migration that hasn't been written yet — nothing else in the run depends on it." A string that
  only names a state is unfinished. In a spoken product this stops being a guideline and becomes the
  entire interface: **the sentence the system says out loud is the design.** Treat spoken copy as a
  first-class deliverable, written to the same standard as anything visible.
- **Every control says what it will do before it is used.** Ending a session, muting, redirecting work
  mid-run — each carries a sentence naming the consequence.
- **Every interruption states its blast radius** — what is *not* affected. Answer the anxious question
  before it is asked.
- **Raw identifiers are footnotes.** Session ids, file paths, agent ids: the human sentence carries the
  meaning, the raw value sits where it can be found and nowhere else.
- **Say it out loud and you both mean the same thing.** Elsewhere in this product, work is numbered so
  that "three point two" identifies one unit unambiguously in speech. Here that stops being a
  convenience: this is a voice interface, and the person will want to say *stop the one searching the
  tests* or *what is Wren doing*. Whatever the person can see, they must be able to name aloud. How
  agents, tasks, sessions and tool calls become sayable is a design problem, and it is yours.
- **Silence is the goal, not an empty state.** Elsewhere in this product, work waiting on a human is
  treated as a defect rather than a task list, and zero is an achievement. The same instinct applies
  here: a system that speaks constantly to prove it is working is worse than one that is quiet and
  trusted. Interrupting a person who is mid-thought is a cost.

## THE HARD QUESTIONS

We do not have answers to these. They are the reason this brief exists, and a design that picks a
position and commits is worth more than one that hedges.

**1. What is the screen actually for?**

The person is not looking at it. So it is one of at least three different products, and they do not
combine:

- an ambient state you catch in peripheral vision without turning your head,
- a record you read *afterwards*, to reconstruct what happened,
- or something you turn to only when something has gone wrong, dark and inert the rest of the time.

Each implies a different density, a different hierarchy, and a different answer to what belongs on it at
all. Choose one and say why.

**2. What does the interface do with a fact it does not have?**

Silence in the data is genuinely ambiguous: a thinking agent and a dead session look identical. The
system cannot distinguish them, so the interface cannot either. Showing a spinner claims liveness it
cannot back. Showing nothing reads as finished. Showing elapsed time is honest but potentially useless.
There is a real trade here and we do not have a preference — but the one unacceptable answer is a design
that resolves the ambiguity in its own favour.

**3. What is the relationship between what is spoken and what is shown?**

They can carry the same content, complementary content, or the screen can carry what speech is bad at —
structure, code, long lists — while speech carries what screens are bad at — arriving without being
looked at. If some of this material belongs to sound rather than sight, say so explicitly. If some of it
should not be present at all, that is a legitimate and welcome answer.

**4. More than one session can run at once.**

The person is speaking. Which session are they speaking to? This is unresolved in the product and it is
as much an interaction question as a visual one.

## MUST BE TRUE

Falsifiable. A design either satisfies these or it does not.

- A person who has not looked at the screen for four minutes can tell, within about a second of
  glancing, whether they need to do anything.
- Nothing renders an agent's claim about itself in the same voice as a checked fact.
- The interface never implies liveness it cannot demonstrate, and never implies completion from the
  absence of events.
- When retained history runs out, the interface says so. A truncated record must not read as a complete
  one.
- Muting is unmistakable while it is in effect — a person mid-sentence discovering they were muted the
  whole time is the sharpest failure this product has.
- Redirecting work mid-run states what happens to the work already done before it is sent.
- Ending a session states what will be lost.
- When redirection is switched off, that is visible as a fact about the system, never as a control that
  silently does nothing.
- A reload mid-run returns the person to something coherent, not to an empty screen that implies nothing
  happened.
- Everything nameable on screen can be said out loud unambiguously.

## DELIVERABLES

States, not screens — the failure and empty states matter more than the healthy one, because the healthy
one is the state nobody is looking at.

1. **Listening.** Nothing has been asked yet. This is what the person sees most of the time.
2. **Work in flight**, with several agents running, a plan half-complete, and tool calls arriving.
3. **The ambiguous silence.** Ninety seconds since the last event. The design's answer to hard question 2.
4. **Speaking.** The system is delivering a result out loud. What does the screen do while it talks?
5. **Something failed** — a tool errored, or an agent aborted — while the rest of the run continues.
6. **The session died** without saying so, and the interface has worked out that events stopped.
7. **Arriving mid-run.** A viewer attaches to work already in progress and receives a snapshot of what
   has happened so far, with no history before that point.
8. **Muted**, mid-conversation.
9. **Redirecting**, with redirection available; and the same moment with it switched off.
10. **Inside one agent's own conversation** — the full Markdown stream with its tool calls, which is the
    densest thing in the product and the least suited to being glanced at.

For anything you decide belongs in sound, describe what is said and when, in the exact words. Spoken
copy is a deliverable here, not a note attached to one.

## PRACTICAL FACTS

- This runs in a web browser, on the person's own machine.
- The microphone requires a deliberate user action before it can be switched on.
- There is one person. Nothing here is multi-user.
- The connection can drop while a session keeps running, and reattach later.
- The person may reload the page at any moment.
- The register elsewhere in this product is quiet and instrument-like — near-black surfaces, one warm
  accent used sparingly, status carried by small marks rather than large ones, monospace reserved for
  identifiers. It lives beside other work all day and must never compete for attention it has not
  earned. That is a fact about where this surface lives, not a style you must adopt; depart from it
  deliberately if the voice-first premise demands something else, and say why.
