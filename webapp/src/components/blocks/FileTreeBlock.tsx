import React from 'react';
import { FileText, Folder } from 'lucide-react';
import type { CSSProperties } from 'react';
import { PlanBlockContext, type BlockProps } from '../PlanBlocks';

type ChangeKind = 'added' | 'modified' | 'removed' | 'renamed';

interface FileChange {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  change?: FileChange;
}

const KIND_LABELS: Record<ChangeKind, string> = {
  added: 'add',
  modified: 'modify',
  removed: 'remove',
  renamed: 'rename',
};

const KIND_STYLES: Record<ChangeKind, CSSProperties> = {
  added: { borderColor: 'color-mix(in srgb, var(--wf-success) 38%, transparent)', color: 'var(--wf-success)', backgroundColor: 'color-mix(in srgb, var(--wf-success) 12%, transparent)' },
  modified: { borderColor: 'color-mix(in srgb, var(--wf-accent) 34%, transparent)', color: 'var(--wf-accent)', backgroundColor: 'var(--wf-accent-soft)' },
  removed: { borderColor: 'color-mix(in srgb, var(--wf-danger) 36%, transparent)', color: 'var(--wf-danger)', backgroundColor: 'color-mix(in srgb, var(--wf-danger) 11%, transparent)' },
  renamed: { borderColor: 'var(--wf-border-strong)', color: 'var(--wf-text-muted)', backgroundColor: 'var(--wf-paper-muted)' },
};

function cleanPath(path: string): string {
  return path.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function parseKind(token: string): ChangeKind | undefined {
  const normalized = token.trim().toLowerCase();
  if (['+', '+added', 'add', 'added', 'new', 'create', 'created', 'a'].includes(normalized)) return 'added';
  if (['~', '~modified', 'modify', 'modified', 'change', 'changed', 'edit', 'edited', 'm'].includes(normalized)) return 'modified';
  if (['-', '-removed', 'remove', 'removed', 'delete', 'deleted', 'del', 'd'].includes(normalized)) return 'removed';
  if (['->', '=>', 'rename', 'renamed', 'move', 'moved', 'r'].includes(normalized)) return 'renamed';
  return undefined;
}

function parseBodyLine(line: string): FileChange | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const renameMatch = trimmed.match(/^(.+?)\s*(?:->|=>|→)\s*(.+?)(?:\s+(rename|renamed|move|moved|r))?$/i);
  if (renameMatch) {
    const oldPath = cleanPath(renameMatch[1]);
    const path = cleanPath(renameMatch[2]);
    return path ? { path, oldPath, kind: 'renamed' } : undefined;
  }

  const parts = trimmed.split(/\s+/);
  const lastToken = parts.at(-1) ?? '';
  const kind = parseKind(lastToken);
  const path = cleanPath(kind ? parts.slice(0, -1).join(' ') : trimmed);
  return path ? { path, kind: kind ?? 'modified' } : undefined;
}

function changesFromBody(body: string): FileChange[] {
  return body.split(/\r?\n/).map(parseBodyLine).filter((change): change is FileChange => Boolean(change));
}

function insertChange(root: TreeNode, change: FileChange) {
  const parts = change.path.split('/').filter(Boolean);
  let cursor = root;

  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index];
    const path = parts.slice(0, index + 1).join('/');
    const existing = cursor.children.get(name);
    const next = existing ?? { name, path, children: new Map<string, TreeNode>() };
    if (index === parts.length - 1) next.change = change;
    cursor.children.set(name, next);
    cursor = next;
  }
}

function buildTree(changes: FileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map<string, TreeNode>() };
  for (const change of changes) insertChange(root, change);
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((left, right) => {
    const leftIsDir = left.children.size > 0 && !left.change;
    const rightIsDir = right.children.size > 0 && !right.change;
    if (leftIsDir !== rightIsDir) return leftIsDir ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function ChangeBadge({ change }: { change: FileChange }) {
  const label = change.kind === 'renamed' && change.oldPath ? `${change.oldPath} → ${change.path}` : KIND_LABELS[change.kind];

  return (
    <span
      className="ml-auto max-w-[min(28rem,55vw)] truncate rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={KIND_STYLES[change.kind]}
      title={label}
    >
      {label}
    </span>
  );
}

function TreeRows({ nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number }) {
  return (
    <>
      {nodes.map((node) => {
        const isDirectory = node.children.size > 0 && !node.change;
        const Icon = isDirectory ? Folder : FileText;
        return (
          <React.Fragment key={node.path}>
            <div className="flex min-h-7 items-center gap-2 rounded-md px-2 py-1.5" style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}>
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" style={{ color: isDirectory ? 'var(--wf-accent)' : 'var(--wf-text-subtle)' }} />
              <span className="min-w-0 truncate font-mono text-[11px] leading-5" style={{ color: 'var(--wf-text)' }} title={node.change?.path ?? node.path}>
                {node.name}
              </span>
              {node.change ? <ChangeBadge change={node.change} /> : null}
            </div>
            {node.children.size > 0 ? <TreeRows nodes={sortedChildren(node)} depth={depth + 1} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

export default function FileTreeBlock({ body, blockId }: BlockProps) {
  const { touches = [] } = React.useContext(PlanBlockContext);
  const explicitChanges = changesFromBody(body);
  const changes = explicitChanges.length > 0 ? explicitChanges : touches.map((path) => ({ path: cleanPath(path), kind: 'modified' as const })).filter((change) => change.path);
  const tree = buildTree(changes);
  const roots = sortedChildren(tree);

  return (
    <div
      className="not-prose rounded-lg border p-3 text-xs shadow-sm"
      data-block-id={blockId}
      style={{ backgroundColor: 'var(--wf-surface)', borderColor: 'var(--wf-border)', color: 'var(--wf-text-muted)', boxShadow: 'var(--wf-shadow-soft)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-semibold uppercase tracking-wide" style={{ color: 'var(--wf-text)' }}>
          File tree
        </div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--wf-text-subtle)' }}>
          {changes.length} {changes.length === 1 ? 'file' : 'files'}
        </div>
      </div>

      {roots.length > 0 ? (
        <div className="space-y-0.5 rounded-md border p-1" style={{ backgroundColor: 'var(--wf-paper)', borderColor: 'var(--wf-border)' }}>
          <TreeRows nodes={roots} />
        </div>
      ) : (
        <div className="rounded-md border px-3 py-2 font-mono text-[11px]" style={{ backgroundColor: 'var(--wf-paper)', borderColor: 'var(--wf-border)', color: 'var(--wf-text-subtle)' }}>
          No files
        </div>
      )}
    </div>
  );
}
