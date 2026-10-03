import { useState } from "react";
import { Archive, AtSign, ChevronRight, Flag, Globe, Inbox, Send, ShieldAlert, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { MailboxTree } from "../../shared/api";
import type { Scope } from "./data";

const sameScope = (a: Scope, b: Scope) => a.box === b.box && (a.domain ?? "") === (b.domain ?? "") && (a.address ?? "") === (b.address ?? "");

function Row({
  icon,
  label,
  tooltip,
  count,
  active,
  indent = 0,
  onClick,
  leading,
  mobile,
}: {
  icon: React.ReactNode;
  label: string;
  tooltip?: string;
  count?: number;
  active: boolean;
  indent?: number;
  onClick: () => void;
  leading?: React.ReactNode;
  mobile?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={tooltip ?? label}
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-md pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        // touch targets on phones are at least 44px tall
        mobile ? "h-11 gap-2.5 text-[16px]" : "h-7 text-[13px]",
        active ? "bg-selection text-selection-foreground" : "text-sidebar-foreground hover:bg-sidebar-hover",
      )}
      style={{ paddingLeft: 6 + indent * (mobile ? 22 : 16) }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{leading}</span>
      <span className={cn("flex size-4 shrink-0 items-center justify-center", active ? "text-selection-foreground" : "text-primary")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <span className={cn("shrink-0 tabular-nums", mobile ? "text-[15px]" : "text-xs", active ? "text-selection-foreground/90" : "text-muted-foreground")}>{count}</span>}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground px-2 pt-4 pb-1 text-[11px] font-semibold max-md:text-[13px]">{children}</div>;
}

const COLLAPSE_KEY = "eisenmail.collapsedDomains";
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar({ tree, scope, onSelect, onEmpty, mobile }: { tree: MailboxTree | undefined; scope: Scope; onSelect: (s: Scope) => void; onEmpty: (box: "trash" | "junk") => void; mobile?: boolean }) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (domain: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      return next;
    });
  };
  const row = (s: Scope, icon: React.ReactNode, label: string, count?: number) => (
    <Row mobile={mobile} icon={icon} label={label} count={count} active={!mobile && sameScope(scope, s)} onClick={() => onSelect(s)} />
  );

  return (
    <nav aria-label="Mailboxes" className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <SectionLabel>Favorites</SectionLabel>
      {row({ box: "inbox" }, <Inbox className="size-4" />, "All Inboxes", tree?.inbox.unread)}
      {row({ box: "flagged" }, <Flag className="size-4" />, "Flagged", tree?.flagged.total)}

      <SectionLabel>Domains</SectionLabel>
      {tree?.domains.map((d) => {
        const open = !collapsed.has(d.domain);
        return (
          <div key={d.domain}>
            <Row
              mobile={mobile}
              icon={<Globe className="size-4" />}
              label={d.domain}
              count={d.unread}
              active={!mobile && sameScope(scope, { box: "inbox", domain: d.domain })}
              onClick={() => onSelect({ box: "inbox", domain: d.domain })}
              leading={
                d.addresses.length > 0 && (
                  <span
                    role="button"
                    aria-label={open ? `Collapse ${d.domain}` : `Expand ${d.domain}`}
                    aria-expanded={open}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(d.domain);
                    }}
                    className={cn("flex items-center justify-center rounded opacity-60 hover:opacity-100", mobile ? "-m-3 size-10" : "size-4")}
                  >
                    <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
                  </span>
                )
              }
            />
            {open &&
              d.addresses.map((a) => (
                <Row
                  key={a.address}
                  mobile={mobile}
                  indent={1}
                  icon={<AtSign className="size-3.5" />}
                  // reply-<token> addresses only show up here when someone other than you wrote to a relay address
                  label={a.address.slice(0, a.address.lastIndexOf("@")).replace(/^reply-([0-9a-f]{6})[0-9a-f]{26}$/, "relay address $1…")}
                  tooltip={a.address}
                  count={a.unread}
                  active={!mobile && sameScope(scope, { box: "inbox", address: a.address })}
                  onClick={() => onSelect({ box: "inbox", address: a.address })}
                />
              ))}
          </div>
        );
      })}
      {tree && tree.domains.length === 0 && <div className="text-muted-foreground px-2 py-1 text-xs">No mail received yet</div>}

      <SectionLabel>Mailboxes</SectionLabel>
      {row({ box: "sent" }, <Send className="size-4" />, "Sent")}
      {row({ box: "archive" }, <Archive className="size-4" />, "Archive")}
      {(["junk", "trash"] as const).map((box) => (
        <ContextMenu key={box}>
          <ContextMenuTrigger asChild>
            <div>
              {row(
                { box },
                box === "junk" ? <ShieldAlert className="size-4" /> : <Trash2 className="size-4" />,
                box === "junk" ? "Junk" : "Trash",
                box === "junk" ? tree?.junk.unread : undefined,
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem variant="destructive" disabled={!tree?.[box].total} onSelect={() => onEmpty(box)}>
              {box === "junk" ? "Erase Junk Mail…" : "Erase Deleted Items…"}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </nav>
  );
}
