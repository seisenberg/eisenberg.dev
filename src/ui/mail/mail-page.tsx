import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Archive, ArchiveRestore, CheckCheck, ChevronLeft, Ellipsis, Flag, Forward, Inbox, MailOpen, Reply, ReplyAll, Search, ShieldAlert, SquarePen, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { setBadge } from "@/lib/pwa";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { get } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { Compose, draftFor, type Draft } from "./compose";
import { scopeTitle, useDeleteForever, useDrafts, useEmptyMailbox, useIdentities, useMailboxes, useMailLocation, useMailSettings, useMarkAllRead, useMessage, useMessages, usePatchMessages } from "./data";
import { DraftsList } from "./drafts-list";
import { InstallHint } from "./install-hint";
import { MessageList, type RowAction } from "./message-list";
import { Reader } from "./reader";
import { Sidebar } from "./sidebar";
import type { MessageDetail, MessageSummary } from "../../shared/api";

function ToolButton({ label, shortcut, onClick, disabled, children, active }: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled} className={cn("text-muted-foreground hover:text-foreground", active && "text-flag hover:text-flag")}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-2 opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** Phone toolbar button: 44pt touch target, label for screen readers. */
function TouchButton({ label, onClick, disabled, children, className }: { label: string; onClick?: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className={cn("text-primary flex h-11 min-w-11 items-center justify-center rounded-lg px-2 text-[17px] active:bg-accent disabled:opacity-35 [&_svg]:size-[22px]", className)}>
      {children}
    </button>
  );
}

