import { useQuery } from "@tanstack/react-query";
import { ApiFailure, get } from "./api";
import type { SessionUser } from "../../shared/api";

/** The signed-in user, or null when there is no session. */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        return await get<SessionUser>("/auth/me");
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}
