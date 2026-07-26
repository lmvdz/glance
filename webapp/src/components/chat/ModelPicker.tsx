import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Zap } from 'lucide-react';
import type { ModelOption } from './Composer';

/**
 * ModelPicker — the model control, built to be looked at every day.
 *
 * It replaces a native `<select>` in a rounded pill, which was the only piece of the composer that
 * still looked like a form. Three things make the difference between a control and a widget:
 *
 * 1. **The trigger states the whole choice.** Provider mark, model, and effort in one line, so you
 *    know what will run without opening anything.
 * 2. **Opening it does not hide what you had.** The current model is checked and the current effort is
 *    lit, so the panel is a comparison rather than a fresh decision.
 * 3. **Effort lives in the same panel as the model**, because they are one choice made twice — picking
 *    a bigger model and then leaving effort on Low is the mistake this layout prevents.
 *
 * Search appears only past a threshold: a filter box over five items is furniture.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

export type Effort = 'low' | 'medium' | 'high' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];

/** Provider inferred from the model id, so the mark and grouping need no extra plumbing. */
export function providerOf(value: string): string {
  const id = value.toLowerCase();
  if (id.includes('claude') || id.includes('opus') || id.includes('sonnet') || id.includes('haiku') || id.includes('fable')) return 'anthropic';
  if (id.includes('gpt') || id.includes('codex') || id.includes('o3') || id.includes('openai')) return 'openai';
  if (id.includes('grok') || id.includes('xai')) return 'xai';
  if (id.includes('gemini') || id.includes('google')) return 'google';
  return 'default';
}

/**
 * The name a person would say, from an id a machine needs.
 *
 * DESIGN.md's standing rule: identity at a glance, address on demand. "anthropic/claude-3-5-sonnet-
 * 20240620" is an address — correct, unreadable, and eleven stacked is a wall. The name goes in the
 * list and the exact id stays one hover away, so shortening never means losing.
 */
export function modelDisplayName(value: string): string {
	return shortName(value);
}

/**
 * Names for a whole list, with collisions kept apart.
 *
 * The first version stripped release dates and produced two entries both reading "Claude 3.5 Sonnet" —
 * shortening that LOST, which is worse than the long id it replaced, because two different models now
 * looked like the same one. Where a short name is not unique, the thing that distinguishes them comes
 * back. Shortening must never mean losing.
 */
