import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Contact } from "../../shared/api";

/** The part of a comma separated recipient field that is being typed right now. */
function lastToken(value: string): { start: number; token: string } {
  const start = Math.max(value.lastIndexOf(","), value.lastIndexOf(";")) + 1;
  return { start, token: value.slice(start).trim() };
}

/**
 * A recipient field that suggests people from earlier mail. Free text always works: suggestions
 * only complete the address being typed. Up/Down choose, Enter or Tab accept, Escape closes.
 */
export function RecipientInput({ id, value, onChange, inputRef, placeholder, className }: { id: string; value: string; onChange: (v: string) => void; inputRef?: React.Ref<HTMLInputElement>; placeholder?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState("");
  const { token, start } = lastToken(value);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(token), 150);
    return () => clearTimeout(t);
  }, [token]);
  const suggestions = useQuery({
    queryKey: ["contacts", debounced],
    queryFn: () => get<Contact[]>(`/mail/contacts?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2 && !debounced.includes(" <"),
    staleTime: 60_000,
  });
  const already = new Set(value.toLowerCase().split(/[,;]/).map((s) => s.trim()));
  const items = (open && token.length >= 2 ? suggestions.data ?? [] : []).filter((c) => !already.has(c.address));
  useEffect(() => setActive(0), [debounced]);

  const accept = (c: Contact) => {
    const prefix = value.slice(0, start).trimEnd();
    onChange(`${prefix}${prefix ? " " : ""}${c.address}, `);
    setOpen(false);
  };

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <input
        id={id}
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="email"
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={`${id}-suggestions`}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (items.length === 0) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            accept(items[active] ?? items[0]);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {items.length > 0 && (
        <ul id={`${id}-suggestions`} role="listbox" className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 max-h-64 w-[min(26rem,80vw)] overflow-y-auto rounded-md border p-1 shadow-md">
          {items.map((c, i) => (
            <li
              key={c.address}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: it fires before the input's blur closes the list
              onMouseDown={(e) => {
                e.preventDefault();
                accept(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("flex cursor-default flex-col rounded px-2 py-1.5 text-[13px] max-md:py-2.5 max-md:text-[15px]", i === active && "bg-accent")}
            >
              {c.name && <span className="truncate font-medium">{c.name}</span>}
              <span className={cn("truncate", c.name && "text-muted-foreground text-xs max-md:text-[13px]")}>{c.address}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
