import { useEffect, useRef, useState } from "react";
import { Flag, Loader2, MailOpen, Paperclip, Reply, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { listDate } from "@/lib/format";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { MessageSummary } from "../../shared/api";
import type { Scope } from "./data";

export type RowAction = "reply" | "replyAll" | "forward" | "toggleRead" | "toggleFlag" | "archive" | "inbox" | "junk" | "trash" | "restore" | "deleteForever";

/** The catch-all twist: every row says which of our addresses the mail arrived on (or left from). */
function AddressPill({ m, scope, selected }: { m: MessageSummary; scope: Scope; selected: boolean }) {
  if (scope.address) return null;
  const shown = m.addresses.map((a) => (scope.domain && a.endsWith(`@${scope.domain}`) ? a.slice(0, a.lastIndexOf("@")) : a));
  if (shown.length === 0) return null;
  return (
    <span
      title={m.addresses.join(", ")}
      className={cn(
        "max-w-full truncate rounded px-1.5 py-px text-[11px] max-md:text-[12px]",
        selected ? "bg-white/20 text-selection-foreground" : "bg-primary/10 text-primary",
      )}
    >
      {m.direction === "out" ? "from " : ""}
      {shown[0]}
      {shown.length > 1 ? ` +${shown.length - 1}` : ""}
    </span>
  );
}

const SWIPE_COMMIT = 84;
const SWIPE_MAX = 132;

/**
 * Horizontal swipe on a row, as in iOS Mail: right toggles read, left deletes. Vertical movement is
 * left to the list's own scrolling; a swipe only starts once the finger clearly moves sideways.
 */
function useSwipe(enabled: boolean, onLeft: () => void, onRight: () => void) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; mode: "idle" | "swipe" | "scroll" } | null>(null);
  const swiped = useRef(false);
  if (!enabled) return { dx: 0, handlers: {}, swiped };
  return {
    dx,
    swiped,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        // leave the screen edge to the system back gesture
        start.current = t.clientX < 24 ? null : { x: t.clientX, y: t.clientY, mode: "idle" };
        swiped.current = false;
      },
      onTouchMove: (e: React.TouchEvent) => {
        const s = start.current;
        if (!s || s.mode === "scroll") return;
        const t = e.touches[0];
        const mx = t.clientX - s.x;
        const my = t.clientY - s.y;
        if (s.mode === "idle") {
          if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) s.mode = "scroll";
          else if (Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.5) s.mode = "swipe";
        }
        if (s.mode === "swipe") {
          swiped.current = true;
          setDx(Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, mx)));
        }
      },
      onTouchEnd: () => {
        const s = start.current;
        start.current = null;
        if (s?.mode === "swipe") {
          if (dx <= -SWIPE_COMMIT) onLeft();
          else if (dx >= SWIPE_COMMIT) onRight();
        }
        setDx(0);
      },
      onTouchCancel: () => {
        start.current = null;
        setDx(0);
      },
    },
  };
}

