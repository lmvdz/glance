/**
 * nodePlacement — where a piece of work sits, and what it inherited from standing there.
 *
 * `02-surfaces.html` gives this four zones — **ABOVE THIS**, **BENEATH THIS**, **BESIDE IT · ITS
 * SIBLING**, and **INHERITED FROM {parent}** — and the reason is in the fourth. A unit is not just a
 * task with a parent pointer; it is a task that has been TOLD things by the work above it. The
 * reference quotes them: *"Half-open uses a single probe call, and refusals are per endpoint. Both of
 * those are the things this note has to explain."*
 *
 * Two refusals it builds in:
 *
 * 1. **A leaf says why it is a leaf.** Not an empty list under a heading — *"This is the bottom of the
 *    tree here. Work only splits when two people could do the halves at once."* An empty region under a
 *    heading was one of the four defects that only appeared when the room was actually booted.
 * 2. **Nothing inherited is invented.** When the work above wrote nothing down, this says so rather
 *    than paraphrasing the parent's title into a constraint that nobody agreed to.
 */

export interface PlacementNode {
  id: string;
  name?: string;
  parentId?: string;
  /** One line of what is true of it right now — never a state word on its own. */
  status?: string;
  goal?: string;
}

export interface Placement<T extends PlacementNode> {
  node: T;
  above?: T;
  beneath: T[];
  beside: T[];
  /** Root → node, inclusive. One entry means it is a root. */
  path: T[];
}

export function placement<T extends PlacementNode>(nodes: readonly T[], id: string): Placement<T> | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = byId.get(id);
  if (!node) return undefined;

  const above = node.parentId ? byId.get(node.parentId) : undefined;
  const beneath = nodes.filter((candidate) => candidate.parentId === id);
  const beside = node.parentId ? nodes.filter((candidate) => candidate.parentId === node.parentId && candidate.id !== id) : [];

  // Walk up with a seen-set: a parentId cycle in the data must not hang the room.
  const path: T[] = [];
  const seen = new Set<string>();
  let cursor: T | undefined = node;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  return { node, above, beneath, beside, path };
}

/** The breadcrumb, as names. The addresses live beside it — identity at a glance, address on demand. */
export function trail<T extends PlacementNode>(path: readonly T[]): string {
  return path.map((node) => node.name || node.id).join(' › ');
}

/**
 * What sits beneath, or why nothing does.
 *
 * The reference's own justification for a leaf, kept verbatim in spirit: work splits when two people
 * could do the halves at once, and not otherwise. A leaf is a decision, not an omission.
 */
export function beneathSentence(count: number): string {
  if (count > 0) return `${count} sub-unit${count === 1 ? '' : 's'}, each one addressable on its own.`;
  return 'This is the bottom of the tree here. Work only splits when two people could do the halves at once.';
}

/**
 * What this node was told by the work above it.
 *
 * Returns undefined when the parent recorded nothing — at which point the surface says so. Turning a
 * parent's title into a sentence beginning "inherited:" would put words in someone's mouth about what
 * their work constrains, which is the specific thing the room is built not to do.
 */
export function inherited<T extends PlacementNode>(above: T | undefined): string | undefined {
  const goal = above?.goal?.trim();
  return goal ? goal : undefined;
}

export function inheritedAbsence<T extends PlacementNode>(above: T | undefined): string {
  if (!above) return 'Nothing sits above this, so nothing was handed down to it. Whatever it is for was said here.';
  return `${above.name || above.id} has not written down what this inherits. What carries down is whatever was said in its conversation — nothing has been distilled into a constraint.`;
}

/** The sibling line. Named singular when there is one, because the reference's heading is singular. */
export function besideLabel(count: number): string {
  return count === 1 ? 'BESIDE IT · ITS SIBLING' : `BESIDE IT · ${count} SIBLINGS`;
}
