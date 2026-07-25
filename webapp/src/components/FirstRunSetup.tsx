/**
 * FirstRunSetup — the db-mode empty-org onboarding.
 *
 * A freshly-provisioned personal workspace has no agents and no features, so
 * `projects()` is empty and the whole dashboard renders "No project" with
 * nothing to click — a dead end (you can log out and back in and land right
 * back here). This is the missing affordance: register the first repo as a
 * feature (POST /api/features), which persists to the org's store and makes the
 * repo appear as the workspace's project. Leaving the path blank registers the
 * daemon's own working directory (the server defaults `repo` to its cwd).
 */
import React from 'react';
import { FolderGit2, Loader2, Plus } from 'lucide-react';
import { apiJson, jsonInit } from '../lib/api';
import { useTaskContext } from '../context/TaskContext';
import { GlanceLogo } from './GlanceLogo';

export const FirstRunSetup: React.FC = () => {
  const { reload, showToast } = useTaskContext();
  const [repo, setRepo] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const path = repo.trim();
    // Default the project title to the repo's basename so the first card reads sensibly.
    const name = title.trim() || (path ? path.replace(/\/+$/, '').split('/').pop() || 'First project' : 'First project');
    try {
      await apiJson('/api/features', jsonInit('POST', path ? { title: name, repo: path } : { title: name }));
      await reload();
      showToast('Workspace added — welcome aboard', 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'Could not add the workspace', 'error');
      setSubmitting(false);
    }
  };

  return (
    <main className="flex h-full flex-1 items-center justify-center overflow-y-auto bg-[#f7f8f9] p-6 bg-ink">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <GlanceLogo size={40} className="mb-3 text-ink-text" />
          <h1 className="text-lg font-semibold text-ink-text">Add your first workspace</h1>
          <p className="mt-1.5 text-sm text-ink-text-muted">
            Your organization is empty. Point it at a git repo to start the fleet — this becomes your first project.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-ink-border bg-white p-5 shadow-sm border-ink-border bg-panel"
        >
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-text-muted">
              <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" /> Repo path
            </span>
            <input
              type="text"
              value={repo}
              onChange={(ev) => setRepo(ev.target.value)}
              placeholder="/absolute/path/to/repo"
              autoFocus
              className="w-full rounded-md border border-ink-border bg-white px-3 py-2 text-sm text-ink-text placeholder:text-ink-text-subtle focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 border-ink-border-2 bg-ink text-ink-text"
            />
            <span className="mt-1 block text-caption text-ink-text-subtle">
              Leave blank to use the daemon's working directory.
            </span>
          </label>

          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-text-muted">
              Project name <span className="font-normal normal-case text-ink-text-subtle">(optional)</span>
            </span>
            <input
              type="text"
              value={title}
              onChange={(ev) => setTitle(ev.target.value)}
              placeholder="Defaults to the repo folder name"
              className="w-full rounded-md border border-ink-border bg-white px-3 py-2 text-sm text-ink-text placeholder:text-ink-text-subtle focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 border-ink-border-2 bg-ink text-ink-text"
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="mt-5 flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-amber-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-gray-900"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Adding…
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" aria-hidden="true" /> Add workspace
              </>
            )}
          </button>
        </form>
      </div>
    </main>
  );
};