export function modelDisplayNames(values: readonly string[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const value of values) {
		const name = shortName(value);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const out = new Map<string, string>();
	for (const value of values) {
		const name = shortName(value);
		if ((counts.get(name) ?? 0) < 2) { out.set(value, name); continue; }
		const stamp = /(\d{8})$/.exec(value)?.[1];
		out.set(value, stamp ? `${name} · ${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}` : value);
	}
	return out;
}

function shortName(value: string): string {
	if (!value) return 'default';
	const withoutProvider = value.includes('/') ? value.slice(value.indexOf('/') + 1) : value;
	const withoutDate = withoutProvider.replace(/[-_]?\d{8}$/, '');
	return withoutDate
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(' ')
		.replace(/(\d) (\d)/g, '$1.$2');
}

const PROVIDER_MARK: Record<string, string> = { anthropic: 'A', openai: 'O', xai: 'X', google: 'G', default: '·' };
const PROVIDER_NAME: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI', google: 'Google', default: 'Default' };

export interface ModelPickerProps {
  options: ModelOption[];
  value: string;
  onChange: (value: string) => void;
  effort?: Effort;
  onEffortChange?: (effort: Effort) => void;
  disabled?: boolean;
}

export function ModelPicker({ options, value, onChange, effort = 'high', onEffortChange, disabled }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const current = options.find((option) => option.value === value) ?? options[0];
  const provider = providerOf(current?.value ?? '');
  const searchable = options.length > 8;

  const names = useMemo(() => modelDisplayNames(options.map((option) => option.value)), [options]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    if (searchable) searchRef.current?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, searchable]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 items-center gap-1.5 rounded-[3px] px-2 transition-colors disabled:opacity-50"
        style={{ border: '1px solid #26262B', background: open ? '#17171A' : '#0F0F11' }}
        // Every control says what it will do before it is used.
        title={`${current?.label ?? 'default model'} at ${effort} effort. Changing this affects the next message, not the ones already sent.`}
      >
        <span
          className="flex h-4 w-4 flex-none items-center justify-center rounded-[2px]"
          style={{ background: '#1E1E22', color: '#F0A35A', fontFamily: MONO, fontSize: 9 }}
        >
          {PROVIDER_MARK[provider]}
        </span>
        <span className="max-w-40 truncate" style={{ fontFamily: MONO, fontSize: 11, color: '#C9C9CF' }}>
          {current?.value ? modelDisplayName(current.value) : (current?.label ?? 'default')}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: '#5A5A61' }}>·</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: '#F0A35A' }}>{effort}</span>
        <ChevronDown className="h-3 w-3" style={{ color: '#5A5A61' }} aria-hidden />
      </button>

      {open ? (
        <div
          className="absolute bottom-full left-0 z-50 mb-1.5 w-[340px] overflow-hidden rounded-[3px]"
          style={{ border: '1px solid #26262B', background: '#0C0C0D', boxShadow: '0 12px 32px rgba(0,0,0,.5)' }}
          role="listbox"
        >
          {searchable ? (
            <div className="flex items-center gap-2 px-2.5 py-2" style={{ borderBottom: '1px solid #1A1A1D' }}>
              <Search className="h-3.5 w-3.5 flex-none" style={{ color: '#4A4A52' }} aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                className="w-full bg-transparent outline-none"
                style={{ fontFamily: MONO, fontSize: 11, color: '#C9C9CF' }}
              />
            </div>
          ) : null}

          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-3" style={{ fontSize: 12, color: '#6A6A72' }}>
                Nothing matches “{query}”. The list is every model this daemon is configured for — if one is missing, it is missing from the config, not from the search.
              </div>
            ) : filtered.map((option, index) => {
              const selected = option.value === value;
              const optionProvider = providerOf(option.value);
              // A quiet provider heading each time the group changes: eleven ids in a row read as one
              // wall, and the mark alone is too small to break it up.
              const startsGroup = index === 0 || providerOf(filtered[index - 1]!.value) !== optionProvider;
              const name = names.get(option.value) ?? modelDisplayName(option.value);
              return (
                <React.Fragment key={option.value || 'default'}>
                  {startsGroup ? (
                    <div className="px-2.5 pb-0.5 pt-2" style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.14em', color: '#4A4A52' }}>
                      {(PROVIDER_NAME[optionProvider] ?? 'Other').toUpperCase()}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => { onChange(option.value); setOpen(false); }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                    style={{ background: selected ? '#1A1512' : 'transparent' }}
                    title={option.value || 'the daemon default'}
                  >
                    <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5, color: selected ? '#E8E8EA' : '#A8A8B0' }}>
                      {name === 'default' ? option.label : name}
                    </span>
                    {selected ? <Check className="h-3.5 w-3.5 flex-none" style={{ color: '#F0A35A' }} aria-hidden /> : null}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          {onEffortChange ? (
            <div className="flex items-center gap-1 px-2 py-1.5" style={{ borderTop: '1px solid #1A1A1D' }}>
              <Zap className="h-3 w-3 flex-none" style={{ color: '#4A4A52' }} aria-hidden />
              {/* Effort sits WITH the model, because they are one choice made twice: picking a bigger
                  model and leaving effort on low is the mistake a separate control invites. */}
              {EFFORTS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => onEffortChange(level)}
                  className="rounded-[2px] px-1.5 py-0.5 capitalize"
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: level === effort ? '#0A0A0B' : '#7A7A82',
                    background: level === effort ? '#F0A35A' : 'transparent',
                  }}
                  title={`${level} effort — applies to the next message.`}
                >
                  {level}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
