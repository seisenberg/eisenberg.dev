import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { ImageOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";

// Mail HTML is hostile input. Four independent layers keep it harmless and private:
//   1. DOMPurify removes scripts, event handlers, forms, frames, embeds and javascript: links.
//   2. The result is rendered in a sandboxed iframe WITHOUT allow-scripts, so nothing can execute
//      even if the sanitiser missed something.
//   3. A Content-Security-Policy inside the frame (and the page's own) forbids every network load
//      except images from this site. The browser never contacts a sender's server.
//   4. Remote images are replaced by same-size placeholders. Loading one tells the sender the
//      message was opened, so it only happens when asked for, and then through this server's
//      proxy: the sender sees an AWS address and a generic user agent, not the reader.

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)\s*((?:https?:)?\/\/[^'")\s]+)\s*\1\s*\)/gi;
const HAS_CSS_URL = /url\(\s*['"]?\s*(https?:)?\/\//i; // not global: safe to .test() repeatedly
/** 1x1 transparent gif: gives a blocked <img> a valid source so it keeps its box. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Proxy links by original address; null until the reader asks for images. */
type Links = Record<string, string> | null;

function sanitize(html: string, links: Links): { html: string; remote: string[] } {
  const remote = new Set<string>();
  /** A remote address becomes its proxy link, or nothing. The original is never left in place. */
  const resolve = (url: string): string | null => {
    const key = url.trim();
    remote.add(key);
    return links?.[key] ?? null;
  };
  const css = (text: string) => text.replace(CSS_URL, (_m, _q, url: string) => {
    const proxied = resolve(url);
    return proxied ? `url("${proxied}")` : "none";
  });

  const purify = DOMPurify();
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }
    // srcset would let the browser pick an address by itself; the plain src is enough
    el.removeAttribute?.("srcset");
    for (const attr of ["src", "background", "poster"]) {
      const v = el.getAttribute?.(attr);
      if (!v) continue;
      if (attr === "src" && /^\s*data:image\//i.test(v)) continue; // embedded in the message itself
      if (!REMOTE.test(v)) {
        el.removeAttribute(attr); // relative addresses would resolve against this site
        continue;
      }
      const proxied = resolve(v);
      if (proxied) {
        el.setAttribute(attr, proxied);
        if (el.tagName === "IMG") el.setAttribute("loading", "lazy");
      } else if (el.tagName === "IMG" && attr === "src") {
        // keep the box: same width and height, a neutral placeholder inside
        el.setAttribute("src", BLANK);
        el.setAttribute("data-blocked", "");
        // The stand-in picture is square, so state the real proportions or the layout would shift.
        const w = Number.parseInt(el.getAttribute("width") ?? "", 10);
        const h = Number.parseInt(el.getAttribute("height") ?? "", 10);
        if (w > 0 && h > 0) el.setAttribute("style", `${el.getAttribute("style") ?? ""};aspect-ratio:${w}/${h}`);
      } else {
        el.removeAttribute(attr);
      }
    }
    const style = el.getAttribute?.("style");
    if (style && HAS_CSS_URL.test(style)) el.setAttribute("style", css(style));
  });
  const clean = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "form", "input", "button", "select", "textarea", "meta", "link", "base", "audio", "video", "source", "svg", "math", "dialog"],
    FORBID_ATTR: ["action", "formaction", "ping", "autofocus"],
    ALLOW_DATA_ATTR: false,
  });

  // Only the body's content is used; our own head (with the CSP) is always in control.
  const parsed = new DOMParser().parseFromString(clean, "text/html");
  const styles = [...parsed.querySelectorAll("style")].map((s) => `<style>${safeCss(css(s.textContent ?? ""))}</style>`).join("");
  for (const s of parsed.body.querySelectorAll("style")) s.remove();
  return { html: styles + parsed.body.innerHTML, remote: [...remote] };
}

/**
 * A sender's stylesheet, made safe to place between <style> tags in the frame's markup. Remote
 * loads were already rewritten; the LAST step escapes every "<", so that nothing the earlier edits
 * produce (or the sender wrote) can close the style element and start real markup.
 */
function safeCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, "").replace(/</g, "\\3c ");
}

const PLACEHOLDER_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9aa3ae" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
  );

