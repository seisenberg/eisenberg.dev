import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, BellRing, Loader2, Share, Smartphone, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { get, post } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushSupport, useInstall } from "@/lib/pwa";
import type { DeliveryRule, DeliveryRules, ForwardStyle, PushStatus } from "../../shared/api";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold max-md:text-[16px]">{title}</h3>
        {hint && <p className="text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

// ---- install ---------------------------------------------------------------------------------

function InstallSection() {
  const install = useInstall();
  return (
    <Section title="Install as an app">
      {install.kind === "installed" && <p className="flex items-center gap-2 text-green-700 dark:text-green-400"><Smartphone className="size-4" /> Installed. You are using the app.</p>}
      {install.kind === "prompt" && (
        <div className="flex items-center gap-3">
          <p className="text-muted-foreground flex-1">Adds Mail to your home screen or dock, full screen, with notifications.</p>
          <Button size="sm" onClick={() => void install.install()}>Install</Button>
        </div>
      )}
      {install.kind === "ios" && (
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5">
          <li>Open this page in Safari.</li>
          <li>Tap the Share button <Share className="inline size-4 align-text-bottom" aria-hidden />.</li>
          <li>Choose <b className="text-foreground">Add to Home Screen</b>, then open Mail from the home screen.</li>
        </ol>
      )}
      {install.kind === "manual" && <p className="text-muted-foreground">Use your browser's menu and choose "Install" or "Add to Home Screen" (in Safari on a Mac: File, Add to Dock).</p>}
    </Section>
  );
}

// ---- notifications -----------------------------------------------------------------------------

function NotificationsSection() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["push"], queryFn: () => get<PushStatus>("/push") });
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const support = pushSupport();
  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(!!s && Notification.permission === "granted"));
  }, []);
  const refresh = () => qc.invalidateQueries({ queryKey: ["push"] });

  const enable = useMutation({
    mutationFn: enablePush,
    onSuccess: () => {
      setSubscribed(true);
      toast.success("Notifications are on for this device");
    },
    onError: (err) => toast.error((err as Error).message),
    onSettled: refresh,
  });
  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: () => setSubscribed(false),
    onError: (err) => toast.error((err as Error).message),
    onSettled: refresh,
  });
  const test = useMutation({
    mutationFn: () => post<{ sent: number; failed: number }>("/push/test"),
    onSuccess: (r) => (r.sent > 0 ? toast.success(`Test sent to ${r.sent} device${r.sent === 1 ? "" : "s"}`) : toast.error("No device accepted the test notification")),
    onError: (err) => toast.error((err as Error).message),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => post("/push/unsubscribe", { id }), onSettled: refresh });

  const unavailable = status.data && !status.data.available;
  return (
    <Section title="Notifications" hint="A notification when mail arrives on an address that has Notify switched on.">
      {unavailable && <p className="rounded-md bg-amber-500/15 px-3 py-2 text-amber-700 dark:text-amber-300">Notifications are not set up on the server yet (VAPID keys missing). See the README.</p>}
      {support === "needs-install" && <p className="text-muted-foreground">On iPhone and iPad, notifications work after you install the app (above) and open it from the home screen.</p>}
      {support === "unsupported" && <p className="text-muted-foreground">This browser does not support notifications.</p>}
      {support === "denied" && <p className="text-muted-foreground">Notifications are blocked for this site. Allow them in your browser or system settings, then come back.</p>}
      {support === "ok" && !unavailable && (
        <div className="flex flex-wrap items-center gap-2">
          {subscribed ? (
            <>
              <span className="flex flex-1 items-center gap-2 text-green-700 dark:text-green-400"><BellRing className="size-4" /> On for this device</span>
              <Button variant="outline" size="sm" disabled={disable.isPending} onClick={() => disable.mutate()}><BellOff /> Turn off</Button>
            </>
          ) : (
            <>
              <span className="text-muted-foreground flex-1">Off for this device</span>
              <Button size="sm" disabled={enable.isPending || subscribed === null} onClick={() => enable.mutate()}>{enable.isPending ? <Loader2 className="animate-spin" /> : <BellRing />} Turn on notifications</Button>
            </>
          )}
        </div>
      )}
      {(status.data?.devices.length ?? 0) > 0 && (
        <>
          <ul className="divide-y rounded-md border">
            {status.data!.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 py-1.5 pr-1 pl-3">
                <span className="min-w-0 flex-1 truncate" title={d.userAgent ?? ""}>{d.userAgent ?? "Unknown device"}</span>
                <Button variant="ghost" size="icon-sm" aria-label="Remove device" onClick={() => remove.mutate(d.id)}><X /></Button>
              </li>
            ))}
          </ul>
          <Button variant="outline" size="sm" disabled={test.isPending || unavailable} onClick={() => test.mutate()}>{test.isPending && <Loader2 className="animate-spin" />} Send a test notification</Button>
        </>
      )}
    </Section>
  );
}

