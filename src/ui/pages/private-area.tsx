import { lazy, useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { BellRing, FolderOpen, KeyRound, Loader2, LogOut, Mail, Settings, ShieldCheck, User, Users, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { get, post, setUnauthenticatedHandler } from "@/lib/api";
import { currentSubscription, serviceWorker } from "@/lib/pwa";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import MailPage from "../mail/mail-page";

const FilesPage = lazy(() => import("../files/files-page"));
const CodesPage = lazy(() => import("../codes/codes-page"));
const PeoplePage = lazy(() => import("../people/people-page"));
const SettingsDialog = lazy(() => import("../settings/settings-dialog"));
const MailSettings = lazy(() => import("../settings/mail-settings"));

type Section = "mail" | "people" | "files" | "codes";

function SectionSwitch({ section, files }: { section: Section; files: boolean }) {
  const tab = (to: string, key: Section, label: string, icon: React.ReactNode) => (
    <Link
      to={to}
      aria-current={section === key ? "page" : undefined}
      className={cn("flex h-6 flex-auto items-center justify-center gap-1 rounded-[5px] px-0.5 text-[11px] font-medium whitespace-nowrap max-md:h-9 max-md:gap-1.5 max-md:rounded-lg max-md:px-1 max-md:text-[15px]", section === key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
  return (
    // @container: when the sidebar is narrowed, the tabs keep their icons and drop the words
    <div className="@container flex h-[52px] shrink-0 items-center px-3 max-md:h-14">
      <div className="bg-foreground/[0.07] flex w-full gap-0.5 rounded-md p-0.5 max-md:rounded-[10px] [&_a>svg]:shrink-0 @max-[216px]:[&_a>span]:hidden">
        {tab("/mail", "mail", "Mail", <Mail className="size-3.5" />)}
        {tab("/people", "people", "People", <Users className="size-3.5" />)}
        {files && tab("/files", "files", "Files", <FolderOpen className="size-3.5" />)}
        {tab("/codes", "codes", "Codes", <ShieldCheck className="size-3.5" />)}
      </div>
    </div>
  );
}

interface AccountActions {
  username: string;
  onSettings: () => void;
  onMailSettings: () => void;
  onSignOut: () => void;
}

/** The account menu. On the desktop it is a row at the foot of the sidebar; on a phone it is the last tab. */
function AccountMenu({ username, onSettings, onMailSettings, onSignOut, asTab }: AccountActions & { asTab?: boolean }) {
  return (
    <div className={asTab ? "flex flex-1" : "shrink-0 border-t p-2"}>
      <DropdownMenu>
        {asTab ? (
          <DropdownMenuTrigger aria-label="Account" className="text-muted-foreground flex h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] outline-none active:bg-accent">
            <User className="size-[22px]" />
            Account
          </DropdownMenuTrigger>
        ) : (
          <DropdownMenuTrigger className="hover:bg-sidebar-hover text-sidebar-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            <User className="text-muted-foreground size-4" />
            <span className="min-w-0 flex-1 truncate">{username}</span>
          </DropdownMenuTrigger>
        )}
        <DropdownMenuContent side="top" align={asTab ? "end" : "start"} className="w-64 max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[16px]">
          <DropdownMenuLabel className="text-muted-foreground text-xs">Signed in as {username}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onMailSettings}><BellRing /> Mail settings…</DropdownMenuItem>
          <DropdownMenuItem onSelect={onSettings}><Settings /> Security and people…</DropdownMenuItem>
          <DropdownMenuItem asChild><Link to="/"><User /> Public site</Link></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut}><LogOut /> Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Phone: a tab bar along the bottom, so Mail, Files and Codes are always one tap away. */
function MobileTabs({ section, files, account }: { section: Section; files: boolean; account: AccountActions }) {
  const tab = (to: string, key: Section, label: string, icon: React.ReactNode) => (
    <Link to={to} aria-current={section === key ? "page" : undefined} className={cn("flex h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] active:bg-accent", section === key ? "text-primary font-semibold" : "text-muted-foreground")}>
      {icon}
      {label}
    </Link>
  );
  return (
    <nav aria-label="Sections" className="bg-background pb-safe shrink-0 border-t">
      <div className="flex">
        {tab("/mail", "mail", "Mail", <Mail className="size-[22px]" />)}
        {tab("/people", "people", "People", <Users className="size-[22px]" />)}
        {files && tab("/files", "files", "Files", <FolderOpen className="size-[22px]" />)}
        {tab("/codes", "codes", "Codes", <ShieldCheck className="size-[22px]" />)}
        <AccountMenu {...account} asTab />
      </div>
    </nav>
  );
}

const PASSKEY_OFFER = "eisenmail.offerPasskey";
const PASSKEY_DISMISSED = "eisenmail.passkeyOfferDismissed";

/**
 * Right after a password sign-in on a device that has no passkey yet: offer to add one, the way
 * GitHub does. The server accepts this without the password for a few minutes after sign-in.
 */
function PasskeyOffer({ fresh }: { fresh: boolean }) {
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  const [open, setOpen] = useState(() => supported && fresh && sessionStorage.getItem(PASSKEY_OFFER) === "1" && localStorage.getItem(PASSKEY_DISMISSED) !== "1");
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const close = (forget: boolean) => {
    sessionStorage.removeItem(PASSKEY_OFFER);
    if (forget) localStorage.setItem(PASSKEY_DISMISSED, "1");
    setOpen(false);
  };
  const add = async () => {
    setBusy(true);
    try {
      const options = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/passkeys/register-options", {});
      const response = await startRegistration({ optionsJSON: options });
      const device = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone or iPad" : /Mac/.test(navigator.userAgent) ? "Mac" : /Android/.test(navigator.userAgent) ? "Android" : /Windows/.test(navigator.userAgent) ? "Windows" : "Passkey";
      await post("/auth/passkeys/register", { response, name: `${device}, added ${new Date().toLocaleDateString()}` });
      toast.success("Passkey added. Next time, choose \"Sign in with a passkey\".");
      close(true);
    } catch (err) {
      if ((err as Error).name !== "NotAllowedError") toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="region" aria-label="Add a passkey" className="bg-popover text-popover-foreground fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-50 mx-auto max-w-md rounded-xl border p-4 shadow-lg md:right-4 md:bottom-4 md:left-auto md:mx-0">
      <div className="flex items-start gap-3">
        <KeyRound className="text-primary mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1 text-[13px] max-md:text-[15px]">
          <div className="font-semibold">Sign in faster and more safely next time</div>
          <p className="text-muted-foreground mt-0.5">Add a passkey on this device and sign in with Face ID, Touch ID or your PIN. No password, no emailed code, and nothing a fake site could capture.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void add()}>{busy && <Loader2 className="animate-spin" />} Add a passkey</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => close(true)}>Not on this device</Button>
          </div>
        </div>
        <button type="button" aria-label="Later" onClick={() => close(false)} className="text-muted-foreground -mt-1 -mr-1 flex size-8 items-center justify-center"><X className="size-4" /></button>
      </div>
    </div>
  );
}

export default function PrivateArea({ section }: { section: Section }) {
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [settings, setSettings] = useState(false);
  const [mailSettings, setMailSettings] = useState(false);

  // The service worker (push notifications) is only registered for the signed-in area. When a
  // notification is tapped while the app is open, the worker asks the app to go to the mailbox.
  useEffect(() => {
    if (!session.data) return;
    void serviceWorker();
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type === "eisenmail:navigate" && typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")) {
        navigate(data.url);
        void qc.invalidateQueries({ queryKey: ["mailboxes"] });
        void qc.invalidateQueries({ queryKey: ["messages"] });
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [session.data, navigate, qc]);

  // If the server ever answers "not signed in" (expired or revoked session), drop back to the login page.
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      qc.setQueryData(["session"], null);
    });
    return () => setUnauthenticatedHandler(null);
  }, [qc]);

  // Offer a passkey only where there is none yet.
  const passkeys = useQuery({ queryKey: ["passkeys"], queryFn: () => get<unknown[]>("/auth/passkeys"), enabled: !!session.data?.fresh, staleTime: 60_000 });

  useEffect(() => {
    document.title = section === "mail" ? "Mail" : section === "files" ? "Files" : "Codes";
    return () => {
      document.title = "Sam Eisenberg";
    };
  }, [section]);

  if (session.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (!session.data) return <Navigate to="/login" replace />;

  const signOut = async () => {
    // a signed-out device should stop getting notifications
    const sub = await currentSubscription().catch(() => null);
    await post("/auth/logout", { pushEndpoint: sub?.endpoint }).catch(() => {});
    await sub?.unsubscribe().catch(() => {});
    qc.clear();
    navigate("/login", { replace: true });
  };

  const owner = session.data.role === "owner";
  // the file drop belongs to the owner
  if (section === "files" && !owner) return <Navigate to="/mail" replace />;
  const account: AccountActions = { username: session.data.username, onSettings: () => setSettings(true), onMailSettings: () => setMailSettings(true), onSignOut: signOut };
  const header = <SectionSwitch section={section} files={owner} />;
  const footer = <AccountMenu {...account} />;
  const tabs = <MobileTabs section={section} files={owner} account={account} />;

  return (
    <TooltipProvider delayDuration={500}>
      <div className="h-app overflow-hidden">
        {section === "mail" ? <MailPage header={header} footer={footer} tabs={tabs} /> : section === "people" ? <PeoplePage header={header} footer={footer} tabs={tabs} /> : section === "files" ? <FilesPage header={header} footer={footer} tabs={tabs} /> : <CodesPage header={header} footer={footer} tabs={tabs} />}
      </div>
      {settings && <SettingsDialog user={session.data} onClose={() => setSettings(false)} />}
      {mailSettings && <MailSettings user={session.data} onClose={() => setMailSettings(false)} />}
      {passkeys.data?.length === 0 && <PasskeyOffer fresh={!!session.data.fresh} />}
      <Toaster position="bottom-right" mobileOffset={{ bottom: "calc(env(safe-area-inset-bottom) + 64px)" }} />
    </TooltipProvider>
  );
}
