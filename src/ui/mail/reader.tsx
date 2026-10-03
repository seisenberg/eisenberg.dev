import { Download, FileText, Loader2, Mail, Paperclip, ShieldAlert } from "lucide-react";
import { avatarColor, fileSize, fullDate, initials, listDate } from "@/lib/format";
import { useMessage } from "./data";
import { HtmlBody, TextBody } from "./html-body";
import type { MessageDetail, Person } from "../../shared/api";

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

export function Reader({ id, selectedCount, compact = false }: { id: string | null; selectedCount: number; compact?: boolean }) {
  const { data: m, isLoading, error } = useMessage(selectedCount <= 1 ? id : null);

  if (selectedCount > 1) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
        <Mail className="size-10 opacity-40" />
        <div className="text-base">{selectedCount} messages selected</div>
      </div>
    );
  }
  if (!id) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
        <Mail className="size-10 opacity-40" />
        <div className="text-base">No Message Selected</div>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (error || !m) {
    return <div className="text-muted-foreground flex flex-1 items-center justify-center">{(error as Error)?.message ?? "Message not found"}</div>;
  }

  const ours = new Set(m.addresses);
  const sender = m.from.name || m.from.address || "(unknown sender)";
  return (
    <article className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <header className="border-b px-6 py-4 max-md:px-4 max-md:py-3">
        <div className="flex items-start gap-3">
          <div aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: avatarColor(m.from.address || sender) }}>
            {initials(m.from.name, m.from.address)}
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold max-md:text-[16px]" title={m.from.address}>
                {sender}
                {m.from.name && !compact && <span className="text-muted-foreground ml-1.5 font-normal">{m.from.address}</span>}
              </span>
              <time className="text-muted-foreground shrink-0 text-xs max-md:text-[13px]" dateTime={m.date} title={fullDate(m.date)}>{compact ? listDate(m.date) : fullDate(m.date)}</time>
            </div>
            {compact && m.from.name && <div className="text-muted-foreground truncate text-[13px]">{m.from.address}</div>}
            <h1 className="text-[15px] leading-snug font-medium max-md:text-[17px] max-md:font-semibold">{m.subject || "(no subject)"}</h1>
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
        {m.html ? <HtmlBody key={m.id} html={m.html} /> : <TextBody text={m.text || ""} />}

        {m.attachments.length > 0 && (
          <section className="mt-6 border-t pt-4">
            <h2 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
              <Paperclip className="size-3.5" /> {m.attachments.length} attachment{m.attachments.length === 1 ? "" : "s"}
            </h2>
            <div className="flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <a
                  key={a.index}
                  href={`/api/mail/messages/${m.id}/attachments/${a.index}`}
                  download={a.filename}
                  className="hover:bg-accent flex max-w-xs items-center gap-2 rounded-lg border px-3 py-2 max-md:w-full max-md:max-w-none max-md:py-3"
                >
                  <FileText className="text-muted-foreground size-5 shrink-0" />
                  <span className="min-w-0 max-md:flex-1">
                    <span className="block truncate text-[13px] font-medium max-md:text-[15px]">{a.filename}</span>
                    <span className="text-muted-foreground block text-xs">{fileSize(a.size)}</span>
                  </span>
                  <Download className="text-muted-foreground size-3.5 shrink-0" />
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
