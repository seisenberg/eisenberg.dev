import { useEffect, useState } from "react";
import { get, post } from "./api";
import type { PushStatus } from "../../shared/api";

// Everything that makes the site behave like an installed app: the service worker, the install
// prompt, push subscriptions and the home screen badge.

/** Running from the home screen (installed) rather than in a browser tab. */
export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIOS(): boolean {
  // iPadOS reports itself as a Mac, but only touch Macs are iPads.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;
export function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  registration ??= (async () => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      return await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
  })();
  return registration;
}

// ---- install ---------------------------------------------------------------------------------

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: InstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own button
    deferredPrompt = e as InstallPromptEvent;
    promptListeners.forEach((fn) => fn());
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    promptListeners.forEach((fn) => fn());
  });
}

export type InstallState =
  | { kind: "installed" }
  /** Chrome, Edge, Android: one tap */
  | { kind: "prompt"; install: () => Promise<boolean> }
  /** iPhone / iPad: there is no API, the person has to use the Share menu */
  | { kind: "ios" }
  | { kind: "manual" };

export function useInstall(): InstallState {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    promptListeners.add(fn);
    return () => void promptListeners.delete(fn);
  }, []);
  if (isStandalone()) return { kind: "installed" };
  if (deferredPrompt) {
    const event = deferredPrompt;
    return {
      kind: "prompt",
      install: async () => {
        await event.prompt();
        const choice = await event.userChoice;
        deferredPrompt = null;
        promptListeners.forEach((fn) => fn());
        return choice.outcome === "accepted";
      },
    };
  }
  return isIOS() ? { kind: "ios" } : { kind: "manual" };
}

// ---- push ------------------------------------------------------------------------------------

export type PushSupport = "ok" | "unsupported" | "needs-install" | "denied";

/** Whether this browser can receive notifications right now, and if not, why. */
export function pushSupport(): PushSupport {
  const hasApi = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  // On iPhone and iPad, web push only exists for apps added to the home screen.
  if (isIOS() && !isStandalone()) return "needs-install";
  if (!hasApi) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await serviceWorker();
  return (await reg?.pushManager?.getSubscription()) ?? null;
}

/** Must be called from a tap or click: browsers only show the permission prompt in response to one. */
export async function enablePush(): Promise<void> {
  const status = await get<PushStatus>("/push");
  if (!status.available || !status.publicKey) throw new Error("Notifications are not set up on the server yet");
  const reg = await serviceWorker();
  if (!reg?.pushManager) throw new Error("This browser does not support notifications");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed");
  const existing = await reg.pushManager.getSubscription();
  // A subscription made with another server key cannot be reused.
  if (existing) await existing.unsubscribe().catch(() => {});
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
  const json = sub.toJSON();
  await post("/push/subscribe", { endpoint: json.endpoint, keys: json.keys });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// ---- badge -----------------------------------------------------------------------------------

/** Unread count on the home screen / dock icon, where the platform supports it. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (count > 0) nav.setAppBadge?.(count).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}
