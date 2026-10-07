import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Ellipsis, EyeOff, Flag, Loader2, Pencil, Plus, Reply, Search, SquarePen, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";
import { avatarColor, initials, listDate } from "@/lib/format";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useMessages } from "../mail/data";
import type { MessageSummary, PersonDetail, PersonInput, PersonSummary } from "../../shared/api";

// People: the address book. One list, one card, and everything exchanged with the person.

const label = (p: { name: string; company: string; addresses: string[] }) => p.name || p.company || p.addresses[0] || "(no name)";

function Avatar({ name, address, className = "size-10 text-sm" }: { name: string; address: string; className?: string }) {
  return (
    <div aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)} style={{ background: avatarColor(address || name) }}>
      {initials(name, address)}
    </div>
  );
}

function usePeople(q: string) {
  return useQuery({ queryKey: ["people", q], queryFn: () => get<PersonSummary[]>(`/people${q ? `?q=${encodeURIComponent(q)}` : ""}`), staleTime: 10_000, refetchOnWindowFocus: true });
}

/** The form for a new person and for editing one. Addresses are one per line, or comma separated. */
function PersonForm({ initial, onDone, onCancel, mobile }: { initial: Partial<PersonDetail> & { id?: string }; onDone: (id: string) => void; onCancel: () => void; mobile: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial.name ?? "");
  const [company, setCompany] = useState(initial.company ?? "");
  const [addresses, setAddresses] = useState((initial.addresses ?? []).map((a) => a.address).join("\n"));
  const [note, setNote] = useState(initial.note ?? "");
  const save = useMutation({
    mutationFn: async () => {
      const body: PersonInput = { name, company, note, addresses };
      if (initial.id) {
        await post("/people/update", { id: initial.id, ...body });
        return initial.id;
      }
      return (await post<{ id: string }>("/people", body)).id;
    },
    onSuccess: (id) => {
      void qc.invalidateQueries({ queryKey: ["people"] });
      void qc.invalidateQueries({ queryKey: ["person", id] });
      onDone(id);
    },
    onError: (err) => toast.error((err as Error).message),
  });
  const field = cn("space-y-1.5", mobile && "[&_input]:h-11 [&_input]:text-[16px] [&_textarea]:text-[16px]");
  return (
    <form
      className={cn("grid gap-3", mobile ? "px-4 py-3" : "max-w-xl px-6 py-5")}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={field}><Label htmlFor="p-name">Name</Label><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!initial.id} /></div>
        <div className={field}><Label htmlFor="p-company">Company</Label><Input id="p-company" value={company} onChange={(e) => setCompany(e.target.value)} /></div>
      </div>
      <div className={field}>
        <Label htmlFor="p-addresses">Email addresses</Label>
        <Textarea id="p-addresses" value={addresses} onChange={(e) => setAddresses(e.target.value)} rows={3} spellCheck={false} autoCapitalize="none" className="font-mono text-[13px]" placeholder="one per line" />
        <p className="text-muted-foreground text-xs">An address that belongs to another person moves over here: that is how two entries are merged.</p>
      </div>
      <div className={field}><Label htmlFor="p-note">Note</Label><Textarea id="p-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Who this is, how you know them" /></div>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending} className={cn(mobile && "h-11")}>{save.isPending && <Loader2 className="animate-spin" />} Save</Button>
        <Button type="button" variant="ghost" onClick={onCancel} className={cn(mobile && "h-11")}>Cancel</Button>
      </div>
    </form>
  );
}

