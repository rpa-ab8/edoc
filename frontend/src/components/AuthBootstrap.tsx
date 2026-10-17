import { useEffect, type ReactNode } from "react";
import { apiRequest, refreshAccessToken } from "../lib/api";
import { useAuthStore, type AuthUser, type OrganizationSummary } from "../store/authStore";

export function AuthBootstrap({ children }: { children: ReactNode }) {
  useEffect(() => {
    (async () => {
      try {
        const accessToken = await refreshAccessToken();
        if (!accessToken) return;
        useAuthStore.getState().setAccessToken(accessToken);
        const me = await apiRequest<{ user: AuthUser; organizations: OrganizationSummary[] }>(
          "/auth/me",
        );
        useAuthStore.getState().setSession({ accessToken, user: me.user, organizations: me.organizations });
      } catch {
        // No valid session — user stays logged out.
      } finally {
        useAuthStore.getState().setInitialized(true);
      }
    })();
  }, []);

  return <>{children}</>;
}
