import type { ApiError } from "../../shared/api";

export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Called when the server says the session is gone, so the app can send the user to sign in. */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null) {
  onUnauthenticated = fn;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  // Required by the server on every state-changing request (CSRF defence).
  if (method !== "GET") headers["X-Eisenmail"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiFailure(0, "Could not reach the server");
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    if (res.status === 401 && err.code === "unauthenticated") onUnauthenticated?.();
    throw new ApiFailure(res.status, err.error ?? `Request failed (${res.status})`, err.code);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const patch = <T,>(path: string, body: unknown) => api<T>("PATCH", path, body);
