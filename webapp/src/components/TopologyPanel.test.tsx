/**
 * TopologyPanel.test.tsx — DOM-free (renderToStaticMarkup) as per project convention.
 *
 * TopologyPanel itself needs TaskContext, so (like the other panel tests) we render its exported
 * `TopologyRow` sub-component directly with a hand-built `LineageNode`.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { TopologyRow } from './TopologyPanel';
import type { LineageNode } from '../lib/lineage';
import type { AgentDTO, SubagentNodeDTO } from '../lib/dto';

function agent(id: string, extra: Partial<AgentDTO> = {}): AgentDTO {
  return {
    id,
    name: id,
    status: 'working',
    repo: '/repo',
    worktree: '/repo/.worktrees/' + id,
    pending: [],
    lastActivity: 0,
    autonomyMode: 'assist',
    effectiveMode: 'assist',
    verificationState: 'unknown',
    availableActions: [],
    ...extra,
  };
}

function subagent(id: string, agentName: string, extra: Partial<SubagentNodeDTO> = {}): SubagentNodeDTO {
  return { id, agent: agentName, status: 'running', lastUpdate: 0, index: 0, ...extra };
}

function node(a: AgentDTO, children: LineageNode[] = [], orphaned = false): LineageNode {
  return { agent: a, children, orphaned };
}

describe('TopologyRow — subagent rendering (finding 4)', () => {
  test('an agent with subagents renders each subagent name and status', () => {
    const a = agent('parent', {
      subagents: [
        subagent('s1', 'Researcher', { status: 'running' }),
        subagent('s2', 'Reviewer', { status: 'completed' }),
      ],
    });
    const html = renderToStaticMarkup(<TopologyRow node={node(a)} depth={0} />);
    expect(html).toContain('Researcher');
    expect(html).toContain('Reviewer');
    expect(html).toContain('running');
    expect(html).toContain('completed');
  });

  test('an agent with no subagents renders none of the subagent leaf-row markup', () => {
    const a = agent('lonely');
    const html = renderToStaticMarkup(<TopologyRow node={node(a)} depth={0} />);
    expect(html).not.toContain('Researcher');
    expect(html).not.toContain('Reviewer');
  });

  test('a subagent-only agent (no lineage children) still gets an expand/collapse toggle', () => {
    const a = agent('leader', { subagents: [subagent('s1', 'Scout')] });
    const html = renderToStaticMarkup(<TopologyRow node={node(a)} depth={0} />);
    expect(html).toContain('aria-label="Collapse leader"');
    expect(html).toContain('Scout');
  });

  test('an agent with neither lineage children nor subagents renders no toggle button', () => {
    const a = agent('solo');
    const html = renderToStaticMarkup(<TopologyRow node={node(a)} depth={0} />);
    expect(html).not.toContain('<button');
  });

  test('an unrecognized subagent status falls back to the neutral dot class rather than throwing', () => {
    const a = agent('parent', { subagents: [subagent('s1', 'Odd', { status: 'unknown-status' })] });
    const html = renderToStaticMarkup(<TopologyRow node={node(a)} depth={0} />);
    expect(html).toContain('Odd');
    expect(html).toContain('bg-gray-400');
  });
});
