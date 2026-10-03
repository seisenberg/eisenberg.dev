import { useState } from "react";
import { Share, Smartphone, X } from "lucide-react";
import { useInstall } from "@/lib/pwa";

const KEY = "eisenmail.installHintDismissed";

/** A one-time nudge on phones: this site works as a home screen app. Hidden once installed or dismissed. */
export function InstallHint() {
  const install = useInstall();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(KEY) === "1");
  if (dismissed || install.kind === "installed" || install.kind === "manual") return null;
  const dismiss = () => {
    localStorage.setItem(KEY, "1");
    setDismissed(true);
  };
  return (
    <div className="bg-primary/10 flex shrink-0 items-center gap-3 border-b px-4 py-2.5 text-[14px]">
      <Smartphone className="text-primary size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        {install.kind === "ios" ? (
          <>
            Install as an app: tap <Share className="mx-0.5 inline size-4 align-text-bottom" aria-label="Share" /> then <b>Add to Home Screen</b>. Notifications work once installed.
          </>
        ) : (
          <>
            Install as an app for a full-screen view and notifications.{" "}
            <button type="button" className="text-primary font-semibold" onClick={() => void install.install().then((ok) => ok && dismiss())}>Install</button>
          </>
        )}
      </div>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="text-muted-foreground -mr-2 flex size-9 items-center justify-center"><X className="size-4" /></button>
    </div>
  );
}
