import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { apiGet, apiPost } from "@/lib/api";
import type { AgentProfile } from "@/lib/dto";

type Mode = "spawn" | "feature" | "auto";

export function NewWork() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("spawn");
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState("default");

  useEffect(() => {
    void apiGet<{ profiles: AgentProfile[] }>("/api/profiles").then((result) => {
      if (result?.profiles.length) {
        setProfiles(result.profiles);
        setProfileId(result.profiles.find((profile) => profile.default)?.id ?? result.profiles[0].id);
      }
    });
  }, []);

  const go = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const repoArg = repo.trim() || undefined;
    let ok = false;
    if (mode === "spawn") ok = (await apiPost("/api/spawn", { prompt: text.trim(), profileId })) !== null;
    else if (mode === "feature") ok = (await apiPost("/api/features", { title: text.trim(), repo: repoArg })) !== null;
    else ok = (await apiPost("/api/features/auto", { goal: text.trim(), repo: repoArg })) !== null;
    setBusy(false);
    toast({ title: ok ? "Created" : "Request failed", tone: ok ? "success" : "danger" });
    if (ok) {
      setText("");
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="primary">
          + New
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New work</DialogTitle>
        </DialogHeader>
        <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="spawn">Spawn agent (from a prompt)</SelectItem>
            <SelectItem value="feature">New feature</SelectItem>
            <SelectItem value="auto">Plan & review (research → plan → you approve → implement)</SelectItem>
          </SelectContent>
        </Select>
        {mode === "spawn" ? (
          <Select value={profileId} onValueChange={setProfileId}>
            <SelectTrigger aria-label="Agent profile">
              <SelectValue placeholder="Profile" />
            </SelectTrigger>
            <SelectContent>
              {(profiles.length ? profiles : [{ id: "default", name: "Default OMP operator", runtime: "omp-operator" as const }]).map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {mode !== "spawn" ? (
          <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Repo path (default: daemon cwd)" />
        ) : null}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={mode === "feature" ? "Feature title" : "Describe what the agent should do"}
          className="w-full rounded-[var(--radius-sm)] border border-border bg-secondary px-3 py-2 text-sm text-text-1 outline-none focus:border-accent"
        />
        {mode === "auto" ? (
          <p className="text-xs text-text-muted">
            Drafts a plan, then pauses at a review gate on the feature — comment, then Approve or Revise. Your unresolved comments are fed into the next phase.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void go()}>
            {busy ? "Working…" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
