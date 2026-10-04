import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ClipboardPaste, Copy, Ellipsis, ImageUp, KeyRound, Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/use-mobile";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OtpEntry, OtpListing } from "../../shared/api";

// The authenticator: one-time codes for other services. The secrets stay on the server, encrypted;
// this page only ever receives the current codes.

/**
 * Reads a QR code out of a photo or screenshot, here in the browser: the picture is not uploaded.
 * Phone photos are large and often slightly blurred, so a few sizes are tried.
 */
async function readQr(file: File): Promise<string | null> {
  const { default: jsQR } = await import("jsqr");
  const bitmap = await createImageBitmap(file);
  try {
    for (const longest of [1200, 800, 2000, 500]) {
      const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
      if (found?.data) return found.data;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

const spaced = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code);

function EntryCard({ entry, age, onRename, onDelete }: { entry: OtpEntry; age: number; onRename: () => void; onDelete: () => void }) {
  const left = Math.max(0, entry.remaining - age);
  // once the time is up the "next" code is the current one, until the list is fetched again
  const code = left > 0 ? entry.code : entry.next;
  const closing = left > 0 && left <= 5;
  const copy = () => navigator.clipboard.writeText(code).then(() => toast.success(`Code for ${entry.issuer || entry.account || "account"} copied`), () => toast.error("Could not copy"));
  if (!entry.code) {
    return (
      <li className="flex items-center gap-3 border-b px-5 py-3 max-md:px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{entry.issuer || "Account"}</div>
          <div className="text-destructive text-xs">This entry cannot be read with the server's current key. Remove it and add the account again.</div>
        </div>
        <Button variant="ghost" size="sm" onClick={onDelete}>Remove</Button>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-3 border-b px-5 py-3 max-md:px-4">
      <button type="button" onClick={() => void copy()} aria-label={`Copy code for ${entry.issuer} ${entry.account}`} className="min-w-0 flex-1 text-left">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold max-md:text-[16px]">{entry.issuer || "Account"}</span>
          <span className="text-muted-foreground truncate text-xs max-md:text-[13px]">{entry.account}</span>
        </div>
        <div className={cn("font-mono text-[28px] leading-tight font-semibold tracking-wider tabular-nums max-md:text-[32px]", closing ? "text-destructive" : "text-primary")}>{spaced(code)}</div>
        {closing && <div className="text-muted-foreground text-xs">Next: <span className="font-mono tabular-nums">{spaced(entry.next)}</span></div>}
      </button>
      <div className="flex shrink-0 flex-col items-center gap-1" aria-label={`${left} seconds left`}>
        <svg viewBox="0 0 36 36" className="size-8 -rotate-90">
          <circle cx="18" cy="18" r="15" fill="none" strokeWidth="4" className="stroke-muted" />
          <circle cx="18" cy="18" r="15" fill="none" strokeWidth="4" strokeLinecap="round" pathLength={100} strokeDasharray={`${Math.max(0, (left / entry.period) * 100)} 100`} className={cn("transition-[stroke-dasharray] duration-1000 ease-linear", closing ? "stroke-destructive" : "stroke-primary")} />
        </svg>
        <span className="text-muted-foreground text-[11px] tabular-nums">{left}s</span>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Copy" className="text-muted-foreground max-md:hidden" onClick={() => void copy()}><Copy /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More for ${entry.issuer} ${entry.account}`} className="text-muted-foreground"><Ellipsis /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[15px]">
          <DropdownMenuItem onSelect={onRename}>Rename…</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>Remove…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [manual, setManual] = useState({ issuer: "", account: "", secret: "" });

  const add = useMutation({
    mutationFn: (body: { uris?: string[]; manual?: typeof manual }) => post<{ added: number }>("/codes", body),
    onSuccess: (r) => {
      toast.success(r.added === 1 ? "Account added" : `${r.added} accounts added`);
      void qc.invalidateQueries({ queryKey: ["codes"] });
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const fromImage = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await readQr(file);
      if (!text) toast.error("No QR code was found in that picture. Fill the frame with the code and try again.");
      else if (!/^otpauth(-migration)?:\/\//i.test(text)) toast.error("That QR code is not an authenticator setup code.");
      else add.mutate({ uris: [text] });
    } catch {
      toast.error("That picture could not be read.");
    } finally {
      setBusy(false);
    }
  };
  const working = busy || add.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto text-[13px] sm:max-w-md max-md:text-[15px]">
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>Scan the QR code a site shows when you set up an authenticator app.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <Button className="h-11" disabled={working} onClick={() => camera.current?.click()}>{working ? <Loader2 className="animate-spin" /> : <Camera />} Take a picture of the QR code</Button>
            <Button variant="outline" className="h-11" disabled={working} onClick={() => picker.current?.click()}><ImageUp /> Choose a picture or screenshot</Button>
            {/* capture opens the camera directly on a phone; on a computer it is a normal file picker */}
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="Take a picture of a QR code" onChange={(e) => { void fromImage(e.target.files?.[0]); e.target.value = ""; }} />
            <input ref={picker} type="file" accept="image/*" hidden aria-label="Choose a picture of a QR code" onChange={(e) => { void fromImage(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          <p className="text-muted-foreground text-xs">The picture is read on this device and is not uploaded. A Google Authenticator "Transfer accounts" export code works too and adds every account in it.</p>

          <form className="space-y-1.5 border-t pt-4" onSubmit={(e) => { e.preventDefault(); add.mutate({ uris: pasted.split(/\s+/).filter(Boolean) }); }}>
            <Label htmlFor="otp-paste">Or paste a setup link</Label>
            <div className="flex gap-2">
              <Input id="otp-paste" placeholder="otpauth://totp/..." value={pasted} onChange={(e) => setPasted(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <Button type="submit" variant="outline" disabled={working || !pasted.trim()}><ClipboardPaste /> Add</Button>
            </div>
          </form>

          <form className="space-y-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); add.mutate({ manual }); }}>
            <div className="font-medium">Or enter the key by hand</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Service" placeholder="Service (for example GitHub)" value={manual.issuer} onChange={(e) => setManual({ ...manual, issuer: e.target.value })} />
              <Input aria-label="Account" placeholder="Account (for example your email)" value={manual.account} onChange={(e) => setManual({ ...manual, account: e.target.value })} autoCapitalize="none" />
            </div>
            <div className="flex gap-2">
              <Input aria-label="Setup key" placeholder="Setup key" className="font-mono" value={manual.secret} onChange={(e) => setManual({ ...manual, secret: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <Button type="submit" variant="outline" disabled={working || manual.secret.replace(/\s/g, "").length < 16}>Add</Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CodesPage({ header, footer, tabs }: { header: React.ReactNode; footer: React.ReactNode; tabs: React.ReactNode }) {
  const mobile = useIsMobile();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const listing = useQuery({ queryKey: ["codes"], queryFn: () => get<OtpListing>("/codes"), staleTime: 0, refetchOnWindowFocus: true });

  // A clock that ticks every second, counted from when the codes were fetched. When the first
  // code runs out, fetch fresh ones.
  const fetchedAt = listing.dataUpdatedAt;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const age = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  const soonest = Math.min(...(listing.data?.entries.filter((e) => e.code).map((e) => e.remaining) ?? [Infinity]));
  useEffect(() => {
    if (Number.isFinite(soonest) && age >= soonest && !listing.isFetching) void listing.refetch();
  }, [age, soonest]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = useMutation({ mutationFn: (id: string) => post("/codes/delete", { id }), onSettled: () => qc.invalidateQueries({ queryKey: ["codes"] }) });
  const rename = useMutation({ mutationFn: (v: { id: string; issuer: string; account: string }) => post("/codes/rename", v), onSettled: () => qc.invalidateQueries({ queryKey: ["codes"] }) });
  const onRename = (e: OtpEntry) => {
    const issuer = window.prompt("Service name", e.issuer);
    if (issuer === null) return;
    const account = window.prompt("Account", e.account);
    if (account !== null) rename.mutate({ id: e.id, issuer, account });
  };
  const onDelete = (e: OtpEntry) => {
    if (window.confirm(`Remove ${e.issuer || "this account"}${e.account ? ` (${e.account})` : ""}?\n\nYou will no longer be able to get its codes here. Make sure you have another way in to that service first.`)) remove.mutate(e.id);
  };

  const needle = filter.trim().toLowerCase();
  const entries = (listing.data?.entries ?? []).filter((e) => !needle || `${e.issuer} ${e.account}`.toLowerCase().includes(needle));
  const total = listing.data?.entries.length ?? 0;

  const main = (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 items-center gap-3 border-b", mobile ? "pt-safe px-4 pb-2" : "h-[52px] px-5")}>
        <div className={cn("min-w-0 flex-1", mobile && "pt-3")}>
          <h1 className={cn("font-bold", mobile ? "text-[28px] leading-tight tracking-tight" : "text-[13px]")}>Codes</h1>
          <div className="text-muted-foreground text-[11px] max-md:text-[13px]">{total} account{total === 1 ? "" : "s"}. Tap a code to copy it.</div>
        </div>
        <Button size="sm" className="max-md:h-9" onClick={() => setAdding(true)} disabled={listing.data?.available === false}><Plus /> Add account</Button>
      </div>
      {total > 6 && (
        <div className="shrink-0 border-b px-5 py-2 max-md:px-4">
          <Input placeholder="Filter" aria-label="Filter accounts" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {listing.isLoading && <div className="text-muted-foreground flex h-40 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>}
        {listing.data?.available === false && (
          <div className="text-muted-foreground m-6 rounded-lg border border-dashed p-6 text-center">The authenticator is not set up on this server yet. Create the vault key described in docs/SETUP.md, then reload.</div>
        )}
        {listing.data?.available && total === 0 && (
          <div className="text-muted-foreground flex h-72 flex-col items-center justify-center gap-3 px-8 text-center">
            <ShieldCheck className="size-10 opacity-40" />
            <div className="text-base">No accounts yet</div>
            <p className="max-w-sm text-sm">When a site offers "authenticator app" as a second step, choose it and add the QR code it shows here.</p>
            <Button onClick={() => setAdding(true)}><KeyRound /> Add your first account</Button>
          </div>
        )}
        <ul>
          {entries.map((e) => (
            <EntryCard key={e.id} entry={e} age={age} onRename={() => onRename(e)} onDelete={() => onDelete(e)} />
          ))}
        </ul>
      </div>
      {adding && <AddDialog onClose={() => setAdding(false)} />}
    </main>
  );

  if (mobile) {
    return (
      <div className="bg-background h-app flex flex-col text-[15px]">
        {main}
        {tabs}
      </div>
    );
  }
  return (
    <div className="flex h-full">
      <aside className="bg-sidebar flex w-60 shrink-0 flex-col border-r">
        {header}
        <div className="text-muted-foreground flex-1 px-4 pt-4 text-xs leading-relaxed">
          One-time codes for your other accounts. The keys are kept encrypted on the server and never sent to the browser.
        </div>
        {footer}
      </aside>
      {main}
    </div>
  );
}
