import { useEffect, useState } from "react";
import type { AuditEntry } from "@/lib/dto";
import { apiGet } from "@/lib/api";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/agent/relative-time";

// ponytail: 4s poll (matches the live SPA's feature cadence). Upgrade path:
// consume the `audit` WS event to prepend rows live.
export function AuditView() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const d = await apiGet<AuditEntry[]>("/api/audit?limit=200");
      if (alive) setEntries(d ?? []);
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (entries === null) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="p-3">
        <EmptyState title="No audit entries">Fleet actions (spawn, prompt, answer, land…) show here.</EmptyState>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-3">
      <Table>
        <THead>
          <Tr className="hover:bg-transparent">
            <Th>When</Th>
            <Th>Actor</Th>
            <Th>Action</Th>
            <Th>Target</Th>
            <Th>Outcome</Th>
          </Tr>
        </THead>
        <TBody>
          {entries.map((e, i) => (
            <Tr key={i}>
              <Td className="whitespace-nowrap text-text-3">
                <RelativeTime ts={e.at} />
              </Td>
              <Td>{e.actor ?? "—"}</Td>
              <Td>{e.action}</Td>
              <Td className="max-w-[18rem] truncate">{e.target ?? ""}</Td>
              <Td className="text-text-3">{e.outcome ?? e.detail ?? ""}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
