import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { Copy, KeyRound, Loader2, MailCheck, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { get, post } from "@/lib/api";
import { fullDate } from "@/lib/format";
import { currentSubscription } from "@/lib/pwa";
import { useIdentities } from "../mail/data";
import type { PasskeyInfo, SessionInfo, SessionUser, UserInfo } from "../../shared/api";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function PasswordSection() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => post<{ emailCheck: string | null }>("/auth/password", { currentPassword: current, newPassword: next }),
    onSuccess: (res) => {
      toast.success(`Password changed. Other devices were signed out, and passkeys and notifications were removed. Add them again from this device.${res?.emailCheck ? ` Sign-in codes still go to ${res.emailCheck}: check that this is your mailbox.` : ""}`, { duration: 12000 });
      void qc.invalidateQueries({ queryKey: ["passkeys"] });
      void qc.invalidateQueries({ queryKey: ["push"] });
      setCurrent("");
      setNext("");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Section title="Password">
      <form className="grid gap-3 sm:grid-cols-2 [&>div]:min-w-0" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
        <div className="space-y-1.5">
          <Label htmlFor="pw-current">Current password</Label>
          <Input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw-new">New password</Label>
          <Input id="pw-new" type="password" autoComplete="new-password" required minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" disabled={change.isPending || next.length < 12}>{change.isPending && <Loader2 className="animate-spin" />} Change password</Button>
          <span className="text-muted-foreground ml-3 text-xs">At least 12 characters.</span>
        </div>
      </form>
    </Section>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="font-medium">Save these recovery codes now. They are shown only once.</p>
      <p className="text-muted-foreground">Each code signs you in one time in place of the authenticator code, for when you lose your phone.</p>
      <pre className="bg-background grid grid-cols-2 gap-x-6 gap-y-1 rounded border p-3 font-mono text-[13px]">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(codes.join("\n")).then(() => toast.success("Recovery codes copied"), () => toast.error("Could not copy"))}><Copy /> Copy</Button>
        <Button size="sm" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function TwoFactorSection({ user }: { user: SessionUser }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const done = (totpEnabled: boolean, message: string) => {
    qc.setQueryData<SessionUser | null>(["session"], (s) => (s ? { ...s, totpEnabled } : s));
    toast.success(message);
    setPending(null);
    setPassword("");
    setCode("");
  };
  const setup = useMutation({
    mutationFn: () => post<{ secret: string; uri: string }>("/auth/totp/setup", { currentPassword: password }),
    onSuccess: setPending,
    onError: (err) => toast.error((err as Error).message),
  });
  const enable = useMutation({
    mutationFn: () => post<{ recoveryCodes: string[] }>("/auth/totp/enable", { code }),
    onSuccess: (r) => {
      setRecovery(r.recoveryCodes);
      done(true, "Two-factor authentication is on");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const regenerate = useMutation({
    mutationFn: () => post<{ recoveryCodes: string[] }>("/auth/recovery-codes", { currentPassword: password }),
    onSuccess: (r) => {
      setRecovery(r.recoveryCodes);
      setPassword("");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const disable = useMutation({
    mutationFn: () => post("/auth/totp/disable", { currentPassword: password }),
    onSuccess: () => done(false, "Two-factor authentication is off"),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Section title="Two-factor authentication">
      {recovery ? (
        <RecoveryCodes codes={recovery} onDone={() => setRecovery(null)} />
      ) : user.totpEnabled ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
          <p className="flex items-center gap-2 text-green-700 dark:text-green-400"><ShieldCheck className="size-4" /> On. Signing in requires a code from your authenticator app, or a recovery code.</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1 space-y-1.5">
              <Label htmlFor="tf-pw">Password, to change this</Label>
              <Input id="tf-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="button" variant="outline" size="sm" disabled={regenerate.isPending || !password} onClick={() => regenerate.mutate()}>New recovery codes</Button>
            <Button type="submit" variant="outline" size="sm" disabled={disable.isPending}>Turn off</Button>
          </div>
        </form>
      ) : pending ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
          <p>Add this key to an authenticator app (1Password, Google Authenticator, Authy), then enter the code it shows.</p>
          <div className="space-y-1.5">
            <Label htmlFor="tf-secret">Setup key</Label>
            <Input id="tf-secret" readOnly value={pending.secret.replace(/(.{4})/g, "$1 ").trim()} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
            <a className="text-primary text-xs hover:underline" href={pending.uri}>Open in an authenticator app on this device</a>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="tf-code">6 digit code</Label>
              <Input id="tf-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={enable.isPending}>Turn on</Button>
          </div>
        </form>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setup.mutate(); }}>
          <p className="text-muted-foreground">Off. Recommended: require a one-time code in addition to the password.</p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="tf-pw">Password, to begin</Label>
              <Input id="tf-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={setup.isPending}>Set up</Button>
          </div>
        </form>
      )}
    </Section>
  );
}

/** A six digit code by email at every password sign-in, for accounts without an authenticator app. */
function EmailCheckSection({ user }: { user: SessionUser }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const setUser = (emailCheck: string | null) => qc.setQueryData<SessionUser | null>(["session"], (s) => (s ? { ...s, emailCheck } : s));
  const start = useMutation({
    mutationFn: () => post<{ sentTo: string }>("/auth/email-check/start", { email, currentPassword: password }),
    onSuccess: (r) => {
      setSentTo(r.sentTo);
      setPassword("");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const confirm = useMutation({
    mutationFn: () => post<{ emailCheck: string }>("/auth/email-check/confirm", { code }),
    onSuccess: (r) => {
      setUser(r.emailCheck);
      setSentTo(null);
      setCode("");
      setEmail("");
      toast.success("Sign-in codes will be sent to that mailbox");
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const disable = useMutation({
    mutationFn: () => post("/auth/email-check/disable", { currentPassword: password }),
    onSuccess: () => {
      setUser(null);
      setPassword("");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Section title="Sign-in code by email">
      {user.totpEnabled && <p className="text-muted-foreground">Not used while two-factor authentication with an authenticator app is on: that takes its place.</p>}
      {user.emailCheck ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
          <p className="flex items-center gap-2 text-green-700 dark:text-green-400"><MailCheck className="size-4" /> On. A password sign-in also needs the code sent to {user.emailCheck}. A passkey sign-in does not.</p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="ec-pw">Password, to turn it off</Label>
              <Input id="ec-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={disable.isPending}>Turn off</Button>
          </div>
        </form>
      ) : sentTo ? (
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); confirm.mutate(); }}>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="ec-code">Code sent to {sentTo}</Label>
            <Input id="ec-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={confirm.isPending}>Confirm</Button>
        </form>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
          <p className="text-muted-foreground">Off. When on, signing in with the password also needs a six digit code sent to a mailbox outside this system, such as your Outlook address.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ec-email">Send codes to</Label>
              <Input id="ec-email" type="email" autoComplete="email" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@outlook.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ec-pw">Password</Label>
              <Input id="ec-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <Button type="submit" size="sm" disabled={start.isPending}>{start.isPending && <Loader2 className="animate-spin" />} Send a code to confirm</Button>
        </form>
      )}
    </Section>
  );
}

function PasskeysSection() {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const keys = useQuery({ queryKey: ["passkeys"], queryFn: () => get<PasskeyInfo[]>("/auth/passkeys") });
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  const add = useMutation({
    mutationFn: async () => {
      const options = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/passkeys/register-options", { currentPassword: password });
      const response = await startRegistration({ optionsJSON: options });
      const device = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone or iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : /Android/.test(navigator.userAgent) ? "Android" : /Windows/.test(navigator.userAgent) ? "Windows" : "Passkey";
      await post("/auth/passkeys/register", { response, name: `${device}, added ${new Date().toLocaleDateString()}` });
    },
    onSuccess: () => {
      toast.success("Passkey added");
      setPassword("");
    },
    onError: (err) => toast.error((err as Error).name === "NotAllowedError" ? "The passkey prompt was cancelled" : (err as Error).message),
    onSettled: () => qc.invalidateQueries({ queryKey: ["passkeys"] }),
  });
  const remove = useMutation({ mutationFn: (id: string) => post("/auth/passkeys/delete", { id }), onSettled: () => qc.invalidateQueries({ queryKey: ["passkeys"] }) });
  return (
    <Section title="Passkeys">
      <p className="text-muted-foreground">Sign in with Face ID, Touch ID or your device PIN instead of typing a password and a code. A passkey only works on this site, so it cannot be phished.</p>
      {(keys.data?.length ?? 0) > 0 && (
        <ul className="divide-y rounded-md border">
          {keys.data!.map((k) => (
            <li key={k.id} className="flex items-center gap-2 py-1.5 pr-1 pl-3">
              <KeyRound className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{k.name}</div>
                <div className="text-muted-foreground text-xs">{k.lastUsedAt ? `last used ${fullDate(k.lastUsedAt)}` : "not used yet"}</div>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${k.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => window.confirm("Remove this passkey?") && remove.mutate(k.id)}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="pk-pw">Password, to add a passkey on this device</Label>
            <Input id="pk-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={add.isPending}>{add.isPending && <Loader2 className="animate-spin" />} Add passkey</Button>
        </form>
      ) : (
        <p className="text-muted-foreground">This browser does not support passkeys.</p>
      )}
    </Section>
  );
}

function UsersSection({ me }: { me: SessionUser }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => get<UserInfo[]>("/users") });
  const identities = useIdentities();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const all = identities.data?.domains ?? [];
  const settle = { onError: (err: unknown) => toast.error((err as Error).message), onSettled: () => qc.invalidateQueries({ queryKey: ["users"] }) };
  const create = useMutation({
    mutationFn: () => post("/users", { username, password, domains }),
    onSuccess: () => {
      toast.success(`${username} can now sign in`);
      setUsername("");
      setPassword("");
      setDomains([]);
    },
    ...settle,
  });
  const update = useMutation({ mutationFn: (v: { id: number; domains?: string[]; password?: string }) => post("/users/update", v), ...settle });
  const remove = useMutation({ mutationFn: (id: number) => post("/users/delete", { id }), ...settle });
  const toggle = (list: string[], d: string) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]);

  return (
    <Section title="People">
      <p className="text-muted-foreground">A member signs in separately and sees only the mail of the domains you choose: no other domains, no file drop, no settings for other addresses. Whether a message is read, flagged or archived is shared by everyone who can see it.</p>
      <ul className="divide-y rounded-md border">
        {users.data?.map((u) => (
          <li key={u.id} className="space-y-1.5 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{u.username}</span>
              <span className="text-muted-foreground text-xs">{u.role === "owner" ? (u.username === me.username ? "Owner (you)" : "Owner") : "Member"}</span>
              {u.role === "member" && (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      const next = window.prompt(`New password for ${u.username} (12 characters or more).\nThis signs them out everywhere and removes their two-factor and passkeys.`);
                      if (next) update.mutate({ id: u.id, password: next });
                    }}
                  >
                    Reset password
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${u.username}`} className="text-muted-foreground hover:text-destructive" onClick={() => window.confirm(`Remove ${u.username}? They will be signed out at once.`) && remove.mutate(u.id)}><Trash2 /></Button>
                </>
              )}
            </div>
            {u.role === "member" && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {all.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={u.domains?.includes(d) ?? false} onChange={() => { const next = toggle(u.domains ?? [], d); if (next.length) update.mutate({ id: u.id, domains: next }); else toast.error("A member needs at least one domain"); }} />
                    {d}
                  </label>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <form className="space-y-2 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="flex items-center gap-2 font-medium"><UserPlus className="size-4" /> Add a member</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Username" placeholder="Username" autoCapitalize="none" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <Input aria-label="Temporary password" placeholder="Temporary password (12+ characters)" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {all.map((d) => (
            <label key={d} className="flex items-center gap-1.5">
              <input type="checkbox" checked={domains.includes(d)} onChange={() => setDomains(toggle(domains, d))} />
              {d}
            </label>
          ))}
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={create.isPending || domains.length === 0 || password.length < 12 || !username.trim()}>Add member</Button>
      </form>
    </Section>
  );
}

function SessionsSection() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get<SessionInfo[]>("/auth/sessions") });
  const revoke = useMutation({
    mutationFn: async () => post("/auth/sessions/revoke-others", { keepPushEndpoint: (await currentSubscription().catch(() => null))?.endpoint }),
    onSuccess: () => {
      toast.success("Other devices were signed out");
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });
  return (
    <Section title="Signed-in devices">
      <ul className="divide-y rounded-md border">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate" title={s.userAgent ?? ""}>{s.userAgent ?? "Unknown browser"}</div>
              <div className="text-muted-foreground text-xs">{s.ip ?? "unknown address"} · last active {fullDate(s.lastSeenAt)}</div>
            </div>
            {s.current && <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs">This device</span>}
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" disabled={revoke.isPending || (sessions.data?.length ?? 0) < 2} onClick={() => revoke.mutate()}>Sign out other devices</Button>
    </Section>
  );
}

export default function SettingsDialog({ user, onClose }: { user: SessionUser; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto text-[13px] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Security{user.role === "owner" ? " and people" : ""}</DialogTitle>
          <DialogDescription>Signed in as {user.username}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-5">
          <PasskeysSection />
          <EmailCheckSection user={user} />
          <PasswordSection />
          <TwoFactorSection user={user} />
          <SessionsSection />
          {user.role === "owner" && <UsersSection me={user} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
