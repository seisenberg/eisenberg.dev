import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";

// Mail HTML is hostile input. Three independent layers keep it harmless:
//   1. DOMPurify removes scripts, event handlers, forms, frames, embeds and javascript: links.
//   2. The result is rendered in a sandboxed iframe WITHOUT allow-scripts, so nothing can execute
//      even if the sanitiser missed something.
//   3. A Content-Security-Policy inside the frame forbids all network loads except, when the
//      reader asks for them, remote images. Remote content is blocked by default because it is
//      how senders track opens.

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi;
const HAS_CSS_URL = /url\(\s*['"]?\s*(https?:)?\/\//i; // not global: safe to .test() repeatedly

function sanitize(html: string, allowRemote: boolean): { html: string; blocked: number } {
  let blocked = 0;
  const purify = DOMPurify();
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }
    // Anything that would load a resource. Only embedded (data:) content is ever allowed without asking,
    // and relative URLs are always dropped: they would resolve against this site.
    for (const attr of ["src", "srcset", "background", "poster"]) {
      const v = el.getAttribute?.(attr);
      if (!v) continue;
      const embedded = /^\s*data:image\//i.test(v) && attr === "src";
      const remote = REMOTE.test(v) || attr === "srcset";
      if (embedded || (remote && allowRemote && /^\s*https:\/\//i.test(v))) continue;
      el.removeAttribute(attr);
      if (remote) blocked++;
    }
    if (!allowRemote) {
      const style = el.getAttribute?.("style");
      if (style && HAS_CSS_URL.test(style)) {
        el.setAttribute("style", style.replace(CSS_URL, "none"));
        blocked++;
      }
    }
  });
  const clean = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "form", "input", "button", "select", "textarea", "meta", "link", "base", "audio", "video", "source", "svg", "math", "dialog"],
    FORBID_ATTR: ["action", "formaction", "ping", "autofocus"],
    ALLOW_DATA_ATTR: false,
  });
  return { html: clean, blocked };
}

/**
 * A sender's stylesheet, made safe to place between <style> tags in the frame's markup. The text is
 * stripped of remote loads first; the LAST step escapes every "<", so that nothing the earlier
 * edits produce (or the sender wrote) can close the style element and start real markup.
 */
function safeCss(css: string, allowRemote: boolean): string {
  const local = allowRemote ? css : css.replace(CSS_URL, "none").replace(/@import[^;]*;?/gi, "");
  return local.replace(/</g, "\\3c ");
}

function frameDocument(body: string, allowRemote: boolean): string {
  const img = allowRemote ? "img-src data: https:" : "img-src data:";
  const csp = `default-src 'none'; ${img}; style-src 'unsafe-inline'; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;padding:0}body{font:14px -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#1f2328;background:#fff;word-break:break-word;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0a66d8}blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #c9ced6;color:#57606a}</style></head><body>${body}</body></html>`;
}

/** Render with key={message id}: the "load remote content" choice must never carry over to another message. */
export function HtmlBody({ html }: { html: string }) {
  const [allowRemote, setAllowRemote] = useState(false);
  const [height, setHeight] = useState(200);
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const { doc, blocked } = useMemo(() => {
    const clean = sanitize(html, allowRemote);
    // Only the body's content is used; our own head (with the CSP) is always in control.
    const parsed = new DOMParser().parseFromString(clean.html, "text/html");
    const styles = [...parsed.querySelectorAll("style")].map((s) => `<style>${safeCss(s.textContent ?? "", allowRemote)}</style>`).join("");
    for (const s of parsed.body.querySelectorAll("style")) s.remove();
    return { doc: frameDocument(styles + parsed.body.innerHTML, allowRemote), blocked: clean.blocked };
  }, [html, allowRemote]);

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
      {blocked > 0 && !allowRemote && (
        <div className="bg-muted text-muted-foreground mb-3 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs">
          <ImageOff className="size-3.5 shrink-0" />
          <span className="flex-1">Remote content was blocked to protect your privacy.</span>
          <Button variant="outline" size="xs" onClick={() => setAllowRemote(true)}>Load remote content</Button>
        </div>
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
