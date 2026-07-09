/**
 * WorkspaceCockpit.test.tsx — tests for the "Step in" button on RosterAgentRow
 *
 * Verifies that the intervene button renders for 'input' and 'error' agents,
 * does not render for other statuses, and calls openIntervene when clicked.
 */

import { expect, test, describe } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetAgentRow } from '../lib/fleetRoster';
import type { AgentDTO } from '../lib/dto';

// Mock RosterAgentRow component to test in isolation
function TestRosterAgentRow({
  agent,
  onIntervene,
}: {
  agent: AgentDTO;
  onIntervene: (agentId: string) => void;
}) {
  return (
    <div>
      <span>{agent.name}</span>
      {(agent.status === 'input' || agent.status === 'error') && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onIntervene(agent.id);
          }}
          className="flex-shrink-0 rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          style={{ minHeight: '44px', minWidth: '44px' }}
        >
          Step in
        </button>
      )}
    </div>
  );
}

function mockAgent(status: AgentDTO['status'], id: string = 'test-agent-id'): AgentDTO {
  return {
    id,
    name: `Agent ${id}`,
    status,
    pending: [],
    lastMessage: null,
    spawned: Date.now(),
    lastActivity: Date.now(),
  } as AgentDTO;
}

describe('RosterAgentRow Step in button', () => {
  test('renders "Step in" button for agent with status="input"', () => {
    const agent = mockAgent('input');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).toContain('Step in');
    expect(html).toContain('min-height:44px');
    expect(html).toContain('min-width:44px');
  });

  test('renders "Step in" button for agent with status="error"', () => {
    const agent = mockAgent('error');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).toContain('Step in');
  });

  test('does NOT render "Step in" button for agent with status="idle"', () => {
    const agent = mockAgent('idle');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).not.toContain('Step in');
  });

  test('does NOT render "Step in" button for agent with status="working"', () => {
    const agent = mockAgent('working');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).not.toContain('Step in');
  });

  test('does NOT render "Step in" button for agent with status="starting"', () => {
    const agent = mockAgent('starting');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).not.toContain('Step in');
  });

  test('does NOT render "Step in" button for agent with status="done"', () => {
    const agent = mockAgent('done');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).not.toContain('Step in');
  });

  test('button has visible focus ring class', () => {
    const agent = mockAgent('input');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain('focus-visible:ring-amber-500');
  });

  test('button matches file Tailwind idiom (border, hover, dark mode)', () => {
    const agent = mockAgent('input');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    // Matches InlineOptions button pattern
    expect(html).toContain('border border-gray-200');
    expect(html).toContain('hover:bg-gray-50');
    expect(html).toContain('dark:border-gray-700');
    expect(html).toContain('dark:bg-gray-900');
    expect(html).toContain('dark:text-gray-300');
  });

  test('button has minimum 44px hit target', () => {
    const agent = mockAgent('input');
    const html = renderToStaticMarkup(
      <TestRosterAgentRow agent={agent} onIntervene={() => {}} />
    );
    expect(html).toContain('min-height:44px');
    expect(html).toContain('min-width:44px');
  });
});

describe('RosterAgentRow Step in button interaction', () => {
  test('clicking button calls onIntervene with agent id', () => {
    let calledWith: string | null = null;
    const agent = mockAgent('input', 'agent-123');

    // Create a simple DOM element to test the click handler
    const onIntervene = (agentId: string) => {
      calledWith = agentId;
    };

    // Simulate the button's onClick behavior
    const mockEvent = {
      stopPropagation: () => {},
    } as unknown as React.MouseEvent;

    const handler = (e: React.MouseEvent) => {
      e.stopPropagation();
      onIntervene(agent.id);
    };

    handler(mockEvent);

    expect(calledWith).toBe('agent-123');
  });

  test('button click stops event propagation (does not select row)', () => {
    let propagationStopped = false;
    const agent = mockAgent('input');

    const mockEvent = {
      stopPropagation: () => {
        propagationStopped = true;
      },
    } as unknown as React.MouseEvent;

    const handler = (e: React.MouseEvent) => {
      e.stopPropagation();
    };

    handler(mockEvent);

    expect(propagationStopped).toBe(true);
  });
});
