import React from 'react';
import { PlanBlockContext, type BlockProps } from '../PlanBlocks';

type QuestionType = 'single' | 'multi' | 'freeform';

interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  options: string[];
  recommended: string[];
}

// ── tiny YAML-ish parser (no dependency) ──────────────────────────────────────
//
// Body is a list of items, each `- id: x` followed by indented `key: value` lines.
// `options` / list `recommended` are inline `[a, b, c]`. Scalars strip surrounding
// quotes. We keep only items that have both an id and a prompt.

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && /^["'].*["']$/.test(trimmed) && trimmed[0] === trimmed[trimmed.length - 1]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item.length > 0);
}

function normalizeType(value: string | undefined): QuestionType {
  const t = (value ?? '').toLowerCase();
  if (t === 'multi' || t === 'multiple' || t === 'checkbox' || t === 'checkboxes') return 'multi';
  if (t === 'freeform' || t === 'free' || t === 'text' || t === 'textarea') return 'freeform';
  return 'single';
}

export function parseQuestions(body: string): Question[] {
  const out: Question[] = [];
  let current: Partial<Question> & { rawType?: string } | null = null;

  const flush = () => {
    if (current && current.id && current.prompt) {
      out.push({
        id: current.id,
        type: normalizeType(current.rawType),
        prompt: current.prompt,
        options: current.options ?? [],
        recommended: current.recommended ?? [],
      });
    }
    current = null;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const itemStart = line.match(/^\s*-\s+(.*)$/);
    if (itemStart) {
      flush();
      current = {};
      const rest = itemStart[1];
      const kv = rest.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv) applyField(current, kv[1], kv[2]);
      continue;
    }

    const kv = line.match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv && current) applyField(current, kv[1], kv[2]);
  }
  flush();
  return out;
}

function applyField(item: Partial<Question> & { rawType?: string }, key: string, value: string): void {
  const k = key.toLowerCase();
  if (k === 'id') item.id = stripQuotes(value);
  else if (k === 'type') item.rawType = stripQuotes(value);
  else if (k === 'prompt' || k === 'question' || k === 'q') item.prompt = stripQuotes(value);
  else if (k === 'options') item.options = parseList(value);
  else if (k === 'recommended' || k === 'default') {
    item.recommended = value.trim().startsWith('[') ? parseList(value) : [stripQuotes(value)];
  }
}

// ── prefill: a previously-answered question lives as a Decisions bullet shaped
//    `Q: <prompt> — A: <value>` (em dash; tolerate `-- A:` too). ──────────────

const ANSWER_SEP = /\s+(?:—|--)\s+A:\s*/;

function resolvedAnswer(decisions: string[], prompt: string): string | null {
  const match = decisions.find((d) => d.startsWith(`Q: ${prompt}`));
  if (!match) return null;
  const parts = match.split(ANSWER_SEP);
  return parts.length > 1 ? parts.slice(1).join(' — A: ').trim() : null;
}

function ResolvedRow({ value }: { value: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]"
      style={{
        borderColor: 'color-mix(in srgb, var(--wf-accent) 34%, transparent)',
        backgroundColor: 'var(--wf-accent-soft, color-mix(in srgb, var(--wf-accent) 10%, transparent))',
        color: 'var(--wf-accent)',
      }}
    >
      <span aria-hidden="true">✓</span>
      {value}
    </span>
  );
}

interface QuestionFieldProps {
  question: Question;
  resolved: string | null;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

function QuestionField({ question, resolved, onSubmit, disabled }: QuestionFieldProps) {
  const initialSingle = resolved ?? (question.recommended[0] ?? question.options[0] ?? '');
  const initialMulti = resolved ? resolved.split(',').map((s) => s.trim()).filter(Boolean) : question.recommended;
  const [single, setSingle] = React.useState(initialSingle);
  const [multi, setMulti] = React.useState<string[]>(initialMulti);
  const [freeform, setFreeform] = React.useState(resolved ?? '');

  const toggleMulti = (option: string) => {
    setMulti((prev) => (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]));
  };

