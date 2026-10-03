import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { type InfiniteData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { get, patch, post } from "@/lib/api";
import type { Identities, MailboxTree, MailboxView, MessageDetail, MessageList, MessagePatch, MessageSummary } from "../../shared/api";

/** What the message list is showing. Lives in the URL so reload and back/forward work. */
export interface Scope {
  box: MailboxView;
  domain?: string;
  address?: string;
}

const BOXES: MailboxView[] = ["inbox", "flagged", "sent", "archive", "junk", "trash"];

export function useMailLocation() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const box = (BOXES.includes(params.get("box") as MailboxView) ? params.get("box") : "inbox") as MailboxView;
  const domain = params.get("domain") ?? undefined;
  const address = params.get("address") ?? undefined;
  const id = params.get("id");
  const q = params.get("q") ?? "";
  const scope = useMemo<Scope>(() => ({ box, domain, address }), [box, domain, address]);
  /** This history entry was pushed by the app itself, so "back" returns to the previous screen. */
  const pushed = (location.state as { pushed?: boolean } | null)?.pushed === true;

  return {
    scope,
    id,
    q,
    /** phone layout: the mailbox list screen */
    boxes: params.get("boxes") === "1",
    /** opened from the home screen "New Message" shortcut */
    wantsCompose: params.get("compose") === "1",
    pushed,
    back: () => navigate(-1),
    setScope(next: Scope) {
      const p = new URLSearchParams();
      p.set("box", next.box);
      if (next.address) p.set("address", next.address);
      else if (next.domain) p.set("domain", next.domain);
      setParams(p, { state: { pushed: true } });
    },
    /** `push` adds a history entry (phone: the reader is its own screen, back returns to the list). */
    setId(next: string | null, opts: { push?: boolean } = {}) {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next) p.set("id", next);
          else p.delete("id");
          p.delete("boxes");
          return p;
        },
        opts.push ? { state: { pushed: true } } : { replace: true },
      );
    },
    openBoxes() {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.set("boxes", "1");
          p.delete("id");
          return p;
        },
        { state: { pushed: true } },
      );
    },
    clearCompose() {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete("compose");
          return p;
        },
        { replace: true },
      );
    },
    setQ(next: string) {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next) p.set("q", next);
          else p.delete("q");
          p.delete("id");
          return p;
        },
        { replace: true },
      );
    },
  };
}

export function scopeTitle(scope: Scope): string {
  if (scope.address) return scope.address;
  if (scope.domain) return scope.domain;
  return { inbox: "All Inboxes", flagged: "Flagged", sent: "Sent", archive: "Archive", junk: "Junk", trash: "Trash" }[scope.box];
}

export function useMailboxes() {
  // The server indexes newly received mail when this is fetched, so polling it is what makes new mail appear.
  return useQuery({ queryKey: ["mailboxes"], queryFn: () => get<MailboxTree>("/mail/mailboxes"), refetchInterval: 30_000, refetchOnWindowFocus: true });
}

export function useIdentities() {
  return useQuery({ queryKey: ["identities"], queryFn: () => get<Identities>("/mail/identities"), staleTime: 60_000 });
}

export function useMessages(scope: Scope, q: string) {
  return useInfiniteQuery({
    queryKey: ["messages", scope, q],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ mailbox: scope.box, limit: "60" });
      if (scope.address) p.set("address", scope.address);
      else if (scope.domain) p.set("domain", scope.domain);
      if (q) p.set("q", q);
      if (pageParam) p.set("cursor", pageParam);
      return get<MessageList>(`/mail/messages?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useMessage(id: string | null) {
  return useQuery({ queryKey: ["message", id], queryFn: () => get<MessageDetail>(`/mail/messages/${id}`), enabled: !!id, staleTime: 5 * 60_000 });
}

type ListCache = InfiniteData<MessageList, string>;

/** Flag / read / move with the UI updated first and the server caught up after. */
export function usePatchMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: MessagePatch) => patch<{ changed: number }>("/mail/messages", p),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: ["messages"] });
      const snapshot = qc.getQueriesData<ListCache>({ queryKey: ["messages"] });
      const ids = new Set(p.ids);
      const apply = (m: MessageSummary): MessageSummary => ({
        ...m,
        isRead: p.set.isRead ?? m.isRead,
        isFlagged: p.set.isFlagged ?? m.isFlagged,
      });
      for (const [key, data] of snapshot) {
        if (!data) continue;
        const scope = key[1] as Scope;
        qc.setQueryData<ListCache>(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            messages: page.messages
              .filter((m) => {
                if (!ids.has(m.id)) return true;
                if (p.set.mailbox !== undefined) return false; // moved somewhere else
                if (scope.box === "flagged" && p.set.isFlagged === false) return false;
                return true;
              })
              .map((m) => (ids.has(m.id) ? apply(m) : m)),
          })),
        });
      }
      for (const id of p.ids) {
        qc.setQueryData<MessageDetail>(["message", id], (d) => (d ? { ...d, ...apply(d) } : d));
      }
      return { snapshot };
    },
    onError: (err, _p, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
      toast.error((err as Error).message);
    },
    onSettled: (_d, _e, p) => {
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
      if (p.set.mailbox !== undefined) for (const id of p.ids) qc.invalidateQueries({ queryKey: ["message", id] });
    },
  });
}

export function useDeleteForever() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => post<{ deleted: number }>("/mail/messages/delete", { ids }),
    onError: (err) => toast.error((err as Error).message),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

export function useEmptyMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailbox: "trash" | "junk") => post<{ deleted: number }>("/mail/empty", { mailbox }),
    onSuccess: (d) => toast.success(`${d.deleted} message${d.deleted === 1 ? "" : "s"} permanently deleted`),
    onError: (err) => toast.error((err as Error).message),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}
