import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Copy, Download, FileIcon, Globe, Loader2, Lock, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { get, post } from "@/lib/api";
import { useIsMobile } from "@/hooks/use-mobile";
import { fileSize, listDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FileEntry, FileListing, UploadTicket } from "../../shared/api";

type Listing = FileListing & { enabled: boolean };

interface UploadState {
  name: string;
  progress: number;
}

/** Makes a dropped file's name fit the server's rules instead of failing the upload. */
function safeName(name: string): string {
  const cleaned = name.normalize("NFC").replace(/[^A-Za-z0-9._ ()+,@=-]/g, "_").replace(/\.{2,}/g, ".").replace(/^[^A-Za-z0-9]+/, "").replace(/[. ]+$/, "");
  return cleaned.slice(0, 200) || "file";
}

function putWithProgress(ticket: UploadTicket, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    for (const [k, v] of Object.entries(ticket.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

/** "Photo 2026-10-04 14.32.10.jpg": the camera gives every picture the same name. */
function photoName(file: File): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const ext = /\.(jpe?g|png|heic|heif|webp)$/i.exec(file.name)?.[1].toLowerCase() ?? (file.type === "image/png" ? "png" : "jpg");
  return `Photo ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}.${ext}`;
}

export default function FilesPage({ header, footer, tabs }: { header: React.ReactNode; footer: React.ReactNode; tabs: React.ReactNode }) {
  const qc = useQueryClient();
  const listing = useQuery({ queryKey: ["files"], queryFn: () => get<Listing>("/files") });
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<"all" | "private" | "public">("all");
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["files"] });

  async function upload(files: File[]) {
    const existing = new Set(listing.data?.files.map((f) => f.name));
    for (const file of files) {
      const name = safeName(file.name);
      if (existing.has(name) && !window.confirm(`Replace the existing "${name}"?`)) continue;
      setUploads((u) => [...u, { name, progress: 0 }]);
      try {
        const ticket = await post<UploadTicket>("/files/uploads", { name, size: file.size, contentType: file.type || "application/octet-stream" });
        await putWithProgress(ticket, file, (progress) => setUploads((u) => u.map((x) => (x.name === name ? { ...x, progress } : x))));
        toast.success(`Uploaded ${name}`);
      } catch (err) {
        toast.error(`${name}: ${(err as Error).message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.name !== name));
        refresh();
      }
    }
  }

  const visibility = useMutation({
    mutationFn: (v: { file: FileEntry; makePublic: boolean }) => post("/files/visibility", { name: v.file.name, public: v.makePublic }),
    onSuccess: (_d, v) => toast.success(v.makePublic ? `${v.file.name} is now public` : `${v.file.name} is private again`),
    onError: (err) => toast.error((err as Error).message),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (file: FileEntry) => post("/files/delete", { name: file.name, visibility: file.isPublic ? "public" : "private" }),
    onError: (err) => toast.error((err as Error).message),
    onSettled: refresh,
  });

  const mobile = useIsMobile();
  const files = (listing.data?.files ?? []).filter((f) => filter === "all" || (filter === "public") === f.isPublic);
  const publicCount = listing.data?.files.filter((f) => f.isPublic).length ?? 0;

  const filterRow = (key: typeof filter, label: string, icon: React.ReactNode, count?: number) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      aria-current={filter === key ? "page" : undefined}
      className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]", filter === key ? "bg-selection text-selection-foreground" : "text-sidebar-foreground hover:bg-sidebar-hover")}
    >
      <span className={filter === key ? "" : "text-primary"}>{icon}</span>
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className={cn("text-xs tabular-nums", filter === key ? "opacity-90" : "text-muted-foreground")}>{count}</span>}
    </button>
  );

  const publicSwitch = (f: FileEntry) => (
    <Switch
      checked={f.isPublic}
      aria-label={`Public link for ${f.name}`}
      disabled={visibility.isPending}
      onCheckedChange={(checked) => {
        if (checked && !window.confirm(`Anyone with the link will be able to download "${f.name}". Make it public?`)) return;
        visibility.mutate({ file: f, makePublic: checked });
      }}
    />
  );
  const copyLink = (f: FileEntry) =>
    // On a phone the share sheet is the natural way to hand a link to another app.
    mobile && navigator.share
      ? navigator.share({ title: f.name, url: location.origin + f.publicPath }).catch(() => {})
      : navigator.clipboard.writeText(location.origin + f.publicPath).then(() => toast.success("Public link copied"), () => toast.error("Could not copy the link"));
  const downloadHref = (f: FileEntry) => `/api/files/download/${f.isPublic ? "public" : "private"}/${encodeURIComponent(f.name)}`;
  const confirmRemove = (f: FileEntry) => window.confirm(`Delete "${f.name}"? This cannot be undone.`) && remove.mutate(f);
  const uploadInput = (
    <>
      <input ref={picker} type="file" multiple hidden onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {/* capture: on a phone this opens the camera, and the picture goes straight into the file drop */}
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label="Take a photo"
        onChange={(e) => {
          const shot = e.target.files?.[0];
          if (shot) void upload([new File([shot], photoName(shot), { type: shot.type || "image/jpeg" })]);
          e.target.value = "";
        }}
      />
    </>
  );
  const uploadRows = uploads.map((u) => (
    <div key={u.name} className="flex items-center gap-3 border-b px-5 py-2.5 max-md:px-4">
      <Loader2 className="text-muted-foreground size-4 animate-spin" />
      <span className="min-w-0 flex-1 truncate">{u.name}</span>
      <div className="bg-muted h-1.5 w-40 overflow-hidden rounded-full max-md:w-24"><div className="bg-primary h-full transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>
    </div>
  ));

  // ---- phone ---------------------------------------------------------------------------------
  if (mobile) {
    const chip = (key: typeof filter, label: string) => (
      <button type="button" onClick={() => setFilter(key)} aria-pressed={filter === key} className={cn("h-8 rounded-full px-3.5 text-[14px]", filter === key ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>
        {label}
      </button>
    );
    return (
      <div className="bg-background h-app flex flex-col text-[15px]">
        <header className="top-bar pt-safe shrink-0 border-b px-4 pb-2">
          <div className="flex items-end gap-2 pt-3">
            <h1 className="flex-1 text-[28px] leading-tight font-bold tracking-tight">Files</h1>
            <Button size="sm" variant="outline" className="h-9" aria-label="Take a photo" onClick={() => camera.current?.click()} disabled={listing.data?.enabled === false}><Camera /> Photo</Button>
            <Button size="sm" className="h-9" onClick={() => picker.current?.click()} disabled={listing.data?.enabled === false}><Upload /> Upload</Button>
            {uploadInput}
          </div>
          <div className="flex items-center gap-2 pt-2.5">
            {chip("all", "All")}
            {chip("private", "Private")}
            {chip("public", `Public${publicCount ? ` ${publicCount}` : ""}`)}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          {listing.isLoading && <div className="text-muted-foreground flex h-40 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>}
          {listing.data?.enabled === false && <div className="text-muted-foreground m-4 rounded-lg border border-dashed p-6 text-center">File storage is not configured on this server.</div>}
          {uploadRows}
          {listing.data?.enabled !== false && !listing.isLoading && files.length === 0 && uploads.length === 0 && (
            <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-2">
              <Upload className="size-8 opacity-40" />
              <div className="text-base">{filter === "public" ? "No public files" : "Upload a file, or take a photo"}</div>
            </div>
          )}
          <ul>
            {files.map((f) => (
              <li key={(f.isPublic ? "p:" : "x:") + f.name} className="border-b px-4 py-3">
                <div className="flex items-center gap-3">
                  <FileIcon className="text-muted-foreground size-6 shrink-0" />
                  <a href={downloadHref(f)} className="min-w-0 flex-1" aria-label={`Download ${f.name}`}>
                    <div className="truncate text-[16px] font-medium">{f.name}</div>
                    <div className="text-muted-foreground text-[13px]">{fileSize(f.size)} · {listDate(f.modified)}</div>
                  </a>
                  <button type="button" aria-label={`Delete ${f.name}`} onClick={() => confirmRemove(f)} className="text-muted-foreground flex size-11 items-center justify-center"><Trash2 className="size-5" /></button>
                </div>
                <div className="mt-1 flex items-center gap-3 pl-9">
                  {publicSwitch(f)}
                  <span className="text-muted-foreground flex-1 text-[14px]">{f.isPublic ? "Public link is on" : "Private"}</span>
                  {f.publicPath && <Button variant="outline" size="sm" onClick={() => void copyLink(f)}><Copy /> Share link</Button>}
                </div>
              </li>
            ))}
          </ul>
        </div>
        {tabs}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="bg-sidebar flex w-64 shrink-0 flex-col border-r">
        {header}
        <nav aria-label="File filters" className="flex-1 px-2">
          <div className="text-muted-foreground px-2 pt-4 pb-1 text-[11px] font-semibold">File Drop</div>
          {filterRow("all", "All Files", <FileIcon className="size-4" />, listing.data?.files.length)}
          {filterRow("private", "Private", <Lock className="size-4" />)}
          {filterRow("public", "Public", <Globe className="size-4" />, publicCount)}
        </nav>
        {footer}
      </aside>

      <main
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b px-5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold">{filter === "all" ? "All Files" : filter === "public" ? "Public" : "Private"}</div>
            <div className="text-muted-foreground text-[11px]">Files are private unless you switch on a public link.</div>
          </div>
          <Button size="sm" onClick={() => picker.current?.click()} disabled={listing.data?.enabled === false}><Upload /> Upload</Button>
          {uploadInput}
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {listing.isLoading && <div className="text-muted-foreground flex h-40 items-center justify-center"><Loader2 className="size-5 animate-spin" /></div>}
          {listing.data?.enabled === false && (
            <div className="text-muted-foreground m-8 rounded-lg border border-dashed p-8 text-center">File storage is not configured on this server. Set FILES_BUCKET to enable the file drop.</div>
          )}
          {uploadRows}
          {listing.data?.enabled !== false && !listing.isLoading && files.length === 0 && uploads.length === 0 && (
            <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-2">
              <Upload className="size-8 opacity-40" />
              <div className="text-base">{filter === "public" ? "No public files" : "Drop files here to upload"}</div>
            </div>
          )}
          {files.length > 0 && (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-muted-foreground border-b text-left text-xs">
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="w-24 px-3 py-2 font-medium">Size</th>
                  <th className="w-28 px-3 py-2 font-medium">Modified</th>
                  <th className="w-40 px-3 py-2 font-medium">Public link</th>
                  <th className="w-24 px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={(f.isPublic ? "p:" : "x:") + f.name} className="hover:bg-accent/50 border-b">
                    <td className="max-w-0 px-5 py-2">
                      <div className="flex items-center gap-2">
                        <FileIcon className="text-muted-foreground size-4 shrink-0" />
                        <span className="truncate font-medium" title={f.name}>{f.name}</span>
                      </div>
                    </td>
                    <td className="text-muted-foreground px-3 py-2 tabular-nums">{fileSize(f.size)}</td>
                    <td className="text-muted-foreground px-3 py-2">{listDate(f.modified)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {publicSwitch(f)}
                        {f.publicPath && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => void copyLink(f)}
                          >
                            <Copy /> Copy link
                          </Button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-0.5">
                        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
                          <a href={downloadHref(f)} aria-label={`Download ${f.name}`}><Download /></a>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Delete ${f.name}`}
                          onClick={() => confirmRemove(f)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {dragging && <div className="border-primary bg-primary/10 text-primary pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed text-base font-medium">Drop to upload</div>}
      </main>
    </div>
  );
}
