import { FilePen, Loader2, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { listDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDrafts } from "./data";
import type { Draft } from "../../shared/api";

/** Autosaved drafts. Opening one continues it in the compose window. */
export function DraftsList({ onOpen, mobile }: { onOpen: (d: Draft) => void; mobile: boolean }) {
  const qc = useQueryClient();
  const drafts = useDrafts();
  if (drafts.isLoading) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (!drafts.data?.length) return <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm">No Drafts</div>;
  const remove = async (d: Draft) => {
    if (!window.confirm("Delete this draft?")) return;
    await post("/mail/drafts/delete", { id: d.id }).catch(() => {});
    void qc.invalidateQueries({ queryKey: ["drafts"] });
  };
  return (
    <div role="list" aria-label="Drafts" className={cn("scroll-thin min-h-0 flex-1 overflow-y-auto", mobile ? "pb-safe" : "py-1.5")}>
      {drafts.data.map((d, i) => (
        <div key={d.id} role="listitem">
          {i > 0 && <div className={cn("bg-border h-px", mobile ? "ml-9" : "mr-5 ml-7")} />}
          <div className={cn("group flex items-start gap-2", mobile ? "py-2.5 pr-2 pl-2.5 active:bg-accent" : "hover:bg-accent/60 mx-2 rounded-lg py-2 pr-2 pl-1.5")}>
            <button type="button" onClick={() => onOpen(d)} className="flex min-w-0 flex-1 gap-2 text-left">
              <FilePen className="text-muted-foreground mt-1 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium max-md:text-[17px]">{d.payload.to || "(no recipient)"}</span>
                  <span className="text-muted-foreground shrink-0 text-xs max-md:text-[14px]">{listDate(d.updatedAt)}</span>
                </span>
                <span className="block truncate text-[13px] max-md:text-[15px]">{d.payload.subject || "(no subject)"}</span>
                <span className="text-muted-foreground line-clamp-2 text-xs leading-snug max-md:text-[15px]">{d.payload.text.replace(/\s+/g, " ").trim().slice(0, 200)}</span>
              </span>
            </button>
            <button type="button" aria-label="Delete draft" onClick={() => void remove(d)} className="text-muted-foreground hover:text-destructive flex size-8 shrink-0 items-center justify-center rounded md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100">
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
