import { useAuthStore } from "../store/authStore";
import { AppShell } from "../components/AppShell";
import { StorageConnectionForm } from "../components/StorageConnectionForm";

export function StorageSetupPage() {
  const organizations = useAuthStore((s) => s.organizations);
  const currentOrganizationId = useAuthStore((s) => s.currentOrganizationId);
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);

  if (!currentOrg?.isSuperAdmin) {
    return (
      <AppShell>
        <p className="text-[14.5px] text-muted">Only the Super Admin can configure storage.</p>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">Storage</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Where this organization's documents are kept. Every connection is tested end to end —
        write, read back, delete — before it counts as verified.
      </p>

      <div className="mt-8 max-w-3xl rounded-2xl border border-line bg-surface p-8 shadow-card">
        <StorageConnectionForm />
      </div>
    </AppShell>
  );
}
