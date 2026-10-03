import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { post } from "@/lib/api";
import { EMAIL_RE, fileSize, fullDate, parseRecipients } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useIdentities } from "./data";
import type { MessageDetail, OutgoingAttachment, SendRequest } from "../../shared/api";

export interface Draft {
  mode: "new" | "reply" | "replyAll" | "forward";
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  inReplyToId?: string;
  forwardAttachments?: number[];
  forwardedNames?: string[];
}

const quote = (text: string) => text.replace(/\r\n/g, "\n").split("\n").map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`)).join("\n");
const prefixed = (prefix: string, subject: string) => (new RegExp(`^${prefix}:`, "i").test(subject.trim()) ? subject : `${prefix}: ${subject}`);
const person = (p: { name: string; address: string }) => (p.name ? `${p.name} <${p.address}>` : p.address);

/** Builds the draft for replying to / forwarding a message. From defaults to the address that received it. */
export function draftFor(mode: Draft["mode"], m: MessageDetail | null, fallbackFrom: string): Draft {
  if (!m || mode === "new") return { mode: "new", from: fallbackFrom, to: "", cc: "", subject: "", text: "" };
  const ours = new Set(m.addresses);
  const from = m.replyFrom || fallbackFrom;
  if (mode === "forward") {
    const header = ["---------- Forwarded message ----------", `From: ${person(m.from)}`, `Date: ${fullDate(m.date)}`, `Subject: ${m.subject}`, `To: ${m.to.map(person).join(", ")}`].join("\n");
    return {
      mode,
      from,
      to: "",
      cc: "",
      subject: prefixed("Fwd", m.subject),
      text: `\n\n${header}\n\n${m.text}`,
      inReplyToId: m.id,
      forwardAttachments: m.attachments.map((a) => a.index),
      forwardedNames: m.attachments.map((a) => a.filename),
    };
  }
  // Replying to our own sent message continues the conversation with its recipients.
  const target = m.direction === "out" ? m.to.map((p) => p.address) : [(m.replyTo[0] ?? m.from).address];
  const others = mode === "replyAll" && m.direction === "in" ? m.to.map((p) => p.address).filter((a) => !ours.has(a.toLowerCase()) && !target.includes(a)) : [];
  const cc = mode === "replyAll" ? m.cc.map((p) => p.address).filter((a) => !ours.has(a.toLowerCase()) && a.toLowerCase() !== from) : [];
  return {
    mode,
    from,
    to: [...target, ...others].join(", "),
    cc: cc.join(", "),
    subject: prefixed("Re", m.subject),
    text: `\n\nOn ${fullDate(m.date)}, ${person(m.from)} wrote:\n${quote(m.text)}`,
    inReplyToId: m.id,
  };
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const MAX_ATTACH = 4 * 1024 * 1024;
const NAME_KEY = "eisenmail.fromName";

function Field({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor: string }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-1.5 max-md:py-2">
      <label htmlFor={htmlFor} className="text-muted-foreground w-14 shrink-0 text-right text-[13px] max-md:w-16 max-md:text-[15px]">{label}</label>
      {children}
    </div>
  );
}

const inputClass = "min-w-0 flex-1 bg-transparent py-1 text-[13px] outline-none placeholder:text-muted-foreground/60";

export function Compose({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const qc = useQueryClient();
  const identities = useIdentities();
  const [from, setFrom] = useState(draft.from);
  const [fromName, setFromName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(!!draft.cc);
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.text);
  const [files, setFiles] = useState<File[]>([]);
  const [keepForwarded, setKeepForwarded] = useState(true);
  const body = useRef<HTMLTextAreaElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Replies start with the cursor above the quote; new messages and forwards start in To.
  const initialFocus = (e: Event) => {
    e.preventDefault();
    if (draft.mode === "reply" || draft.mode === "replyAll") {
      body.current?.focus();
      body.current?.setSelectionRange(0, 0);
      if (body.current) body.current.scrollTop = 0;
    } else toRef.current?.focus();
  };

  const domains = identities.data?.domains ?? [];
  const fromClean = from.trim().toLowerCase();
  const fromDomain = fromClean.slice(fromClean.lastIndexOf("@") + 1);
  const fromError = !EMAIL_RE.test(fromClean)
    ? "Enter the address to send from"
    : domains.length && !domains.includes(fromDomain)
      ? `You can send from: ${domains.join(", ")}`
      : null;
  const grouped = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const a of identities.data?.addresses ?? []) {
      const d = a.slice(a.lastIndexOf("@") + 1);
      out.set(d, [...(out.get(d) ?? []), a]);
    }
    return out;
  }, [identities.data]);
  const localPart = fromClean.includes("@") ? fromClean.slice(0, fromClean.lastIndexOf("@")) : fromClean;

  const attachBytes = files.reduce((n, f) => n + f.size, 0);
  const dirty = text !== draft.text || to !== draft.to || subject !== draft.subject || files.length > 0;

  const send = useMutation({
    mutationFn: async () => {
      const rcpt = { to: parseRecipients(to), cc: parseRecipients(cc), bcc: parseRecipients(bcc) };
      const invalid = [...rcpt.to.invalid, ...rcpt.cc.invalid, ...rcpt.bcc.invalid];
      if (invalid.length) throw new Error(`Not a valid address: ${invalid[0]}`);
      if (rcpt.to.valid.length + rcpt.cc.valid.length + rcpt.bcc.valid.length === 0) throw new Error("Add at least one recipient");
      if (fromError) throw new Error(fromError);
      const attachments: OutgoingAttachment[] = [];
      for (const f of files) attachments.push({ filename: f.name, contentType: f.type || "application/octet-stream", content: await readAsBase64(f) });
      const req: SendRequest = {
        from: fromClean,
        fromName: fromName.trim() || undefined,
        to: rcpt.to.valid,
        cc: rcpt.cc.valid,
        bcc: rcpt.bcc.valid,
        subject,
        text,
        inReplyToId: draft.inReplyToId,
        forwardAttachments: draft.mode === "forward" ? (keepForwarded ? draft.forwardAttachments ?? [] : []) : undefined,
        attachments,
      };
      return post<{ id: string }>("/mail/send", req);
    },
    onSuccess: () => {
      localStorage.setItem(NAME_KEY, fromName.trim());
      toast.success("Message sent");
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      qc.invalidateQueries({ queryKey: ["identities"] });
      if (draft.inReplyToId) qc.invalidateQueries({ queryKey: ["message", draft.inReplyToId] });
      onClose();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const tryClose = () => {
    if (send.isPending) return;
    if (dirty && !window.confirm("Discard this message?")) return;
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && tryClose()}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={initialFocus}
        onInteractOutside={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send.mutate();
        }}
        // phones: a full-screen sheet, clear of the notch and the home indicator
        className="flex h-[min(680px,90vh)] w-[min(760px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]"
      >
        <div className="bg-muted/60 flex h-11 shrink-0 items-center gap-2 border-b px-3 max-md:h-12 max-md:[&_button]:min-h-10 max-md:[&_button]:min-w-10">
          <Button variant="ghost" size="icon-sm" onClick={tryClose} aria-label="Close"><X /></Button>
          <DialogTitle className="flex-1 truncate text-center text-[13px] font-semibold">{subject || (draft.mode === "new" ? "New Message" : "Message")}</DialogTitle>
          <DialogDescription className="sr-only">Compose a message</DialogDescription>
          <Button variant="ghost" size="icon-sm" onClick={() => picker.current?.click()} aria-label="Attach files"><Paperclip /></Button>
          <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending}>
            {send.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send
          </Button>
        </div>

        <Field label="To:" htmlFor="c-to">
          <input id="c-to" ref={toRef} className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" spellCheck={false} placeholder="name@example.com, another@example.com" />
          {!showCc && <button type="button" className="text-muted-foreground hover:text-foreground text-xs" onClick={() => setShowCc(true)}>Cc/Bcc</button>}
        </Field>
        {showCc && (
          <>
            <Field label="Cc:" htmlFor="c-cc"><input id="c-cc" className={inputClass} value={cc} onChange={(e) => setCc(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
            <Field label="Bcc:" htmlFor="c-bcc"><input id="c-bcc" className={inputClass} value={bcc} onChange={(e) => setBcc(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
          </>
        )}
        <Field label="Subject:" htmlFor="c-subject"><input id="c-subject" className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="From:" htmlFor="c-from">
          <input
            id="c-from-name"
            aria-label="Sender name (optional)"
            className={cn(inputClass, "max-w-36 flex-none max-md:hidden")}
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Name (optional)"
            autoComplete="off"
          />
          <span className="text-muted-foreground max-md:hidden">&lt;</span>
          <input
            id="c-from"
            className={cn(inputClass, fromError && "text-destructive")}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!fromError}
            title={fromError ?? "Any address on your domains works"}
            placeholder={`anything@${domains[0] ?? "your-domain"}`}
          />
          <span className="text-muted-foreground max-md:hidden">&gt;</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" aria-label="Choose a sending address">Change <ChevronDown /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[15px]">
              {draft.from && draft.from !== fromClean && (
                <>
                  <DropdownMenuItem onSelect={() => setFrom(draft.from)}>{draft.from} <span className="text-muted-foreground ml-auto text-xs">default</span></DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {localPart && domains.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-muted-foreground text-xs">“{localPart}” at another domain</DropdownMenuLabel>
                  {domains.filter((d) => d !== fromDomain).map((d) => (
                    <DropdownMenuItem key={d} onSelect={() => setFrom(`${localPart}@${d}`)}>{localPart}@{d}</DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              {[...grouped.entries()].map(([d, list]) => (
                <div key={d}>
                  <DropdownMenuLabel className="text-muted-foreground text-xs">{d}</DropdownMenuLabel>
                  {list.slice(0, 12).map((a) => (
                    <DropdownMenuItem key={a} onSelect={() => setFrom(a)}>{a}</DropdownMenuItem>
                  ))}
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        {fromError && from.trim() !== "" && <div className="text-destructive border-b px-4 py-1 pl-[5.5rem] text-xs">{fromError}</div>}

        <textarea
          ref={body}
          aria-label="Message"
          className="scroll-thin min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-sans text-[14px] leading-relaxed outline-none max-md:px-4"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {(files.length > 0 || (draft.forwardedNames?.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2">
            {draft.forwardedNames && draft.forwardedNames.length > 0 && (
              <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={keepForwarded} onChange={(e) => setKeepForwarded(e.target.checked)} />
                Include original attachment{draft.forwardedNames.length === 1 ? "" : "s"} ({draft.forwardedNames.join(", ")})
              </label>
            )}
            {files.map((f, i) => (
              <span key={f.name + i} className="bg-secondary flex items-center gap-1.5 rounded-full py-0.5 pr-1 pl-2.5 text-xs">
                {f.name} <span className="text-muted-foreground">{fileSize(f.size)}</span>
                <button type="button" aria-label={`Remove ${f.name}`} className="hover:bg-accent rounded-full p-0.5" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="size-3" /></button>
              </span>
            ))}
            {attachBytes > MAX_ATTACH && <span className="text-destructive text-xs">Attachments are limited to 4 MB per message. Use the file drop for larger files.</span>}
          </div>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
