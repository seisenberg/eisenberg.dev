import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileText, Loader2, Mail, Paperclip, ShieldAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { avatarColor, fileSize, fullDate, initials, listDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMessage } from "./data";
import { HtmlBody, TextBody } from "./html-body";
import type { AttachmentInfo, MessageDetail, MessageSummary, Person } from "../../shared/api";

function People({ label, people, ours }: { label: string; people: Person[]; ours: Set<string> }) {
  if (people.length === 0) return null;
  return (
    <div className="flex gap-1.5 text-xs max-md:text-[13px]">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0">
        {people.map((p, i) => (
          <span key={p.address + i} title={p.address}>
            {i > 0 && ", "}
            <span className={ours.has(p.address.toLowerCase()) ? "text-primary font-medium" : undefined}>{p.name ? `${p.name} <${p.address}>` : p.address}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

function AuthWarning({ m }: { m: MessageDetail }) {
  if (m.direction !== "in" || !m.auth) return null;
  const failed = Object.entries(m.auth).filter(([, v]) => v === "FAIL").map(([k]) => k.toUpperCase());
  if (failed.length === 0) return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md bg-amber-500/15 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
      <ShieldAlert className="size-3.5 shrink-0" />
      This message failed sender checks ({failed.join(", ")}). The sender may not be who they claim to be.
    </div>
  );
}

function Avatar({ name, address, small }: { name: string; address: string; small?: boolean }) {
  return (
    <div aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white", small ? "size-7 text-[11px]" : "size-10 text-sm")} style={{ background: avatarColor(address || name) }}>
      {initials(name, address)}
    </div>
  );
}

/** Attachments: plain images are shown in place (tap for full size), everything else is a download. */
function Attachments({ m }: { m: MessageDetail }) {
  const [zoom, setZoom] = useState<AttachmentInfo | null>(null);
  if (m.attachments.length === 0) return null;
  const href = (a: AttachmentInfo, inline = false) => `/api/mail/messages/${m.id}/attachments/${a.index}${inline ? "?inline=1" : ""}`;
  const images = m.attachments.filter((a) => a.previewable);
  const files = m.attachments.filter((a) => !a.previewable);
  return (
    <section className="mt-6 border-t pt-4">
      <h2 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Paperclip className="size-3.5" /> {m.attachments.length} attachment{m.attachments.length === 1 ? "" : "s"}
      </h2>
      {images.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {images.map((a) => (
            <button key={a.index} type="button" onClick={() => setZoom(a)} aria-label={`Preview ${a.filename}`} className="group bg-muted relative size-28 overflow-hidden rounded-lg border max-md:size-24">
              <img src={href(a, true)} alt={a.filename} loading="lazy" className="size-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-left text-[11px] text-white">{a.filename}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {files.map((a) => (
          <a key={a.index} href={href(a)} download={a.filename} className="hover:bg-accent flex max-w-xs items-center gap-2 rounded-lg border px-3 py-2 max-md:w-full max-md:max-w-none max-md:py-3">
            <FileText className="text-muted-foreground size-5 shrink-0" />
            <span className="min-w-0 max-md:flex-1">
              <span className="block truncate text-[13px] font-medium max-md:text-[15px]">{a.filename}</span>
              <span className="text-muted-foreground block text-xs">{fileSize(a.size)}</span>
            </span>
            <Download className="text-muted-foreground size-3.5 shrink-0" />
          </a>
        ))}
      </div>
      {zoom && (
        <Dialog open onOpenChange={(open) => !open && setZoom(null)}>
          <DialogContent className="flex max-h-[92dvh] w-auto max-w-[94vw] flex-col gap-3 p-3 sm:max-w-[94vw]">
            <DialogTitle className="truncate pr-8 text-sm">{zoom.filename}</DialogTitle>
            <DialogDescription className="sr-only">Image attachment preview</DialogDescription>
            <img src={href(zoom, true)} alt={zoom.filename} className="min-h-0 max-w-full flex-1 rounded object-contain" />
            <a href={href(zoom)} download={zoom.filename} className="text-primary inline-flex items-center gap-1.5 self-start text-sm font-medium hover:underline">
              <Download className="size-4" /> Download ({fileSize(zoom.size)})
            </a>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

/** One message in full: header, body, attachments. */
function MessageFull({ m, compact, showSubject }: { m: MessageDetail; compact: boolean; showSubject: boolean }) {
  const ours = new Set(m.addresses);
  const sender = m.from.name || m.from.address || "(unknown sender)";
  return (
    <>
      <header className="border-b px-6 py-4 max-md:px-4 max-md:py-3">
        <div className="flex items-start gap-3">
          <Avatar name={m.from.name} address={m.from.address || sender} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold max-md:text-[16px]" title={m.from.address}>
                {sender}
                {m.from.name && !compact && <span className="text-muted-foreground ml-1.5 font-normal">{m.from.address}</span>}
              </span>
              <time className="text-muted-foreground shrink-0 text-xs max-md:text-[13px]" dateTime={m.date} title={fullDate(m.date)}>{compact ? listDate(m.date) : fullDate(m.date)}</time>
            </div>
            {compact && m.from.name && <div className="text-muted-foreground truncate text-[13px]">{m.from.address}</div>}
            {showSubject && <h1 className="text-[15px] leading-snug font-medium max-md:text-[17px] max-md:font-semibold">{m.subject || "(no subject)"}</h1>}
            <People label="To:" people={m.to} ours={ours} />
            <People label="Cc:" people={m.cc} ours={ours} />
            <People label="Reply-To:" people={m.replyTo} ours={ours} />
            {m.direction === "in" && (
              <div className="flex gap-1.5 text-xs max-md:text-[13px]">
                <span className="text-muted-foreground shrink-0">Received on:</span>
                <span className="text-primary font-medium">{m.addresses.join(", ") || "unknown"}</span>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="px-6 py-5 max-md:px-4 max-md:py-4">
        <AuthWarning m={m} />
        {m.html ? <HtmlBody key={m.id} html={m.html} messageId={m.id} /> : <TextBody text={m.text || ""} />}
        <Attachments m={m} />
      </div>
    </>
  );
}

/** Another message of the conversation: one line until opened. */
function ThreadItem({ summary, compact }: { summary: MessageSummary; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const detail = useMessage(open ? summary.id : null);
  const who = summary.direction === "out" ? `You (${summary.from.address})` : summary.from.name || summary.from.address;
  return (
    <section className="border-b">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="hover:bg-accent/50 flex w-full items-center gap-3 px-6 py-2.5 text-left max-md:px-4">
        <Avatar small name={summary.from.name} address={summary.from.address} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("truncate text-[13px] max-md:text-[15px]", summary.isRead ? "font-medium" : "font-bold")}>{who}</span>
            <span className="text-muted-foreground ml-auto shrink-0 text-xs">{listDate(summary.date)}</span>
          </span>
          {!open && <span className="text-muted-foreground block truncate text-xs max-md:text-[13px]">{summary.snippet}</span>}
        </span>
        <ChevronDown className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (detail.data ? <MessageFull m={detail.data} compact={compact} showSubject={false} /> : <div className="text-muted-foreground flex h-20 items-center justify-center"><Loader2 className="size-4 animate-spin" /></div>)}
    </section>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
      <Mail className="size-10 opacity-40" />
      <div className="text-base">{children}</div>
    </div>
  );
}

export function Reader({ id, selectedCount, compact = false }: { id: string | null; selectedCount: number; compact?: boolean }) {
  const { data: m, isLoading, error } = useMessage(selectedCount <= 1 ? id : null);
  const current = useRef<HTMLDivElement>(null);
  // in a conversation, start at the message that was opened
  useEffect(() => {
    if (m && m.thread.length > 1) current.current?.scrollIntoView({ block: "start" });
  }, [m?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (selectedCount > 1) return <Placeholder>{selectedCount} messages selected</Placeholder>;
  if (!id) return <Placeholder>No Message Selected</Placeholder>;
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (error || !m) return <div className="text-muted-foreground flex flex-1 items-center justify-center">{(error as Error)?.message ?? "Message not found"}</div>;

  const conversation = m.thread.length > 1;
  return (
    <article className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      {conversation && (
        <div className="border-b px-6 py-3 max-md:px-4">
          <h1 className="text-[15px] leading-snug font-semibold max-md:text-[17px]">{m.thread[0].subject || m.subject || "(no subject)"}</h1>
          <div className="text-muted-foreground text-xs">{m.thread.length} messages in this conversation</div>
        </div>
      )}
      {conversation ? (
        m.thread.map((t) =>
          t.id === m.id ? (
            <div key={t.id} ref={current} className="border-b">
              <MessageFull m={m} compact={compact} showSubject={false} />
            </div>
          ) : (
            <ThreadItem key={t.id} summary={t} compact={compact} />
          ),
        )
      ) : (
        <MessageFull m={m} compact={compact} showSubject />
      )}
    </article>
  );
}
