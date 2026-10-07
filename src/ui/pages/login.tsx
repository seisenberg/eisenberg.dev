import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, Loader2, Lock } from "lucide-react";
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
  /** set when the second step is a code sent by email: the text says where it went */
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.data) return <Navigate to="/mail" replace />;

  const passkeysSupported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  async function passkey() {
    setBusy(true);
    setError(null);
    try {
      const options = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/auth/passkey/login-options");
      const response = await startAuthentication({ optionsJSON: options });
      const user = await post<SessionUser>("/auth/passkey/login", { response });
      queryClient.setQueryData(["session"], user);
      navigate("/mail", { replace: true });
    } catch (err) {
      // cancelling the system prompt is not an error worth showing
      if ((err as Error).name !== "NotAllowedError") setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await post<SessionUser>("/auth/login", { username, password, code: needsCode && code ? code : undefined });
      // after a password sign-in the app offers to add a passkey on this device
      sessionStorage.setItem("eisenmail.offerPasskey", "1");
      queryClient.setQueryData(["session"], user);
      navigate("/mail", { replace: true });
    } catch (err) {
      const failure = err as ApiFailure;
      if (failure.code === "totp_required") {
        setNeedsCode(true);
      } else if (failure.code === "email_code_required") {
        setNeedsCode(true);
        setEmailHint(failure.message);
        setCode("");
      } else {
        setError(failure.message);
        if (failure.code === "bad_totp" || failure.code === "bad_email_code") setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-muted/40 flex min-h-full flex-col text-sm">
      {/* the status bar strip on a phone, in the page's own colour (see .top-bar in index.css) */}
      <div className="top-bar pt-safe md:hidden" style={{ backgroundColor: "color-mix(in srgb, var(--muted) 40%, var(--background))" }} />
      <div className="flex flex-1 items-center justify-center p-6">
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
                <Label htmlFor="code">{emailHint ? "Code from your email" : "Authentication code"}</Label>
                <Input id="code" name="code" autoComplete="one-time-code" autoCapitalize="none" inputMode={emailHint ? "numeric" : undefined} maxLength={24} placeholder={emailHint ? "6 digit code" : "6 digit code, or a recovery code"} autoFocus required value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
                {emailHint && (
                  <p className="text-muted-foreground text-xs">
                    {emailHint}.{" "}
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      disabled={busy}
                      onClick={() => {
                        // asking again without a code sends a new one (at most one a minute)
                        setCode("");
                        void post("/auth/login", { username, password }).catch((err: ApiFailure) => setError(err.code === "email_code_required" ? null : err.message));
                      }}
                    >
                      Send a new code
                    </button>
                  </p>
                )}
              </div>
            )}
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} Sign in
            </Button>
          </form>
          {passkeysSupported && (
            <>
              <div className="text-muted-foreground my-4 flex items-center gap-3 text-xs"><span className="bg-border h-px flex-1" />or<span className="bg-border h-px flex-1" /></div>
              <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void passkey()}><KeyRound /> Sign in with a passkey</Button>
            </>
          )}
        </div>
        <p className="text-muted-foreground mt-6 text-center">
          <Link to="/" className="hover:text-foreground">Back to eisenberg.dev</Link>
        </p>
      </div>
      </div>
    </div>
  );
}
