import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { StatusPill } from "../components/AuthCard";

export function SelectOrganizationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const organizations = useAuthStore((s) => s.organizations);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);

  async function pick(organizationId: string) {
    setError(null);
    setSelecting(organizationId);
    try {
      const result = await apiRequest<{ accessToken: string }>("/auth/select-organization", {
        method: "POST",
        body: JSON.stringify({ organizationId }),
      });
      useAuthStore.getState().setAccessToken(result.accessToken);
      useAuthStore.getState().selectOrganization(organizationId);
      // Every cached query (departments, folders, permissions…) belongs to the previous org and
      // its access token. Without clearing, the landing route reads a stale department list and
      // navigates into a department that doesn't exist in the new org — which hung on "Opening
      // workspace…". Clearing forces a clean refetch under the new org scope.
      queryClient.clear();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
      setSelecting(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm animate-card-in">
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card-lg">
          <h1 className="text-[22px] font-bold leading-tight tracking-[-0.4px] text-ink">
            Choose an organization
          </h1>
          <p className="mt-1.5 text-[13.5px] text-muted">Your access spans more than one workspace.</p>
          {error && <p className="mt-4 text-[13.5px] text-danger">{error}</p>}
          <div className="mt-6 space-y-2">
            {organizations.map((org, i) => (
              <button
                key={org.id}
                onClick={() => pick(org.id)}
                disabled={selecting !== null}
                className="flex w-full animate-fade-up items-center justify-between rounded-lg border border-line px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-surface-muted disabled:opacity-50"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span className="text-[14px] font-medium text-ink">{org.name}</span>
                <span className="flex items-center gap-2">
                  {org.isSuperAdmin && <StatusPill tone="primary">Super Admin</StatusPill>}
                  <span className="text-subtle">{selecting === org.id ? "..." : "→"}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
