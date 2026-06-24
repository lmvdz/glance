import { useEffect, useMemo, useState } from "react";
import type { SquadState } from "@/hooks/useSquad";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

// Loose shapes — these come from our own daemon (trusted) and vary by deployment.
interface FederationSnapshot {
  coordinator?: string | null;
  operators?: { id?: string; name?: string; availability?: string }[];
  collisions?: { repo?: string; path?: string }[];
}
interface PresenceEntry { operator?: string; name?: string; availability?: string }
interface LeaseEntry { path?: string; holder?: string; operator?: string }
interface PlaneIssue { identifier?: string; name?: string; state?: string; url?: string }

export function NetworkView({ squad }: { squad: SquadState }) {
  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const f of squad.features) set.add(f.repo);
    for (const a of squad.agents) set.add(a.repo);
    return [...set];
  }, [squad.features, squad.agents]);

  const [repo, setRepo] = useState("");
  const activeRepo = repo || repos[0] || "";

  const [fed, setFed] = useState<FederationSnapshot | null>(null);
  const [presence, setPresence] = useState<PresenceEntry[] | null>(null);
  const [leases, setLeases] = useState<LeaseEntry[] | null>(null);
  const [issues, setIssues] = useState<PlaneIssue[] | null>(null);
  const [planeOff, setPlaneOff] = useState(false);

  useEffect(() => {
    let alive = true;
    apiGet<FederationSnapshot>("/api/federation").then((d) => {
      if (alive) setFed(d ?? {});
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeRepo) return;
    let alive = true;
    const q = "?repo=" + encodeURIComponent(activeRepo);
    apiGet<PresenceEntry[]>("/api/presence" + q).then((d) => alive && setPresence(d ?? []));
    apiGet<LeaseEntry[]>("/api/leases" + q).then((d) => alive && setLeases(d ?? []));
    apiGet<PlaneIssue[]>("/api/plane/issues?project=" + encodeURIComponent(activeRepo)).then((d) => {
      if (!alive) return;
      setPlaneOff(d === null);
      setIssues(d ?? []);
    });
    return () => {
      alive = false;
    };
  }, [activeRepo]);

  if (repos.length === 0) {
    return (
      <div className="p-3">
        <EmptyState title="No repos in the fleet">Spawn an agent or add a feature to populate presence and leases.</EmptyState>
      </div>
    );
  }

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="flex items-center gap-3">
        <span className="text-xs uppercase tracking-wide text-text-3">Repo</span>
        <div className="w-72">
          <Select value={activeRepo} onValueChange={setRepo}>
            <SelectTrigger>
              <SelectValue placeholder="Select a repo" />
            </SelectTrigger>
            <SelectContent>
              {repos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r.split("/").filter(Boolean).pop()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Federation</CardTitle>
        </CardHeader>
        <CardContent>
          {fed === null ? (
            <span className="text-sm text-text-muted">Loading…</span>
          ) : fed.operators && fed.operators.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {fed.operators.map((o, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <Badge tone="neutral">{o.availability ?? "?"}</Badge>
                  <span className="text-text-1">{o.name ?? o.id}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-sm text-text-muted">No linked operators (single-operator mode).</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Presence</CardTitle>
        </CardHeader>
        <CardContent>
          {presence === null ? (
            <span className="text-sm text-text-muted">Loading…</span>
          ) : presence.length === 0 ? (
            <span className="text-sm text-text-muted">Nobody claimed this repo.</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              {presence.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-text-1">
                  {p.name ?? p.operator}
                  {p.availability ? <span className="text-text-3">{p.availability}</span> : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>File leases</CardTitle>
        </CardHeader>
        <CardContent>
          {leases === null ? (
            <span className="text-sm text-text-muted">Loading…</span>
          ) : leases.length === 0 ? (
            <span className="text-sm text-text-muted">No files claimed.</span>
          ) : (
            <div className="flex flex-col gap-1">
              {leases.map((l, i) => (
                <div key={i} className="flex items-center justify-between gap-2 font-mono text-xs">
                  <span className="truncate text-text-1">{l.path}</span>
                  <span className="shrink-0 text-text-3">{l.holder ?? l.operator}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plane issues</CardTitle>
        </CardHeader>
        <CardContent>
          {planeOff ? (
            <span className="text-sm text-text-muted">Plane not connected. Set PLANE_API_KEY + PLANE_WORKSPACE on the daemon.</span>
          ) : issues === null ? (
            <span className="text-sm text-text-muted">Loading…</span>
          ) : issues.length === 0 ? (
            <span className="text-sm text-text-muted">No open issues.</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              {issues.map((it, i) => (
                <a
                  key={i}
                  href={it.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-sm text-text-1 hover:text-accent"
                >
                  {it.identifier ? <span className="font-mono text-xs text-text-3">{it.identifier}</span> : null}
                  <span className="truncate">{it.name}</span>
                  {it.state ? <span className="ml-auto shrink-0 text-xs text-text-3">{it.state}</span> : null}
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
