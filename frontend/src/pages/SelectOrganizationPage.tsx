import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiRequestError } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { AuthCard, FormAlert, Spinner } from "../components/AuthCard";
import { ChevronRightIcon } from "../components/icons";

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
    <AuthCard title="Choose an organization" subtitle="You belong to more than one. Pick the one to open.">
      <FormAlert message={error} />
      <div className={`space-y-2.5 ${error ? "mt-5" : ""}`}>
        {organizations.map((org) => (
          <button
            key={org.id}
            onClick={() => pick(org.id)}
            disabled={selecting !== null}
            className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors hover:border-primary/50 hover:bg-primary-tint/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-[15px] font-semibold text-primary">
              {org.name.trim().charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-medium text-ink">{org.name}</span>
              {org.isSuperAdmin && <span className="mt-0.5 block text-[13.5px] text-subtle">Super Admin</span>}
            </span>
            <span className="shrink-0 text-subtle transition-colors group-hover:text-primary">
              {selecting === org.id ? <Spinner /> : <ChevronRightIcon size={18} />}
            </span>
          </button>
        ))}
      </div>
    </AuthCard>
  );
}
