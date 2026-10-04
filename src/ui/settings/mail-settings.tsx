import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BellOff, BellRing, Ellipsis, Loader2, Share, Smartphone, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { get, post } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushSupport, useInstall } from "@/lib/pwa";
import { listDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryRule, DeliveryRules, FilterAction, ForwardStyle, MailSettings as Settings, PushStatus, SessionUser } from "../../shared/api";

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

function RulesSection({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => get<DeliveryRules>("/mail/rules") });
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState("");

  // optimistic: a switch must answer at once
  const update = (fn: (d: DeliveryRules) => DeliveryRules) => qc.setQueryData<DeliveryRules>(["rules"], (d) => (d ? fn(d) : d));
  const settle = { onError: (err: unknown) => toast.error((err as Error).message), onSettled: () => qc.invalidateQueries({ queryKey: ["rules"] }) };
  const setRule = useMutation({
    mutationFn: (v: { address: string; forward?: boolean; notify?: boolean; forwardStyle?: ForwardStyle; forwardTo?: string[]; blocked?: boolean; note?: string }) => post("/mail/rules", v),
    onMutate: (v) =>
      update((d) => ({
        ...d,
        rules: d.rules.map((r) =>
          r.address === v.address
            ? { ...r, forward: v.forward ?? r.forward, notify: v.notify ?? r.notify, forwardStyle: v.forwardStyle ?? r.forwardStyle, forwardTo: v.forwardTo ?? r.forwardTo, blocked: v.blocked ?? r.blocked, note: v.note ?? r.note, explicit: true }
            : r,
        ),
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
    <Section title="Addresses" hint="Mail always lands here in the webmail. The switches decide what else happens when it arrives. Use the menu on an address to note who you gave it to, or to block it if it starts getting spam.">
      <div className="text-muted-foreground flex items-center pr-9 text-xs">
        <span className="flex-1" />
        <span className="w-16 text-center">Forward</span>
        <span className="w-16 text-center">Notify</span>
      </div>
      <div className="bg-muted/60 -mt-2 flex items-center rounded-md py-2 pr-9 pl-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">New addresses</div>
          <div className="text-muted-foreground text-xs">Used the first time an address receives mail</div>
          {owner && <StyleToggle style={d.forwardStyle} forward={d.forward} label="new addresses" onChange={(forwardStyle) => setDefaults.mutate({ forwardStyle })} />}
        </div>
        {owner ? <RuleSwitches forward={d.forward} notify={d.notify} label="new addresses" onChange={(p) => setDefaults.mutate(p)} /> : <span className="text-muted-foreground pr-3 text-xs">Set by the owner</span>}
      </div>

      {rules.data.rules.length > 8 && <Input placeholder="Filter addresses" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter addresses" />}

      {[...groups.entries()].map(([domain, list]) => (
        <div key={domain}>
          <div className="text-muted-foreground mb-1 text-xs font-semibold">{domain}</div>
          <ul className="divide-y rounded-md border">
            {list.map((r) => (
              <li key={r.address} className={cn("flex items-center py-1.5 pr-1 pl-3", r.blocked && "bg-destructive/5")}>
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={r.address}>
                    <span className={cn(r.blocked && "line-through opacity-70")}>{r.address.slice(0, r.address.lastIndexOf("@"))}<span className="text-muted-foreground max-md:hidden">@{domain}</span></span>
                    {r.blocked && <span className="bg-destructive/15 text-destructive ml-2 rounded px-1.5 py-0.5 text-[11px] font-medium no-underline">Blocked{r.blockedCount ? ` · ${r.blockedCount} dropped` : ""}</span>}
                  </div>
                  {r.note && <div className="truncate text-xs italic" title={r.note}>{r.note}</div>}
                  {r.forwardTo.length > 0 && (
                    <div className={cn("text-primary truncate text-xs max-md:text-[13px] max-md:whitespace-normal max-md:wrap-anywhere", !r.forward && "opacity-60")} title={r.forwardTo.join(", ")}>
                      <Users className="mr-1 inline size-3 align-[-1px]" aria-hidden />
                      Forwards to {r.forwardTo.join(", ")}
                    </div>
                  )}
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs max-md:text-[13px]">
                    {!r.blocked && <StyleToggle style={r.forwardStyle} forward={r.forward} label={r.address} onChange={(forwardStyle) => setRule.mutate({ address: r.address, forwardStyle })} />}
                    {!r.blocked && <span aria-hidden>·</span>}
                    <span>{r.total ? `${r.total} message${r.total === 1 ? "" : "s"}${r.lastReceived ? `, last ${listDate(r.lastReceived)}` : ""}` : "no mail yet"}</span>
                  </div>
                </div>
                {!r.blocked && <RuleSwitches forward={r.forward} notify={r.notify} label={r.address} onChange={(p) => setRule.mutate({ address: r.address, ...p })} />}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`More for ${r.address}`} className="text-muted-foreground"><Ellipsis /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60 max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[15px]">
                    <DropdownMenuItem
                      onSelect={() => {
                        const note = window.prompt(`Note for ${r.address}\n(for example who you gave this address to)`, r.note);
                        if (note !== null) setRule.mutate({ address: r.address, note });
                      }}
                    >
                      {r.note ? "Edit note…" : "Add a note…"}
                    </DropdownMenuItem>
                    {owner && (
                      <DropdownMenuItem
                        onSelect={() => {
                          const answer = window.prompt(
                            `Forward mail for ${r.address} to\n(one or more mailboxes outside this system, separated by commas; each can also reply as this address. Leave empty for your default mailbox.)`,
                            r.forwardTo.join(", "),
                          );
                          if (answer !== null) setRule.mutate({ address: r.address, forwardTo: answer.split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean) });
                        }}
                      >
                        {r.forwardTo.length ? "Change who it forwards to…" : "Forward to other mailboxes…"}
                      </DropdownMenuItem>
                    )}
                    {!owner ? null : r.blocked ? (
                      <DropdownMenuItem onSelect={() => setRule.mutate({ address: r.address, blocked: false })}>Unblock this address</DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          if (window.confirm(`Block ${r.address}?\n\nMail sent to it will be dropped on arrival: not stored, not forwarded, no notification. Mail already received is kept.`)) setRule.mutate({ address: r.address, blocked: true });
                        }}
                      >
                        <Ban /> Block this address…
                      </DropdownMenuItem>
                    )}
                    {r.explicit && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => reset.mutate(r.address)}>Reset to the defaults</DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
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

// ---- signature -------------------------------------------------------------------------------------

function SignatureSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [text, setText] = useState(settings.signature);
  const save = useMutation({
    mutationFn: () => post("/mail/settings", { signature: text }),
    onSuccess: () => {
      toast.success("Signature saved");
      void qc.invalidateQueries({ queryKey: ["mail-settings"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Section title="Signature" hint="Added under your text in new messages and replies. You can edit or remove it in each message.">
      <textarea aria-label="Signature" rows={3} value={text} onChange={(e) => setText(e.target.value)} className="border-input bg-background w-full rounded-md border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder={"Your name\nYour company"} />
      <Button size="sm" variant="outline" disabled={save.isPending || text === settings.signature} onClick={() => save.mutate()}>Save signature</Button>
    </Section>
  );
}

// ---- filters -----------------------------------------------------------------------------------------

const ACTION_LABEL: Record<FilterAction, string> = { archive: "Archive it", read: "Mark it as read", flag: "Flag it", junk: "Move it to Junk", trash: "Move it to Trash" };

function FiltersSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [address, setAddress] = useState("");
  const [action, setAction] = useState<FilterAction>("archive");
  const done = { onError: (err: unknown) => toast.error((err as Error).message), onSettled: () => qc.invalidateQueries({ queryKey: ["mail-settings"] }) };
  const add = useMutation({
    mutationFn: () => post("/mail/filters", { matchFrom: from, matchSubject: subject, matchAddress: address, action }),
    onSuccess: () => {
      setFrom("");
      setSubject("");
      setAddress("");
    },
    ...done,
  });
  const toggle = useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => post("/mail/filters/update", v), ...done });
  const remove = useMutation({ mutationFn: (id: string) => post("/mail/filters/delete", { id }), ...done });
  const describe = (f: Settings["filters"][number]) =>
    [f.matchFrom && `from contains "${f.matchFrom}"`, f.matchSubject && `subject contains "${f.matchSubject}"`, f.matchAddress && `sent to "${f.matchAddress}"`].filter(Boolean).join(" and ");

  return (
    <Section title="Filters" hint="Applied to new mail as it arrives in the webmail. Filters do not change forwarding or notifications; use the address switches for that.">
      {settings.filters.length > 0 && (
        <ul className="divide-y rounded-md border">
          {settings.filters.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-1.5 pr-1 pl-3">
              <div className={cn("min-w-0 flex-1", !f.enabled && "opacity-50")}>
                <div className="truncate">If {describe(f)}</div>
                <div className="text-muted-foreground text-xs">{ACTION_LABEL[f.action]}</div>
              </div>
              <Switch checked={f.enabled} aria-label="Filter enabled" onCheckedChange={(enabled) => toggle.mutate({ id: f.id, enabled })} />
              <Button variant="ghost" size="icon-sm" aria-label="Delete filter" className="text-muted-foreground hover:text-destructive" onClick={() => remove.mutate(f.id)}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Input placeholder="From contains" aria-label="From contains" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input placeholder="Subject contains" aria-label="Subject contains" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <Input placeholder="Sent to address contains" aria-label="Sent to address contains" value={address} onChange={(e) => setAddress(e.target.value)} autoCapitalize="none" />
        <div className="flex gap-2">
          <select aria-label="Then" value={action} onChange={(e) => setAction(e.target.value as FilterAction)} className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2">
            {(Object.keys(ACTION_LABEL) as FilterAction[]).map((a) => (
              <option key={a} value={a}>{ACTION_LABEL[a]}</option>
            ))}
          </select>
          <Button type="submit" variant="outline" size="sm" className="h-9" disabled={add.isPending || (!from.trim() && !subject.trim() && !address.trim())}>Add filter</Button>
        </div>
      </form>
    </Section>
  );
}

export default function MailSettings({ user, onClose }: { user: SessionUser; onClose: () => void }) {
  const settings = useQuery({ queryKey: ["mail-settings"], queryFn: () => get<Settings>("/mail/settings") });
  const owner = user.role === "owner";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto text-[13px] sm:max-w-xl max-md:text-[15px]">
        <DialogHeader>
          <DialogTitle>Mail settings</DialogTitle>
          <DialogDescription>Addresses, forwarding, notifications, filters and your signature.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-5">
          <InstallSection />
          <NotificationsSection />
          <RulesSection owner={owner} />
          {settings.data && owner && <FiltersSection settings={settings.data} />}
          {settings.data && <SignatureSection settings={settings.data} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