  const submit = () => {
    if (question.type === 'single') onSubmit(single);
    else if (question.type === 'multi') onSubmit(multi.join(', '));
    else onSubmit(freeform.trim());
  };

  const canSubmit = !disabled
    && (question.type === 'freeform' ? freeform.trim().length > 0
      : question.type === 'multi' ? multi.length > 0
        : single.length > 0);

  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium" style={{ color: 'var(--wf-text)' }}>
        {question.prompt}
      </legend>

      {resolved ? (
        <div className="flex flex-wrap items-center gap-2">
          <ResolvedRow value={resolved} />
        </div>
      ) : (
        <div className="space-y-1.5">
          {question.type === 'single' && question.options.map((option) => (
            <label key={option} className="flex cursor-pointer items-center gap-2 text-[13px]" style={{ color: 'var(--wf-text-muted)' }}>
              <input
                type="radio"
                name={`${question.id}`}
                value={option}
                checked={single === option}
                onChange={() => setSingle(option)}
                className="accent-[var(--wf-accent)]"
              />
              <span>{option}</span>
              {question.recommended.includes(option) ? (
                <span className="rounded px-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--wf-accent)' }}>recommended</span>
              ) : null}
            </label>
          ))}

          {question.type === 'multi' && question.options.map((option) => (
            <label key={option} className="flex cursor-pointer items-center gap-2 text-[13px]" style={{ color: 'var(--wf-text-muted)' }}>
              <input
                type="checkbox"
                value={option}
                checked={multi.includes(option)}
                onChange={() => toggleMulti(option)}
                className="accent-[var(--wf-accent)]"
              />
              <span>{option}</span>
              {question.recommended.includes(option) ? (
                <span className="rounded px-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--wf-accent)' }}>recommended</span>
              ) : null}
            </label>
          ))}

          {question.type === 'freeform' && (
            <textarea
              value={freeform}
              onChange={(event) => setFreeform(event.target.value)}
              rows={3}
              placeholder="Type your answer…"
              className="w-full rounded-md border px-2 py-1.5 text-[13px] outline-none"
              style={{ borderColor: 'var(--wf-border)', backgroundColor: 'var(--wf-paper)', color: 'var(--wf-text)' }}
            />
          )}

          <div className="pt-1">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'var(--wf-border-strong, var(--wf-border))', color: 'var(--wf-accent)', backgroundColor: 'var(--wf-surface-raised)' }}
            >
              Save answer
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}

export default function QuestionsBlock({ body, blockId }: BlockProps) {
  const ctx = React.useContext(PlanBlockContext);
  const decisions = ctx.decisions ?? [];
  const questions = React.useMemo(() => parseQuestions(body), [body]);
  const [pending, setPending] = React.useState<string | null>(null);

  if (questions.length === 0) {
    return (
      <div
        className="not-prose rounded-lg border p-3 text-xs"
        data-block-id={blockId}
        style={{ borderColor: 'var(--wf-border)', backgroundColor: 'var(--wf-surface)', color: 'var(--wf-text-subtle)' }}
      >
        No questions.
      </div>
    );
  }

  const handleSubmit = async (question: Question, value: string) => {
    if (!ctx.onAnswer || !value) return;
    setPending(question.id);
    try {
      await ctx.onAnswer(blockId, question.id, value);
    } finally {
      setPending(null);
    }
  };

  return (
    <form
      data-block-id={blockId}
      className="not-prose my-3 space-y-4 rounded-lg border p-3 shadow-sm"
      onSubmit={(event) => event.preventDefault()}
      style={{ borderColor: 'var(--wf-border)', backgroundColor: 'var(--wf-surface-raised)', boxShadow: 'var(--wf-shadow-soft)' }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--wf-text)' }}>
        Open questions
      </div>
      {questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          resolved={resolvedAnswer(decisions, question.prompt)}
          disabled={!ctx.onAnswer || pending === question.id}
          onSubmit={(value) => void handleSubmit(question, value)}
        />
      ))}
    </form>
  );
}
