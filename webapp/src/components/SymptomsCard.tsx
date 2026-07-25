/**
 * SymptomsCard — the recurring-failure-mode index, browsable (Fog view).
 *
 * The symptom index (comprehension concern 07) is fed live by units recording "operator-facing
 * defect phrasing + where to look" — but its only surfaces were rank-only: the ⌘K palette and the
 * `glance symptom <query>` CLI, both of which require already knowing what to search for. This card
 * uses the browse contract (`GET /api/symptoms?browse=1`, newest-first) so failure modes surface
 *  unprompted, which is the whole point of an index of things that keep going wrong.
 *
 * Self-fetching (FogView mounts it as a sibling of heat/fog, which have their own poll); pure list
 * exported for fixture tests.
 */

import React, { useEffect, useState } from 'react';
import { Stethoscope } from 'lucide-react';
import { browseSymptoms } from '../lib/api';
import { coerceSymptoms, type SymptomWire } from '../lib/loop-meters';
import { SectionCard } from './ui';
import { relativeAge } from './ui/time';

function repoBasename(repo: string): string {
  const trimmed = repo.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export const SymptomRows: React.FC<{ symptoms: SymptomWire[]; now?: number }> = ({ symptoms, now }) => (
  <ul>
    {symptoms.map((s) => {
      const age = relativeAge(s.landedAt, now);
      return (
        <li key={s.id} className="border-b border-ink-border px-4 py-3 last:border-b-0 border-ink-border/60">
          <p className="text-sm text-ink-text-body">{s.symptom}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-text-muted">
            {age && (
              <span className="font-mono" title={new Date(s.landedAt).toISOString()}>
                {age} ago
              </span>
            )}
            {s.repo && (
              <span className="max-w-[10rem] truncate font-mono text-ink-text-subtle" title={s.repo}>
                {repoBasename(s.repo)}
              </span>
            )}
            {s.fixedBy?.prNumber !== undefined && (
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-caption font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                fixed by #{s.fixedBy.prNumber}
              </span>
            )}
          </div>
          {s.whereToLook.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {s.whereToLook.map((w) => (
                <code
                  key={w}
                  className="rounded bg-ink-surface px-1.5 py-0.5 font-mono text-caption text-ink-text-label bg-ink-surface text-ink-text-label"
                >
                  {w}
                </code>
              ))}
            </div>
          )}
        </li>
      );
    })}
  </ul>
);

export const SymptomsCard: React.FC = () => {
  const [symptoms, setSymptoms] = useState<SymptomWire[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    browseSymptoms(30)
      .then((raw) => {
        if (!cancelled) {
          setSymptoms(coerceSymptoms(raw));
          setError('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSymptoms([]);
          setError('Could not reach the daemon for the symptom index.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SectionCard
      title="Known symptoms"
      right={symptoms && symptoms.length > 0 ? <span className="font-mono text-caption">{symptoms.length}</span> : undefined}
    >
      {symptoms === null ? (
        <div className="space-y-2 p-4" aria-label="Loading symptom index">
          {[1, 2].map((n) => (
            <div key={n} className="h-10 animate-pulse rounded-md bg-ink-surface" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : symptoms.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <Stethoscope className="mx-auto mb-2 h-6 w-6 text-ink-text-subtle" aria-hidden="true" />
          <div className="text-sm font-medium text-ink-text-muted">No symptoms recorded</div>
          <p className="mt-1 text-xs text-ink-text-muted">
            Units record recurring failure modes here as they hit them — searchable in ⌘K, browsable here.
          </p>
        </div>
      ) : (
        <SymptomRows symptoms={symptoms} />
      )}
    </SectionCard>
  );
};