// ---- delivery rules ------------------------------------------------------------------------------

function RuleSwitches({ forward, notify, onChange, label }: { forward: boolean; notify: boolean; onChange: (patch: { forward?: boolean; notify?: boolean }) => void; label: string }) {
  return (
    <>
      <span className="flex w-16 justify-center"><Switch checked={forward} aria-label={`Forward ${label}`} onCheckedChange={(v) => onChange({ forward: v })} /></span>
      <span className="flex w-16 justify-center"><Switch checked={notify} aria-label={`Notify for ${label}`} onCheckedChange={(v) => onChange({ notify: v })} /></span>
    </>
  );
}

/** Tapping flips between the two layouts a forward can have. Only meaningful while forwarding is on. */
function StyleToggle({ style, forward, onChange, label }: { style: ForwardStyle; forward: boolean; onChange: (s: ForwardStyle) => void; label: string }) {
  if (!forward) return <span className="text-muted-foreground text-xs">Not forwarded</span>;
  return (
    <button
      type="button"
      aria-label={`Forward style for ${label}: ${style === "inline" ? "inline" : "as attachment"}. Tap to change.`}
      title="Inline: the original message, so your reply quotes it. Attachment: a summary with the original attached."
      onClick={() => onChange(style === "inline" ? "attach" : "inline")}
      className="text-muted-foreground hover:text-foreground text-xs max-md:py-0.5 max-md:text-[13px]"
    >
      Forwards <span className="text-primary font-medium">{style === "inline" ? "inline" : "as attachment"}</span>
    </button>
  );
}