function MessageRow({
  m,
  scope,
  selected,
  focused,
  onClick,
  onAction,
  mobile,
}: {
  m: MessageSummary;
  scope: Scope;
  selected: boolean;
  focused: boolean;
  onClick: (e: React.MouseEvent) => void;
  onAction: (action: RowAction) => void;
  mobile: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const who = m.direction === "out" ? `To: ${m.to.map((p) => p.name || p.address).join(", ") || "(no recipient)"}` : m.from.name || m.from.address || "(unknown sender)";
  const muted = selected ? "text-selection-foreground/80" : "text-muted-foreground";
  const inTrash = m.mailbox === "trash" || m.mailbox === "junk";
  const swipe = useSwipe(mobile, () => onAction(inTrash ? "deleteForever" : "trash"), () => onAction("toggleRead"));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={mobile && swipe.dx !== 0}>
        <div className="relative overflow-hidden">
        {mobile && swipe.dx !== 0 && (
          <div
            aria-hidden
            className={cn("absolute inset-0 flex items-center px-6 text-white", swipe.dx < 0 ? "justify-end bg-destructive" : "justify-start bg-primary", Math.abs(swipe.dx) >= SWIPE_COMMIT ? "opacity-100" : "opacity-70")}
          >
            {swipe.dx < 0 ? <Trash2 className="size-6" /> : <MailOpen className="size-6" />}
          </div>
        )}
        <div
          ref={ref}
          role="option"
          aria-selected={selected}
          data-id={m.id}
          onClick={(e) => {
            if (swipe.swiped.current) return; // the tap that ends a swipe is not an open
            onClick(e);
          }}
          onContextMenu={(e) => {
            if (!mobile && !selected) onClick(e);
          }}
          {...swipe.handlers}
          style={mobile ? { transform: swipe.dx ? `translateX(${swipe.dx}px)` : undefined, transition: swipe.dx ? "none" : "transform 160ms ease-out", touchAction: "pan-y" } : undefined}
          className={cn(
            "relative flex gap-1.5 select-none",
            mobile ? "bg-background py-2.5 pr-4 pl-2.5 active:bg-accent" : "mx-2 rounded-lg py-2 pr-3 pl-1.5",
            !mobile && (selected ? "bg-selection text-selection-foreground" : "hover:bg-accent/60"),
          )}
        >
          <div className="flex w-3.5 shrink-0 flex-col items-center gap-1.5 pt-1.5 max-md:pt-2">
            {!m.isRead && <span aria-label="Unread" className={cn("size-2 rounded-full", selected ? "bg-selection-foreground" : "bg-primary")} />}
            {m.isAnswered && <Reply aria-label="Replied" className={cn("size-3", muted)} />}
            {m.isFlagged && <Flag aria-label="Flagged" className="size-3 fill-current text-flag" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={cn("min-w-0 flex-1 truncate text-[13px] max-md:text-[17px]", m.isRead ? "font-medium" : "font-bold")}>{who}</span>
              {m.threadCount > 1 && (
                <span aria-label={`${m.threadCount} messages in this conversation`} className={cn("shrink-0 self-center rounded-full px-1.5 text-[11px] tabular-nums max-md:text-[12px]", selected ? "bg-white/25" : "bg-muted text-muted-foreground")}>
                  {m.threadCount}
                </span>
              )}
              {m.hasAttachments && <Paperclip aria-label="Has attachments" className={cn("size-3 shrink-0 self-center", muted)} />}
              <span className={cn("shrink-0 text-xs tabular-nums max-md:text-[14px]", muted)}>{listDate(m.date)}</span>
            </div>
            <div className="truncate text-[13px] max-md:text-[15px]">{m.subject || "(no subject)"}</div>
            <div className={cn("line-clamp-2 text-xs leading-snug max-md:text-[15px]", muted)}>{m.snippet}</div>
            <div className="mt-1 flex">
              <AddressPill m={m} scope={scope} selected={selected} />
            </div>
          </div>
        </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52 max-md:w-60 max-md:text-[16px] max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[16px]">
        <ContextMenuItem onSelect={() => onAction("reply")}>Reply</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("replyAll")}>Reply All</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("forward")}>Forward</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onAction("toggleRead")}>{m.isRead ? "Mark as Unread" : "Mark as Read"}</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("toggleFlag")}>{m.isFlagged ? "Remove Flag" : "Flag"}</ContextMenuItem>
        <ContextMenuSeparator />
        {inTrash ? (
          <>
            <ContextMenuItem onSelect={() => onAction("restore")}>{m.mailbox === "junk" ? "Not Junk" : "Put Back"}</ContextMenuItem>
            <ContextMenuItem variant="destructive" onSelect={() => onAction("deleteForever")}>Delete Permanently…</ContextMenuItem>
          </>
        ) : (
          <>
            {m.direction === "in" && m.mailbox !== "archive" && <ContextMenuItem onSelect={() => onAction("archive")}>Archive</ContextMenuItem>}
            {m.direction === "in" && m.mailbox === "archive" && <ContextMenuItem onSelect={() => onAction("inbox")}>Move to Inbox</ContextMenuItem>}
            {m.direction === "in" && <ContextMenuItem onSelect={() => onAction("junk")}>Move to Junk</ContextMenuItem>}
            <ContextMenuItem variant="destructive" onSelect={() => onAction("trash")}>Delete</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function MessageList({
  messages,
  scope,
  selected,
  focusedId,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  onRowClick,
  onAction,
  emptyText,
  mobile = false,
}: {
  messages: MessageSummary[];
  scope: Scope;
  selected: Set<string>;
  focusedId: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRowClick: (m: MessageSummary, e: React.MouseEvent) => void;
  onAction: (m: MessageSummary, action: RowAction) => void;
  emptyText: string;
  mobile?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && onLoadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (messages.length === 0) {
    return <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm">{emptyText}</div>;
  }
  return (
    <div role="listbox" aria-label="Messages" aria-multiselectable={!mobile} className={cn("scroll-thin min-h-0 flex-1 overflow-y-auto", mobile ? "overscroll-y-contain pb-safe" : "py-1.5")}>
      {messages.map((m, i) => (
        <div key={m.id}>
          {mobile ? (
            i > 0 && <div className="bg-border ml-9 h-px" />
          ) : (
            <>
              {i > 0 && !selected.has(m.id) && !selected.has(messages[i - 1].id) && <div className="bg-border mr-5 ml-7 h-px" />}
              {i > 0 && (selected.has(m.id) || selected.has(messages[i - 1].id)) && <div className="h-px" />}
            </>
          )}
          <MessageRow m={m} scope={scope} mobile={mobile} selected={!mobile && selected.has(m.id)} focused={!mobile && focusedId === m.id} onClick={(e) => onRowClick(m, e)} onAction={(a) => onAction(m, a)} />
        </div>
      ))}
      <div ref={sentinel} className="text-muted-foreground flex h-10 items-center justify-center">
        {loadingMore && <Loader2 className="size-4 animate-spin" />}
      </div>
    </div>
  );
}
