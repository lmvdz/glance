import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
      {/* subtle green ambient glow — dark only, mirrors product UI --glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 hidden dark:block"
        style={{
          background:
            'radial-gradient(720px 420px at 50% 26%, color-mix(in srgb, var(--color-fd-primary) 13%, transparent), transparent 68%)',
        }}
      />
      <h1 className="mb-5 max-w-3xl text-balance text-5xl font-bold tracking-tight sm:text-6xl">
        Hello <span className="text-fd-primary">World</span>
      </h1>
      <p className="max-w-md text-balance text-fd-muted-foreground">
        You can open{' '}
        <Link
          href="/docs"
          className="font-medium text-fd-primary underline underline-offset-4 transition-colors hover:text-fd-primary/80"
        >
          /docs
        </Link>{' '}
        and see the documentation.
      </p>
    </div>
  );
}
