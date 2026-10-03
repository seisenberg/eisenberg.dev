import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { get, post } from "@/lib/api";
import { fullDate } from "@/lib/format";
import type { SessionInfo, SessionUser } from "../../shared/api";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => post("/auth/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success("Password changed. Other devices were signed out.");
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

function TwoFactorSection({ user }: { user: SessionUser }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
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
    mutationFn: () => post("/auth/totp/enable", { code }),
    onSuccess: () => done(true, "Two-factor authentication is on"),
    onError: (err) => toast.error((err as Error).message),
  });
  const disable = useMutation({
    mutationFn: () => post("/auth/totp/disable", { currentPassword: password }),
    onSuccess: () => done(false, "Two-factor authentication is off"),
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Section title="Two-factor authentication">
      {user.totpEnabled ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
          <p className="flex items-center gap-2 text-green-700 dark:text-green-400"><ShieldCheck className="size-4" /> On. Signing in requires a code from your authenticator app.</p>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="tf-pw">Password, to turn it off</Label>
              <Input id="tf-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
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

function SessionsSection() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get<SessionInfo[]>("/auth/sessions") });
  const revoke = useMutation({
    mutationFn: () => post("/auth/sessions/revoke-others"),
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
          <DialogTitle>Security settings</DialogTitle>
          <DialogDescription>Signed in as {user.username}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-5">
          <PasswordSection />
          <TwoFactorSection user={user} />
          <SessionsSection />
        </div>
      </DialogContent>
    </Dialog>
  );
}
