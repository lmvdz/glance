import { Button } from "@/components/ui/button.tsx";

export function App() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">omp-squad</h1>
      <p className="text-muted-foreground text-sm">web framework rewrite — scaffold</p>
      <Button>It works</Button>
    </main>
  );
}
