import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";

interface Props {
  children: ReactNode;
  requireVerified?: boolean;
  requireOrganization?: boolean;
}

export function ProtectedRoute({ children, requireVerified, requireOrganization }: Props) {
  const { initialized, user, currentOrganizationId, organizations } = useAuthStore();

  if (!initialized) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        Loading...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requireVerified && !user.emailVerified) {
    return <Navigate to="/verify-email-pending" replace />;
  }

  if (requireOrganization && !currentOrganizationId) {
    return (
      <Navigate to={organizations.length === 0 ? "/create-organization" : "/select-organization"} replace />
    );
  }

  return <>{children}</>;
}