function frameDocument(body: string): string {
  // images: embedded ones, and this site (the proxy). Nothing else can be loaded at all.
  const csp = `default-src 'none'; img-src data: ${location.origin}; style-src 'unsafe-inline'; font-src data:`;
  const placeholder = `img[data-blocked]{background:#eef0f3 url("${PLACEHOLDER_ICON}") center/min(24px,60%) no-repeat;outline:1px dashed #c3c9d1;outline-offset:-1px;border-radius:3px}img[data-blocked]:not([width]):not([height]){width:120px;height:80px}img[data-blocked][width="1"],img[data-blocked][height="1"],img[data-blocked][width="0"],img[data-blocked][height="0"]{background:none;outline:none}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;padding:0}body{font:14px -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#1f2328;background:#fff;word-break:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0a66d8}blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #c9ced6;color:#57606a}${placeholder}</style></head><body>${body}</body></html>`;
}

/** Render with key={message id}: the choice to show images must never carry over to another message. */
export function HtmlBody({ html, messageId }: { html: string; messageId: string }) {
  const [links, setLinks] = useState<Links>(null);
  const [loading, setLoading] = useState(false);
  const [height, setHeight] = useState(200);
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const { doc, remote } = useMemo(() => {
    const clean = sanitize(html, links);
    return { doc: frameDocument(clean.html), remote: clean.remote };
  }, [html, links]);

  const showImages = async () => {
    setLoading(true);
    try {
      // The server only issues links for addresses that really are in this message.
      const res = await post<{ links: Record<string, string> }>(`/mail/messages/${messageId}/image-links`, { urls: remote });
      setLinks(res.links);
    } catch {
      setLinks({});
    } finally {
      setLoading(false);
    }
  };

  // The frame cannot run script, so the parent measures it. Mail laid out for a wide screen (fixed
  // 600px tables are common) is scaled down to fit a phone, the way native mail apps show it.
  useEffect(() => {
    const el = frame.current;
    const box = wrap.current;
    if (!el || !box) return;
    let observer: ResizeObserver | null = null;
    let raf = 0;
    let lastAvail = -1;
    const measure = () => {
      const d = el.contentDocument;
      if (!d?.documentElement) return;
      const avail = box.clientWidth;
      if (avail !== lastAvail) {
        // (re)measure the natural width at the available width
        el.style.width = `${avail}px`;
        lastAvail = avail;
      }
      const natural = Math.max(d.documentElement.scrollWidth, d.body?.scrollWidth ?? 0);
      const scale = natural > avail + 1 ? Math.max(avail / natural, 0.35) : 1;
      el.style.width = `${scale < 1 ? natural : avail}px`;
      el.style.transform = scale < 1 ? `scale(${scale})` : "";
      const contentHeight = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0, 60);
      el.style.height = `${contentHeight}px`;
      setHeight(Math.ceil(contentHeight * scale));
    };
    const onLoad = () => {
      lastAvail = -1;
      measure();
      const d = el.contentDocument;
      if (d?.body) {
        observer?.disconnect();
        // Measuring changes the frame's own size, so do it on the next frame rather than inside
        // the observer callback (which would be reported as a ResizeObserver loop).
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(measure);
        });
        observer.observe(d.body);
        // proxied images arrive later and change the height
        for (const img of d.images) img.addEventListener("load", measure, { once: true });
      }
    };
    const onResize = () => {
      lastAvail = -1;
      measure();
    };
    el.addEventListener("load", onLoad);
    window.addEventListener("resize", onResize);
    onLoad();
    return () => {
      el.removeEventListener("load", onLoad);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <div>
      {remote.length > 0 && links === null && (
        <div className="bg-muted text-muted-foreground mb-3 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs max-md:text-[13px]">
          <ImageOff className="size-3.5 shrink-0" />
          <span className="flex-1">Images are not shown, so the sender cannot tell that you opened this message.</span>
          <Button variant="outline" size="xs" disabled={loading} onClick={() => void showImages()}>
            {loading && <Loader2 className="animate-spin" />} Show images
          </Button>
        </div>
      )}
      {links !== null && (
        <div className="text-muted-foreground mb-3 px-1 text-xs">Images were fetched by this server. The sender can tell the message was opened, but not from which address or device.</div>
      )}
      <div ref={wrap} className="overflow-hidden rounded-md bg-white" style={{ height }}>
        <iframe
          ref={frame}
          title="Message body"
          // No allow-scripts: the content can never execute. allow-same-origin only lets this page measure the frame.
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          className="block origin-top-left border-0 bg-white"
        />
      </div>
    </div>
  );
}

const LINK = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Plain text bodies: rendered as React text nodes (never as HTML), with links made clickable. */
export function TextBody({ text }: { text: string }) {
  const parts = text.split(LINK);
  return (
    <pre className="font-sans text-[14px] leading-relaxed break-words whitespace-pre-wrap max-md:text-[16px]">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </pre>
  );
}
