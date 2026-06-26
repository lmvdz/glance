import { useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

/** Decode a base64url VAPID public key into the byte array pushManager wants. */
function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushToggle() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      if (!("serviceWorker" in navigator) || typeof Notification === "undefined" || !("PushManager" in window)) {
        toast({ title: "Notifications unsupported in this browser", tone: "danger" });
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") {
        toast({ title: "Notifications blocked", tone: "danger" });
        return;
      }
      const key = await apiGet<{ publicKey?: string }>("/api/push/key");
      if (!key?.publicKey) {
        toast({ title: "Push not configured on the daemon", tone: "danger" });
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key.publicKey),
      });
      await apiPost("/api/push/subscribe", sub.toJSON());
      toast({ title: "Notifications enabled", tone: "success" });
    } catch {
      toast({ title: "Couldn't enable notifications", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void enable()}
      disabled={busy}
      title="Enable desktop push notifications"
      className="rounded px-2 py-0.5 text-text-muted hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
    >
      {busy ? "…" : "Notify"}
    </button>
  );
}
