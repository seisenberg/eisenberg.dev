import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiFailure, post } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { SessionUser } from "../../shared/api";

export default function Login() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.data) return <Navigate to="/mail" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await post<SessionUser>("/auth/login", { username, password, code: needsCode ? code : undefined });
      queryClient.setQueryData(["session"], user);
      navigate("/mail", { replace: true });
    } catch (err) {
      const failure = err as ApiFailure;
      if (failure.code === "totp_required") {
        setNeedsCode(true);
      } else {
        setError(failure.message);
        if (failure.code === "bad_totp") setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-muted/40 flex min-h-full items-center justify-center p-6 text-sm">
      <div className="w-full max-w-sm">
        <div className="bg-card rounded-2xl border p-8 shadow-sm">
          <div className="bg-primary/10 text-primary mb-5 flex size-11 items-center justify-center rounded-xl">
            <Lock className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Private area</h1>
          <p className="text-muted-foreground mt-1 mb-6">Sign in to mail and files.</p>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </div>
            {needsCode && (
              <div className="space-y-1.5">
                <Label htmlFor="code">Authentication code</Label>
                <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="6 digit code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
              </div>
            )}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} Sign in
            </Button>
          </form>
        </div>
        <p className="text-muted-foreground mt-6 text-center">
          <Link to="/" className="hover:text-foreground">Back to eisenberg.dev</Link>
        </p>
      </div>
    </div>
  );
}
