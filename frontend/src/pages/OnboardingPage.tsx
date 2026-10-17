import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthCard";
import { StorageConnectionForm } from "../components/StorageConnectionForm";
import { fetchDepartments } from "../lib/departments";

interface StorageStatus {
  status: "pending" | "verified" | "error";
}

const STEP_LABELS = ["Storage", "First department", "Invite people"];

export function OnboardingPage() {
  const navigate = useNavigate();
  const organizations = useAuthStore((s) => s.organizations);
  const currentOrganizationId = useAuthStore((s) => s.currentOrganizationId);
  const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
  const [step, setStep] = useState(1);
  const [checkedExisting, setCheckedExisting] = useState(false);

  const { data } = useQuery({
    queryKey: ["storage-config"],
    queryFn: () => apiRequest<{ storage: StorageStatus | null }>("/storage/config"),
  });

  const { data: departments } = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });

  // If storage was already verified before landing here, don't re-show a completed step.
  useEffect(() => {
    if (!checkedExisting && data !== undefined) {
      if (data.storage?.status === "verified") setStep(2);
      setCheckedExisting(true);
    }
  }, [data, checkedExisting]);

  // Onboarding is a Super Admin flow (storage/department/invite are all admin actions) —
  // anyone else reaching this route directly lands on the dashboard instead.
  if (!currentOrg?.isSuperAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl animate-card-in">
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card-lg">
          <div className="mb-6 flex gap-1.5">
            {STEP_LABELS.map((label, i) => (
              <div key={label} className="flex-1">
                <span
                  className={`block h-1 rounded-full transition-colors ${
                    i + 1 <= step ? "bg-primary" : "bg-line"
                  }`}
                />
                <span
                  className={`mt-1.5 block text-[11px] font-medium ${
                    i + 1 === step ? "text-ink" : "text-subtle"
                  }`}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>

          {step === 1 && (
            <>
              <h1 className="text-[22px] font-bold leading-tight tracking-[-0.4px] text-ink">
                Connect your storage
              </h1>
              <p className="mt-1.5 text-[13.5px] text-muted">
                Documents can't be stored until this is verified — everything else waits on this
                one step.
              </p>
              <StorageConnectionForm onVerified={() => setStep(2)} />
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="text-[22px] font-bold leading-tight tracking-[-0.4px] text-ink">
                Create your first department
              </h1>
              <p className="mt-1.5 text-[13.5px] text-muted">
                Pick the closest template — Healthcare, Education, Accounts, HR, Legal or Blank —
                and adjust its document types, vocabulary and roles. Everything stays editable
                afterwards.
              </p>
              {departments && departments.length > 0 && (
                <p className="mt-4 text-[13px] text-success">
                  {departments.length} department{departments.length === 1 ? "" : "s"} created.
                </p>
              )}
              <div className="mt-6 flex gap-2">
                <button onClick={() => navigate("/departments/new?from=onboarding")} className={primaryButtonClass}>
                  {departments && departments.length > 0 ? "Add another department" : "Set up a department"}
                </button>
                <button onClick={() => setStep(3)} className={secondaryButtonClass}>
                  {departments && departments.length > 0 ? "Continue" : "Skip for now"}
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h1 className="text-[22px] font-bold leading-tight tracking-[-0.4px] text-ink">
                Invite your team
              </h1>
              <p className="mt-1.5 text-[13.5px] text-muted">
                {departments && departments.length > 0
                  ? "Invitations are sent per department, so people arrive with a role already set. Open a department's Members tab to send them."
                  : "Invitations attach a person to a department and role — so this opens up once you have a department."}
              </p>
              <div className="mt-6 flex gap-2">
                {departments && departments.length > 0 && (
                  <button
                    onClick={() => navigate(`/departments/${departments[0]!.id}`)}
                    className={primaryButtonClass}
                  >
                    Invite people
                  </button>
                )}
                <button
                  onClick={() => navigate("/")}
                  className={departments && departments.length > 0 ? secondaryButtonClass : primaryButtonClass}
                >
                  Finish
                </button>
              </div>
            </>
          )}

          {step !== 1 && (
            <button onClick={() => navigate("/")} className={`${secondaryButtonClass} mt-2.5`}>
              Skip to dashboard
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
