import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
      {/* subtle ember ambient glow — dark only, mirrors the product brand */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 hidden dark:block"
        style={{
          background:
            'radial-gradient(720px 420px at 50% 26%, color-mix(in srgb, var(--color-fd-primary) 13%, transparent), transparent 68%)',
        }}
      />
      <p className="mb-4 font-mono text-sm text-fd-muted-foreground">
        <span className="text-fd-primary">✦</span> formerly omp-squad
      </p>
      <h1 className="mb-5 max-w-3xl text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
        glance
      </h1>
      <p className="mb-10 max-w-xl text-balance text-lg text-fd-muted-foreground">
        Oversight for a fleet of coding agents — one per git worktree. Agents build, verify, and
        land work; you supervise by exception. You glance, and you know.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
        >
          Read the docs
        </Link>
        <Link
          href="/docs/getting-started/quickstart"
          className="rounded-lg border border-fd-border bg-fd-secondary px-5 py-2.5 font-medium text-fd-secondary-foreground transition-colors hover:border-fd-primary/50"
        >
          Quickstart
        </Link>
      </div>
    </div>
  );
}