function Correspondence({ id, mobile }: { id: string; mobile: boolean }) {
  const navigate = useNavigate();
  const list = useMessages({ box: "inbox", person: id }, "");
  const messages = list.data?.pages.flatMap((p) => p.messages) ?? [];
  const open = (m: MessageSummary) => navigate(`/mail?person=${id}&id=${m.id}`);
  if (list.isPending) return <div className="text-muted-foreground flex items-center justify-center py-10"><Loader2 className="size-5 animate-spin" /></div>;
  if (messages.length === 0) return <p className="text-muted-foreground px-6 py-6 text-[13px] max-md:px-4 max-md:text-[15px]">No mail with this person yet.</p>;
  return (
    <ul className="py-1">
      {messages.map((m) => (
        <li key={m.id}>
          <button
            type="button"
            onClick={() => open(m)}
            className={cn("flex w-full gap-1.5 text-left", mobile ? "border-b py-2.5 pr-4 pl-2.5 active:bg-accent" : "mx-2 w-[calc(100%-1rem)] rounded-lg py-2 pr-3 pl-1.5 hover:bg-accent/60")}
          >
            <div className="flex w-3.5 shrink-0 flex-col items-center gap-1.5 pt-1.5">
              {!m.isRead && m.direction === "in" && <span aria-label="Unread" className="bg-primary size-2 rounded-full" />}
              {m.direction === "out" && <Reply aria-label="Sent by you" className="text-muted-foreground size-3" />}
              {m.isFlagged && <Flag aria-label="Flagged" className="size-3 fill-current text-flag" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className={cn("min-w-0 flex-1 truncate text-[13px] max-md:text-[17px]", m.isRead || m.direction === "out" ? "font-medium" : "font-bold")}>{m.direction === "out" ? "You" : m.from.name || m.from.address}</span>
                <span className="text-muted-foreground shrink-0 text-[11px] max-md:text-[13px]">{listDate(m.date)}</span>
              </div>
              <div className="truncate text-[13px] max-md:text-[15px]">{m.subject || "(no subject)"}</div>
              <div className="text-muted-foreground line-clamp-2 text-[12px] max-md:text-[15px]">{m.snippet}</div>
              <span className="bg-primary/10 text-primary mt-1 inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[10px] max-md:text-[12px]">{m.addresses[0]}</span>
            </div>
          </button>
        </li>
      ))}
      {list.hasNextPage && (
        <li className="px-4 py-3 text-center">
          <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Older messages</Button>
        </li>
      )}
    </ul>
  );
}

function Detail({ id, mobile, onBack }: { id: string; mobile: boolean; onBack: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const person = useQuery({ queryKey: ["person", id], queryFn: () => get<PersonDetail>(`/people/${id}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["people"] });
    void qc.invalidateQueries({ queryKey: ["person", id] });
  };
  const hide = useMutation({ mutationFn: (hidden: boolean) => post("/people/update", { id, hidden }), onSuccess: refresh, onError: (e) => toast.error((e as Error).message) });
  const remove = useMutation({
    mutationFn: () => post("/people/delete", { id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["people"] });
      toast.success("Removed. The entry comes back by itself with the next message from them, unless you hide it instead.");
      onBack();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  useEffect(() => setEditing(false), [id]);

  if (person.isPending) return <div className="text-muted-foreground flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>;
  if (!person.data) return <div className="text-muted-foreground flex flex-1 items-center justify-center text-[13px]">{(person.error as Error)?.message ?? "Not found"}</div>;
  const p = person.data;
  const addresses = p.addresses.map((a) => a.address);
  const received = p.addresses.reduce((n, a) => n + a.received, 0);
  const sent = p.addresses.reduce((n, a) => n + a.sent, 0);
  const last = p.addresses.map((a) => a.lastSeen).filter((d): d is string => !!d).sort().at(-1);
  const write = () => navigate(`/mail?compose=1&to=${encodeURIComponent(addresses[0] ?? "")}`);

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {mobile ? (
          <button type="button" aria-label="More" className="text-primary flex h-11 min-w-11 items-center justify-center rounded-lg active:bg-accent [&_svg]:size-[22px]"><Ellipsis /></button>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="More" className="text-muted-foreground"><Ellipsis /></Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-md:[&_[role=menuitem]]:py-2.5 max-md:[&_[role=menuitem]]:text-[15px]">
        <DropdownMenuItem onSelect={() => hide.mutate(!p.hidden)}><EyeOff /> {p.hidden ? "Show in the list again" : "Hide (not a person)"}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => { if (window.confirm(`Remove ${label({ ...p, addresses })}?\n\nTheir mail stays. The entry comes back with their next message; hide it if that is not wanted.`)) remove.mutate(); }}>
          <Trash2 /> Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const card = (
    <div className={cn("flex items-start gap-3", mobile ? "px-4 pt-2 pb-3" : "px-6 py-5")}>
      <Avatar name={p.name} address={addresses[0] ?? ""} className={mobile ? "size-14 text-lg" : "size-14 text-lg"} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h1 className={cn("truncate font-semibold", mobile ? "text-[22px]" : "text-[20px]")}>{label({ ...p, addresses })}</h1>
          {p.company && p.name && <span className="text-muted-foreground truncate text-[13px] max-md:text-[15px]">{p.company}</span>}
          {p.hidden && <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">Hidden</span>}
        </div>
        <div className={cn("text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5", mobile ? "text-[14px]" : "text-[12px]")}>
          {p.addresses.map((a) => <span key={a.address} className="truncate" title={a.nameSeen ? `"${a.nameSeen}"` : undefined}>{a.address}</span>)}
          {p.addresses.length === 0 && <span className="italic">No address</span>}
        </div>
        <div className={cn("mt-1 flex flex-wrap items-center gap-x-3", mobile ? "text-[14px]" : "text-[12px]")}>
          {p.note ? <span className="italic">{p.note}</span> : null}
          <span className="text-muted-foreground">{received + sent === 0 ? "No mail yet" : `${received} received, ${sent} sent${last ? `, last ${listDate(last)}` : ""}`}{p.manual ? "" : " · added from mail"}</span>
        </div>
      </div>
      {!mobile && (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="outline" className="h-8" onClick={write} disabled={addresses.length === 0}><SquarePen /> Write</Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground h-8" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
          {menu}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mobile && (
        <div className="pt-safe flex h-12 shrink-0 items-center gap-1 px-1">
          <button type="button" onClick={onBack} className="text-primary flex h-11 items-center gap-0.5 rounded-lg pr-3 pl-1 text-[17px] active:bg-accent"><ChevronLeft /> People</button>
          <div className="flex-1" />
          {!editing && <button type="button" aria-label="Edit" onClick={() => setEditing(true)} className="text-primary flex h-11 min-w-11 items-center justify-center rounded-lg active:bg-accent [&_svg]:size-[22px]"><Pencil /></button>}
          {!editing && <button type="button" aria-label="Write" onClick={write} disabled={addresses.length === 0} className="text-primary flex h-11 min-w-11 items-center justify-center rounded-lg active:bg-accent disabled:opacity-40 [&_svg]:size-[22px]"><SquarePen /></button>}
          {!editing && menu}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {editing ? (
          <PersonForm initial={p} mobile={mobile} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        ) : (
          <>
            {card}
            <div className="text-muted-foreground flex items-center gap-2 border-y px-6 py-2 text-[11px] font-semibold max-md:px-4 max-md:text-[13px]">Correspondence</div>
            <Correspondence id={id} mobile={mobile} />
          </>
        )}
      </div>
    </div>
  );
}

export default function PeoplePage({ header, footer, tabs }: { header: React.ReactNode; footer: React.ReactNode; tabs: React.ReactNode }) {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<Partial<PersonDetail> | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const selected = /^\/people\/([0-9]+)$/.exec(location.pathname)?.[1];
  const people = usePeople(q.trim());

  // "/people?address=x", from a sender's name in a message: open that person, or start a new one
  const wanted = params.get("address");
  useEffect(() => {
    if (!wanted) return;
    void get<{ id: string | null }>(`/people/by-address?address=${encodeURIComponent(wanted)}`).then((r) => {
      if (r.id) navigate(`/people/${r.id}`, { replace: true });
      else {
        setAdding({ addresses: [{ address: wanted, nameSeen: "", firstSeen: "", lastSeen: null, received: 0, sent: 0 }] });
        navigate("/people", { replace: true });
      }
    });
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const out = new Map<string, PersonSummary[]>();
    for (const p of people.data ?? []) {
      if (p.hidden && !showHidden) continue;
      const key = p.hidden ? "Hidden" : (label(p)[0] ?? "#").toUpperCase().replace(/[^A-Z]/, "#");
      out.set(key, [...(out.get(key) ?? []), p]);
    }
    return out;
  }, [people.data, showHidden]);
  const hiddenCount = people.data?.filter((p) => p.hidden).length ?? 0;
  const total = people.data?.filter((p) => !p.hidden).length ?? 0;

  const openPerson = (id: string) => {
    setAdding(null);
    navigate(`/people/${id}`, mobile ? { state: { pushed: true } } : undefined);
  };
  const back = () => navigate("/people");

  const search = (
    <div className={cn("bg-muted flex items-center gap-2 rounded-md px-2.5", mobile ? "h-10 rounded-lg" : "h-8")}>
      <Search className="text-muted-foreground size-4 shrink-0" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground", mobile ? "text-[16px]" : "text-[13px]")} />
      {q && <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="text-muted-foreground"><X className="size-3.5" /></button>}
    </div>
  );

  const list = (
    <div className="min-h-0 flex-1 overflow-auto" role="listbox" aria-label="People">
      {people.isPending && <div className="text-muted-foreground flex items-center justify-center py-10"><Loader2 className="size-5 animate-spin" /></div>}
      {people.data && people.data.length === 0 && (
        <p className="text-muted-foreground px-4 py-8 text-center text-[13px] max-md:text-[15px]">{q ? "Nobody matches." : "Nobody yet. People appear here as mail arrives, or add one."}</p>
      )}
      {[...groups.entries()].map(([key, items]) => (
        <div key={key}>
          <div className={cn("text-muted-foreground px-4 pt-3 pb-1 font-semibold", mobile ? "text-[13px]" : "text-[11px]")}>{key}</div>
          {items.map((p) => {
            const active = !mobile && selected === p.id;
            return (
              <div
                key={p.id}
                role="option"
                aria-selected={active}
                onClick={() => openPerson(p.id)}
                className={cn("flex cursor-default items-center gap-3", mobile ? "border-b px-4 py-3 active:bg-accent" : "mx-2 rounded-lg px-2 py-1.5", active ? "bg-selection text-selection-foreground" : !mobile && "hover:bg-accent/60", p.hidden && "opacity-60")}
              >
                <Avatar name={p.name} address={p.addresses[0] ?? ""} className={mobile ? "size-10 text-sm" : "size-8 text-[12px]"} />
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate font-medium", mobile ? "text-[17px]" : "text-[13px]")}>{label(p)}</div>
                  <div className={cn("truncate", mobile ? "text-[14px]" : "text-[11px]", active ? "text-selection-foreground/80" : "text-muted-foreground")}>{p.name ? p.company || p.addresses[0] : p.addresses[0] ? (p.company ? p.addresses[0] : "") : ""}</div>
                </div>
                {p.lastSeen && <span className={cn("shrink-0 tabular-nums", mobile ? "text-[14px]" : "text-[11px]", active ? "text-selection-foreground/80" : "text-muted-foreground")}>{listDate(p.lastSeen)}</span>}
                {mobile && <ChevronRight className="text-muted-foreground size-4 shrink-0" />}
              </div>
            );
          })}
        </div>
      ))}
      {hiddenCount > 0 && !q && (
        <button type="button" onClick={() => setShowHidden((v) => !v)} className={cn("text-muted-foreground w-full px-4 py-3 text-left", mobile ? "text-[14px]" : "text-[11px]")}>
          {showHidden ? "Hide the hidden entries" : `${hiddenCount} hidden`}
        </button>
      )}
    </div>
  );

  const newForm = adding && (
    <div className="flex min-h-0 flex-1 flex-col">
      {mobile ? (
        <div className="pt-safe flex h-12 shrink-0 items-center px-1"><button type="button" onClick={() => setAdding(null)} className="text-primary flex h-11 items-center gap-0.5 rounded-lg pr-3 pl-1 text-[17px] active:bg-accent"><ChevronLeft /> People</button></div>
      ) : (
        <div className="flex h-[52px] shrink-0 items-center border-b px-6 text-[13px] font-bold">New person</div>
      )}
      <div className="min-h-0 flex-1 overflow-auto"><PersonForm initial={adding} mobile={mobile} onDone={(id) => { setAdding(null); navigate(`/people/${id}`); }} onCancel={() => setAdding(null)} /></div>
    </div>
  );

  if (mobile) {
    if (adding) return <div className="bg-background h-app flex flex-col text-[15px]">{newForm}</div>;
    if (selected) return <div className="bg-background h-app flex flex-col text-[15px]"><Detail id={selected} mobile onBack={back} /></div>;
    return (
      <div className="bg-background h-app flex flex-col text-[15px]">
        <div className="pt-safe flex shrink-0 items-center justify-between px-4 pt-3">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">People</h1>
          <Button size="sm" className="h-9" onClick={() => setAdding({})}><Plus /> New</Button>
        </div>
        <div className="px-4 pt-2 pb-2">{search}</div>
        {list}
        {tabs}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="bg-sidebar flex w-64 shrink-0 flex-col border-r">
        {header}
        <div className="text-muted-foreground flex-1 px-4 pt-4 text-xs leading-relaxed">People you have written to, or who wrote to you. New ones appear by themselves; edit a name or add a note any time.</div>
        {footer}
      </aside>
      <div className="flex w-[380px] shrink-0 flex-col border-r">
        <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
          <div className="min-w-0 flex-1"><div className="text-[13px] font-bold">People</div><div className="text-muted-foreground text-[11px]">{total} {total === 1 ? "person" : "people"}</div></div>
          <Button variant="ghost" size="icon-sm" aria-label="New person" className="text-muted-foreground hover:text-foreground" onClick={() => setAdding({})}><Plus /></Button>
        </div>
        <div className="shrink-0 px-3 pt-2 pb-1">{search}</div>
        {list}
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        {adding ? newForm : selected ? <Detail id={selected} mobile={false} onBack={back} /> : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-[13px]">Choose a person, or add one.</div>
        )}
      </main>
    </div>
  );
}