function RulesSection() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => get<DeliveryRules>("/mail/rules") });
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState("");

  // optimistic: a switch must answer at once
  const update = (fn: (d: DeliveryRules) => DeliveryRules) => qc.setQueryData<DeliveryRules>(["rules"], (d) => (d ? fn(d) : d));
  const settle = { onError: (err: unknown) => toast.error((err as Error).message), onSettled: () => qc.invalidateQueries({ queryKey: ["rules"] }) };
  const setRule = useMutation({
    mutationFn: (v: { address: string; forward?: boolean; notify?: boolean; forwardStyle?: ForwardStyle }) => post("/mail/rules", v),
    onMutate: (v) =>
      update((d) => ({
        ...d,
        rules: d.rules.map((r) => (r.address === v.address ? { ...r, forward: v.forward ?? r.forward, notify: v.notify ?? r.notify, forwardStyle: v.forwardStyle ?? r.forwardStyle, explicit: true } : r)),
      })),
    ...settle,
  });
  const setDefaults = useMutation({
    mutationFn: (v: { forward?: boolean; notify?: boolean; forwardStyle?: ForwardStyle }) => post("/mail/rules/defaults", v),
    onMutate: (v) => update((d) => ({ ...d, defaults: { forward: v.forward ?? d.defaults.forward, notify: v.notify ?? d.defaults.notify, forwardStyle: v.forwardStyle ?? d.defaults.forwardStyle } })),
    ...settle,
  });
  const reset = useMutation({ mutationFn: (address: string) => post("/mail/rules/reset", { address }), ...settle });
  const add = useMutation({
    mutationFn: (address: string) => post("/mail/rules", { address, forward: rules.data?.defaults.forward ?? true }),
    onSuccess: () => setAdding(""),
    ...settle,
  });

  const groups = useMemo(() => {
    const out = new Map<string, DeliveryRule[]>();
    const needle = filter.trim().toLowerCase();
    for (const r of rules.data?.rules ?? []) {
      if (needle && !r.address.includes(needle)) continue;
      const domain = r.address.slice(r.address.lastIndexOf("@") + 1);
      out.set(domain, [...(out.get(domain) ?? []), r]);
    }
    return out;
  }, [rules.data, filter]);

  if (rules.isLoading) return <Section title="Forwarding"><Loader2 className="text-muted-foreground size-5 animate-spin" /></Section>;
  if (!rules.data) return <Section title="Forwarding"><p className="text-destructive">{(rules.error as Error)?.message ?? "Could not load"}</p></Section>;
  const d = rules.data.defaults;

  return (
    <Section title="Forwarding and notifications per address" hint="Mail always lands here in the webmail. These switches decide what else happens when it arrives, and each address can forward the original inline or as an attachment.">
      <div className="text-muted-foreground flex items-center pr-1 text-xs">
        <span className="flex-1" />
        <span className="w-16 text-center">Forward</span>
        <span className="w-16 text-center">Notify</span>
      </div>
      <div className="bg-muted/60 -mt-2 flex items-center rounded-md py-2 pr-1 pl-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">New addresses</div>
          <div className="text-muted-foreground text-xs">Used the first time an address receives mail</div>
          <StyleToggle style={d.forwardStyle} forward={d.forward} label="new addresses" onChange={(forwardStyle) => setDefaults.mutate({ forwardStyle })} />
        </div>
        <RuleSwitches forward={d.forward} notify={d.notify} label="new addresses" onChange={(p) => setDefaults.mutate(p)} />
      </div>

      {rules.data.rules.length > 8 && <Input placeholder="Filter addresses" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter addresses" />}

      {[...groups.entries()].map(([domain, list]) => (
        <div key={domain}>
          <div className="text-muted-foreground mb-1 text-xs font-semibold">{domain}</div>
          <ul className="divide-y rounded-md border">
            {list.map((r) => (
              <li key={r.address} className="flex items-center py-1.5 pr-1 pl-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={r.address}>{r.address.slice(0, r.address.lastIndexOf("@"))}<span className="text-muted-foreground max-md:hidden">@{domain}</span></div>
                  <div className="flex flex-wrap items-center gap-x-2">
                    <StyleToggle style={r.forwardStyle} forward={r.forward} label={r.address} onChange={(forwardStyle) => setRule.mutate({ address: r.address, forwardStyle })} />
                    <span className="text-muted-foreground text-xs" aria-hidden>·</span>
                    {r.explicit ? (
                      <button type="button" className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline max-md:text-[13px]" onClick={() => reset.mutate(r.address)}>Reset</button>
                    ) : (
                      <span className="text-muted-foreground text-xs max-md:text-[13px]">default</span>
                    )}
                  </div>
                </div>
                <RuleSwitches forward={r.forward} notify={r.notify} label={r.address} onChange={(p) => setRule.mutate({ address: r.address, ...p })} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {rules.data.rules.length === 0 && <p className="text-muted-foreground">No addresses have received mail yet.</p>}

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.trim()) add.mutate(adding.trim().toLowerCase());
        }}
      >
        <Input type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Add a rule for another address" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Address to add a rule for" />
        <Button type="submit" variant="outline" size="sm" disabled={add.isPending || !adding.trim()}>Add</Button>
      </form>
    </Section>
  );
}

export default function MailSettings({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto text-[13px] sm:max-w-xl max-md:text-[15px]">
        <DialogHeader>
          <DialogTitle>Forwarding & notifications</DialogTitle>
          <DialogDescription>What happens when mail arrives, and how this device hears about it.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-5">
          <InstallSection />
          <NotificationsSection />
          <RulesSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
