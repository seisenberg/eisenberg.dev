import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";

/** True on phone-sized screens. The mail and files pages switch to a single-column, touch layout. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