export default function MailPage({ header, footer, tabs }: { header: React.ReactNode; footer: React.ReactNode; tabs: React.ReactNode }) {
  const mobile = useIsMobile();
  const qc = useQueryClient();
  const loc = useMailLocation();
  const { scope, id, q } = loc;
  const tree = useMailboxes();
  const identities = useIdentities();
  const list = useMessages(scope, q);
  const patchMessages = usePatchMessages();
  const deleteForever = useDeleteForever();
  const emptyMailbox = useEmptyMailbox();
  const markAllRead = useMarkAllRead();
  const drafts = useDrafts();
  const settings = useMailSettings();
  const isDrafts = scope.box === "drafts";

  const messages = useMemo(() => list.data?.pages.flatMap((p) => p.messages) ?? [], [list.data]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(id ? [id] : []));
  const anchor = useRef<string | null>(id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [searchText, setSearchText] = useState(q);
  const searchRef = useRef<HTMLInputElement>(null);

  // Changing mailbox clears the selection.
  const scopeKey = `${scope.box}|${scope.domain ?? ""}|${scope.address ?? ""}`;
  const firstScope = useRef(scopeKey);
  useEffect(() => {
    if (firstScope.current === scopeKey) return;
    firstScope.current = scopeKey;
    setSelected(new Set());
    anchor.current = null;
    setSearchText("");
  }, [scopeKey]);

  // Debounced search.
  useEffect(() => {
    if (searchText === q) return;
    const t = setTimeout(() => loc.setQ(searchText.trim()), 250);
    return () => clearTimeout(t);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(
    (m: MessageSummary) => {
      setSelected(new Set([m.id]));
      anchor.current = m.id;
      // On a phone the reader is its own screen: add a history entry so "back" returns to the list.
      loc.setId(m.id, { push: mobile });
      if (!m.isRead) patchMessages.mutate({ ids: [m.id], set: { isRead: true } });
    },
    [loc, patchMessages, mobile],
  );

  /** Phone: leave the reader screen. */
  const closeReader = () => {
    setSelected(new Set());
    if (!loc.id) return;
    if (loc.pushed) loc.back();
    else loc.setId(null);
  };

  // Phone: arriving back on the list (also via the system back gesture) clears the selection.
  useEffect(() => {
    if (mobile && !id) setSelected(new Set());
  }, [mobile, id]);

  // Unread count on the home screen icon.
  const unread = tree.data?.inbox.unread;
  useEffect(() => {
    if (unread !== undefined) setBadge(unread);
  }, [unread]);

  const onRowClick = (m: MessageSummary, e: React.MouseEvent) => {
    if (mobile) return open(m);
    if (e.type === "contextmenu") {
      setSelected(new Set([m.id]));
      anchor.current = m.id;
      loc.setId(m.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      setSelected(next);
      anchor.current = m.id;
      loc.setId(next.size === 1 ? [...next][0] : next.has(m.id) ? m.id : null);
      return;
    }
    if (e.shiftKey && anchor.current) {
      const a = messages.findIndex((x) => x.id === anchor.current);
      const b = messages.findIndex((x) => x.id === m.id);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(messages.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
        loc.setId(m.id);
        return;
      }
    }
    open(m);
  };

  // On a phone the open message is the target, even when it is not in the loaded list (deep link).
  const openDetail = useMessage(mobile ? id : null).data;
  const targets = useMemo(() => {
    const fromList = messages.filter((m) => selected.has(m.id));
    if (mobile && id) return fromList.some((m) => m.id === id) ? fromList.filter((m) => m.id === id) : openDetail ? [openDetail as MessageSummary] : [];
    return fromList;
  }, [messages, selected, mobile, id, openDetail]);
  const current = targets.length === 1 ? targets[0] : null;

  /** After removing messages from the list, select the neighbour, like Mail does. */
  const selectNeighbour = (removed: MessageSummary[]) => {
    const gone = new Set(removed.map((m) => m.id));
    const lastIndex = Math.max(...removed.map((m) => messages.findIndex((x) => x.id === m.id)));
    const next = messages.slice(lastIndex + 1).find((m) => !gone.has(m.id)) ?? [...messages.slice(0, lastIndex)].reverse().find((m) => !gone.has(m.id));
    if (next) {
      setSelected(new Set([next.id]));
      anchor.current = next.id;
      loc.setId(next.id);
      if (!next.isRead) patchMessages.mutate({ ids: [next.id], set: { isRead: true } });
    } else {
      setSelected(new Set());
      loc.setId(null);
    }
  };

  const compose = async (mode: Draft["mode"], m?: MessageSummary) => {
    const fallback = scope.address ?? identities.data?.defaultFrom ?? "";
    const signature = settings.data?.signature ?? "";
    if (mode === "new" || !m) return setDraft(draftFor("new", null, fallback, signature));
    try {
      const detail = await qc.fetchQuery({ queryKey: ["message", m.id], queryFn: () => get<MessageDetail>(`/mail/messages/${m.id}`), staleTime: 5 * 60_000 });
      setDraft(draftFor(mode, detail, fallback, signature));
    } catch {
      /* the reader shows the error */
    }
  };

  const act = (action: RowAction, on: MessageSummary[] = targets) => {
    if (on.length === 0) return;
    const ids = on.map((m) => m.id);
    switch (action) {
      case "reply":
      case "replyAll":
      case "forward":
        return void compose(action, on[0]);
      case "toggleRead":
        return patchMessages.mutate({ ids, set: { isRead: on.some((m) => !m.isRead) } });
      case "toggleFlag":
        return patchMessages.mutate({ ids, set: { isFlagged: !on.every((m) => m.isFlagged) } });
      case "archive":
      case "inbox":
      case "junk":
      case "trash":
      case "restore":
        if (mobile) closeReader();
        else selectNeighbour(on);
        return patchMessages.mutate({ ids, set: { mailbox: action } });
      case "deleteForever":
        if (!window.confirm(`Permanently delete ${ids.length === 1 ? "this message" : `${ids.length} messages`}? This cannot be undone.`)) return;
        if (mobile) closeReader();
        else selectNeighbour(on);
        return deleteForever.mutate(ids);
    }
  };

  const inTrash = scope.box === "trash" || scope.box === "junk";

  // Keyboard, as in Mail: arrows move, delete trashes, letters act on the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mobile || draft || isTyping(e.target) || e.altKey) return;
      if (document.querySelector("[role=dialog],[role=menu]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const index = messages.findIndex((m) => m.id === (anchor.current ?? id));
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || (!mod && (e.key === "j" || e.key === "k"))) {
        e.preventDefault();
        const down = e.key === "ArrowDown" || e.key === "j";
        const next = messages[index < 0 ? 0 : Math.min(Math.max(index + (down ? 1 : -1), 0), messages.length - 1)];
        if (next) open(next);
        return;
      }
      if (mod) return;
      const map: Record<string, RowAction> = { r: "reply", a: "replyAll", f: "forward", u: "toggleRead", s: "toggleFlag", e: inTrash ? "restore" : "archive", Delete: inTrash ? "deleteForever" : "trash", Backspace: inTrash ? "deleteForever" : "trash" };
      if (e.key === "n" || e.key === "c") {
        e.preventDefault();
        void compose("new");
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (map[e.key]) {
        e.preventDefault();
        act(map[e.key]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Home screen shortcut "New Message".
  useEffect(() => {
    if (!loc.wantsCompose || !identities.data) return;
    loc.clearCompose();
    void compose("new");
  }, [loc.wantsCompose, identities.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = list.data ? messages.length : 0;
  const none = targets.length === 0;
  const allInbound = targets.every((m) => m.direction === "in");
  const emptyAll = (box: "trash" | "junk") => {
    if (window.confirm(`Permanently delete everything in ${box === "trash" ? "Trash" : "Junk"}? This cannot be undone.`)) emptyMailbox.mutate(box);
  };
  const retention = settings.data?.purgeAfterDays ?? 30;
  const countLine = isDrafts
    ? `${drafts.data?.length ?? 0} draft${drafts.data?.length === 1 ? "" : "s"}`
    : (q ? `${total}${list.hasNextPage ? "+" : ""} found` : `${total}${list.hasNextPage ? "+" : ""} message${total === 1 ? "" : "s"}`) +
      (scope.box === "inbox" && tree.data && !q && !scope.address && !scope.domain && tree.data.inbox.unread > 0 ? `, ${tree.data.inbox.unread} unread` : "") +
      (inTrash && retention > 0 ? `, deleted after ${retention} days` : "");
  /** Actions on the whole mailbox view. */
  const listMenu = !isDrafts && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {mobile ? (
          <button type="button" aria-label="Mailbox actions" className="text-primary flex h-11 min-w-11 items-center justify-center rounded-lg active:bg-accent [&_svg]:size-[22px]"><Ellipsis /></button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="Mailbox actions" className="text-muted-foreground hover:text-foreground"><Ellipsis /></Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[16px]">
        <DropdownMenuItem onSelect={() => markAllRead.mutate(scope)}><CheckCheck /> Mark all as read</DropdownMenuItem>
        {inTrash && <DropdownMenuItem variant="destructive" onSelect={() => emptyAll(scope.box as "trash" | "junk")}><Trash2 /> {scope.box === "junk" ? "Erase Junk Mail…" : "Erase Deleted Items…"}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const searchField = (
    <div className={cn("bg-muted flex items-center gap-1.5 rounded-md px-2", mobile ? "h-9 rounded-[10px]" : "h-7")}>
      <Search className="text-muted-foreground size-3.5 shrink-0 max-md:size-4" />
      <input
        ref={searchRef}
        type="search"
        enterKeyHint="search"
        aria-label={`Search ${scopeTitle(scope)}`}
        placeholder="Search"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(e) => (e.key === "Escape" || e.key === "Enter") && (e.key === "Escape" && setSearchText(""), e.currentTarget.blur())}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {searchText && <button type="button" aria-label="Clear search" onClick={() => setSearchText("")} className="text-muted-foreground hover:text-foreground"><X className="size-3.5 max-md:size-5" /></button>}
    </div>
  );
  const listPane = isDrafts ? (
    <DraftsList mobile={mobile} onOpen={(d) => setDraft({ ...d.payload, id: d.id })} />
  ) : (
    <MessageList
      mobile={mobile}
      messages={messages}
      scope={scope}
      selected={selected}
      focusedId={id}
      loading={list.isLoading}
      hasMore={!!list.hasNextPage}
      loadingMore={list.isFetchingNextPage}
      onLoadMore={() => !list.isFetchingNextPage && list.fetchNextPage()}
      onRowClick={onRowClick}
      onAction={(m, a) => act(a, selected.has(m.id) && targets.length > 1 ? targets : [m])}
      emptyText={list.error ? (list.error as Error).message : q ? "No messages match your search" : "No Messages"}
    />
  );
  const composer = draft && <Compose key={`${draft.mode}-${draft.inReplyToId ?? "new"}-${draft.id ?? ""}`} draft={draft} onClose={() => setDraft(null)} />;

  // ---- phone: one screen at a time, like iOS Mail (Mailboxes > list > message) ------------------
  if (mobile) {
    const screen = loc.boxes ? "boxes" : id ? "reader" : "list";
    const flagged = !!current?.isFlagged;
    return (
      <div className="bg-background h-app flex flex-col">
        {screen === "boxes" && (
          <>
            <div className="bg-sidebar pt-safe flex min-h-0 flex-1 flex-col">
              <h1 className="px-4 pt-4 pb-1 text-[28px] leading-tight font-bold tracking-tight">Mailboxes</h1>
              <Sidebar mobile tree={tree.data} scope={scope} onSelect={loc.setScope} onEmpty={emptyAll} drafts={drafts.data?.length} />
            </div>
            {tabs}
          </>
        )}

        {screen === "list" && (
          <>
            <header className="pt-safe shrink-0 border-b">
              <div className="flex h-12 items-center gap-1 px-1">
                <TouchButton label="Mailboxes" onClick={loc.openBoxes} className="pr-3 pl-1"><ChevronLeft /> <span>Mailboxes</span></TouchButton>
                <div className="flex-1" />
                {listMenu}
                <TouchButton label="New Message" onClick={() => void compose("new")}><SquarePen /></TouchButton>
              </div>
              <div className="px-4 pb-2">
                <h1 className="truncate text-[28px] leading-tight font-bold tracking-tight" title={scopeTitle(scope)}>{scopeTitle(scope)}</h1>
                <div className="text-muted-foreground text-[13px]">{countLine}</div>
              </div>
              {!isDrafts && <div className="px-4 pb-2.5">{searchField}</div>}
            </header>
            <InstallHint />
            {listPane}
            {tabs}
          </>
        )}

        {screen === "reader" && (
          <>
            <header className="pt-safe shrink-0 border-b">
              <div className="flex h-12 items-center gap-1 px-1">
                <TouchButton label={`Back to ${scopeTitle(scope)}`} onClick={closeReader} className="max-w-[60%] pr-3 pl-1">
                  <ChevronLeft className="shrink-0" /> <span className="truncate">{scopeTitle(scope)}</span>
                </TouchButton>
                <div className="flex-1" />
                <TouchButton label={current && !current.isRead ? "Mark as Read" : "Mark as Unread"} disabled={!current} onClick={() => { act("toggleRead"); closeReader(); }}><MailOpen /></TouchButton>
              </div>
            </header>
            <Reader id={id} selectedCount={1} compact />
            <nav aria-label="Message actions" className="bg-background pb-safe shrink-0 border-t">
              <div className="flex h-12 items-center justify-around px-2">
                <TouchButton label={flagged ? "Remove Flag" : "Flag"} disabled={!current} onClick={() => act("toggleFlag")} className={flagged ? "text-flag" : undefined}>
                  <Flag className={cn(flagged && "fill-current")} />
                </TouchButton>
                {inTrash ? (
                  <TouchButton label={scope.box === "junk" ? "Not Junk" : "Put Back"} disabled={!current} onClick={() => act("restore")}><ArchiveRestore /></TouchButton>
                ) : current?.mailbox === "archive" ? (
                  <TouchButton label="Move to Inbox" disabled={!current || !allInbound} onClick={() => act("inbox")}><Inbox /></TouchButton>
                ) : (
                  <TouchButton label="Archive" disabled={!current || !allInbound} onClick={() => act("archive")}><Archive /></TouchButton>
                )}
                <TouchButton label={inTrash ? "Delete Permanently" : "Delete"} disabled={!current} onClick={() => act(inTrash ? "deleteForever" : "trash")}><Trash2 /></TouchButton>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Reply, Reply All or Forward" disabled={!current} className="text-primary flex h-11 min-w-11 items-center justify-center rounded-lg active:bg-accent disabled:opacity-35 [&_svg]:size-[22px]"><Reply /></button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end" className="w-56 [&_[role=menuitem]]:py-2.5 [&_[role=menuitem]]:text-[16px]">
                    <DropdownMenuItem onSelect={() => act("reply")}><Reply /> Reply</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => act("replyAll")}><ReplyAll /> Reply All</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => act("forward")}><Forward /> Forward</DropdownMenuItem>
                    {!inTrash && allInbound && <DropdownMenuItem onSelect={() => act("junk")}><ShieldAlert /> Move to Junk</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
                <TouchButton label="New Message" onClick={() => void compose("new")}><SquarePen /></TouchButton>
              </div>
            </nav>
          </>
        )}
        {composer}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Group orientation="horizontal" id="eisenmail-panes" className="min-h-0 flex-1">
        <Panel id="sidebar" defaultSize="240px" minSize="190px" maxSize="380px" className="bg-sidebar flex flex-col border-r">
          {header}
          <Sidebar tree={tree.data} scope={scope} onSelect={loc.setScope} onEmpty={emptyAll} drafts={drafts.data?.length} />
          {footer}
        </Panel>
        <Separator className="w-px bg-transparent outline-none data-[separator=active]:bg-primary data-[separator=hover]:bg-primary/60" />

        <Panel id="list" defaultSize="380px" minSize="280px" maxSize="560px" className="flex flex-col border-r">
          <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-bold" title={scopeTitle(scope)}>{scopeTitle(scope)}</div>
              <div className="text-muted-foreground truncate text-[11px]">{countLine}</div>
            </div>
            {listMenu}
            <ToolButton label="New Message" shortcut="N" onClick={() => void compose("new")}><SquarePen /></ToolButton>
          </div>
          {!isDrafts && <div className="shrink-0 px-3 pt-2 pb-1">{searchField}</div>}
          {listPane}
        </Panel>
        <Separator className="w-px bg-transparent outline-none data-[separator=active]:bg-primary data-[separator=hover]:bg-primary/60" />

        <Panel id="reader" minSize="360px" className="flex min-w-0 flex-col">
          <div role="toolbar" aria-label="Message actions" className="flex h-[52px] shrink-0 items-center gap-0.5 border-b px-3">
            {inTrash ? (
              <>
                <ToolButton label={scope.box === "junk" ? "Not Junk" : "Put Back"} shortcut="E" disabled={none} onClick={() => act("restore")}><ArchiveRestore /></ToolButton>
                <ToolButton label="Delete Permanently" shortcut="⌫" disabled={none} onClick={() => act("deleteForever")}><Trash2 /></ToolButton>
              </>
            ) : (
              <>
                {scope.box === "archive" ? (
                  <ToolButton label="Move to Inbox" disabled={none || !allInbound} onClick={() => act("inbox")}><Inbox /></ToolButton>
                ) : (
                  <ToolButton label="Archive" shortcut="E" disabled={none || !allInbound} onClick={() => act("archive")}><Archive /></ToolButton>
                )}
                <ToolButton label="Delete" shortcut="⌫" disabled={none} onClick={() => act("trash")}><Trash2 /></ToolButton>
                <ToolButton label="Move to Junk" disabled={none || !allInbound} onClick={() => act("junk")}><ShieldAlert /></ToolButton>
              </>
            )}
            <div className="bg-border mx-1.5 h-5 w-px" />
            <ToolButton label="Reply" shortcut="R" disabled={!current} onClick={() => act("reply")}><Reply /></ToolButton>
            <ToolButton label="Reply All" shortcut="A" disabled={!current} onClick={() => act("replyAll")}><ReplyAll /></ToolButton>
            <ToolButton label="Forward" shortcut="F" disabled={!current} onClick={() => act("forward")}><Forward /></ToolButton>
            <div className="bg-border mx-1.5 h-5 w-px" />
            <ToolButton label={targets.length > 0 && targets.every((m) => m.isFlagged) ? "Remove Flag" : "Flag"} shortcut="S" disabled={none} active={targets.length > 0 && targets.every((m) => m.isFlagged)} onClick={() => act("toggleFlag")}>
              <Flag className={cn(targets.length > 0 && targets.every((m) => m.isFlagged) && "fill-current")} />
            </ToolButton>
            <ToolButton label={targets.some((m) => !m.isRead) ? "Mark as Read" : "Mark as Unread"} shortcut="U" disabled={none} onClick={() => act("toggleRead")}><MailOpen /></ToolButton>
            <div className="flex-1" />
            {current && (
              <a href={`/api/mail/messages/${current.id}/raw`} download className="text-muted-foreground hover:text-foreground px-2 text-xs">View source</a>
            )}
          </div>
          <Reader id={current?.id ?? (targets.length === 0 ? null : id)} selectedCount={targets.length} />
        </Panel>
      </Group>
      {composer}
    </div>
  );
}
