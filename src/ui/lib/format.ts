const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const short = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
const full = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Message list dates the way Mail shows them: time today, "Yesterday", weekday this week, then a short date. */
export function listDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return time.format(d);
  if (days === 1) return "Yesterday";
  if (days < 7) return weekday.format(d);
  return short.format(d);
}

export const fullDate = (iso: string) => full.format(new Date(iso));

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function initials(name: string, address: string): string {
  const source = name.trim() || address.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

const AVATAR_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#64748b"];
export function avatarColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** "a@b.c, Name <d@e.f>; g@h.i" -> ["a@b.c", "d@e.f", "g@h.i"]; invalid entries are returned separately. */
export function parseRecipients(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const piece of input.split(/[,;\n]+/)) {
    const raw = piece.trim();
    if (!raw) continue;
    const angle = /<([^>]+)>/.exec(raw);
    const addr = (angle ? angle[1] : raw).trim().toLowerCase();
    if (EMAIL_RE.test(addr)) valid.push(addr);
    else invalid.push(raw);
  }
  return { valid: [...new Set(valid)], invalid };
}
