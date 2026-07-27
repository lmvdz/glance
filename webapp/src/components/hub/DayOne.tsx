import React from 'react';
import { apiJson, jsonInit } from '../../lib/api';
import { useTaskContext } from '../../context/TaskContext';

/**
 * DayOne — the first screen, in the voice `05-first-week.html` uses for it.
 *
 * The reference's whole argument about day one is in its footer: *"one question on day one · everything
 * else is a default it admits to"*, and in the line under the composer: *"Whatever you say becomes the
 * first sentence in the product that is actually yours."* It does not ask you to configure anything.
 * It asks for the work, in your words, and tells you what it is guessing about everything else.
 *
 * What was here: a white card on `#f7f8f9` with an amber-500 button and two labelled inputs — "Add
 * your first workspace", "Your organization is empty." A configuration form, and the last screen in
 * the product still wearing the old application's clothes. It was also the FIRST screen anybody sees.
 *
 * The fields stay, because pointing at a repository is genuinely something only a person can do. What
 * changes is that the screen says what it will guess and admits it is guessing.
 */

const MONO = "'JetBrains Mono',ui-monospace,monospace";

/** The name this will take if you do not give one — said before you decide, not after. */
export function guessedName(repo: string, title: string): { name: string; guessed: boolean } {
  const given = title.trim();
  if (given) return { name: given, guessed: false };
  const path = repo.trim().replace(/\/+$/, '');
  const base = path ? path.split('/').pop() : '';
  return base ? { name: base, guessed: true } : { name: 'First project', guessed: true };
}

export function DayOne() {
  const { reload, showToast } = useTaskContext();
  const [repo, setRepo] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const naming = guessedName(repo, title);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const path = repo.trim();
    try {
      await apiJson('/api/features', jsonInit('POST', path ? { title: naming.name, repo: path } : { title: naming.name }));
      await reload();
      showToast('The room is yours. Nothing has started yet.', 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That repository could not be added', 'error');
      setSubmitting(false);
    }
  };

  return (
    <main className="flex h-full flex-1 items-center justify-center overflow-y-auto px-8" style={{ background: '#0A0A0B', color: '#E8E8EA' }}>
      <div className="w-full" style={{ maxWidth: 620 }}>
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.16em', color: '#5A5A61' }}>NOTHING HAS STARTED · THERE IS NOTHING HERE TO UNDO</div>

        <div className="mt-3.5 text-[17px] leading-[1.5]" style={{ textWrap: 'pretty' }}>
          Point this at a repository and it becomes the first thing in your room. No agent wakes, nothing is written, and
          nothing runs until you ask it to.
        </div>

        <form onSubmit={submit} className="mt-7">
          <label className="block" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
            THE REPOSITORY
          </label>
          <input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="/home/you/your-repo"
            autoFocus
            className="mt-2 h-9 w-full rounded-[3px] bg-transparent px-3 outline-none"
            style={{ border: '1px solid #26262B', fontFamily: MONO, fontSize: 12, color: '#C9C9CF' }}
          />
          <div className="mt-1.5 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
            An absolute path on this machine. It is read, never written to, until something you started asks to change it.
          </div>

          <label className="mt-5 block" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.14em', color: '#5A5A61' }}>
            WHAT TO CALL IT
          </label>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={naming.guessed ? naming.name : ''}
            className="mt-2 h-9 w-full rounded-[3px] bg-transparent px-3 outline-none"
            style={{ border: '1px solid #26262B', fontSize: 13, color: '#C9C9CF' }}
          />
          {/* Everything else is a default it admits to. */}
          <div className="mt-1.5 text-[11.5px] leading-[1.45]" style={{ color: '#6A6A72', textWrap: 'pretty' }}>
            {naming.guessed
              ? `Left empty, this will be called “${naming.name}” — taken from the path, which is a guess and not something you said.`
              : `It will be called “${naming.name}”, because you said so.`}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 h-9 w-full rounded-[3px] text-[13px] font-semibold disabled:opacity-50"
            style={{ background: '#F0A35A', color: '#140D06' }}
          >
            {submitting ? 'adding it…' : 'Add it'}
          </button>
        </form>

        <div className="mt-6 pt-4" style={{ borderTop: '1px solid #1F1F22', fontFamily: MONO, fontSize: 10, color: '#4A4A52', lineHeight: 1.8 }}>
          one question on day one · everything else is a default it admits to
        </div>
      </div>
    </main>
  );
}
