import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthBootstrap } from "./components/AuthBootstrap";
import { ProtectedRoute } from "./routes/ProtectedRoute";
import { RegisterPage } from "./pages/RegisterPage";
import { LoginPage } from "./pages/LoginPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { VerifyEmailPendingPage } from "./pages/VerifyEmailPendingPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { CreateOrganizationPage } from "./pages/CreateOrganizationPage";
import { SelectOrganizationPage } from "./pages/SelectOrganizationPage";
import { DashboardPage } from "./pages/DashboardPage";
import { StorageSetupPage } from "./pages/StorageSetupPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { OrganizationSettingsPage } from "./pages/OrganizationSettingsPage";
import { UserDirectoryPage } from "./pages/UserDirectoryPage";
import { DepartmentsPage } from "./pages/DepartmentsPage";
import { DepartmentCreatePage } from "./pages/DepartmentCreatePage";
import { DepartmentDetailPage } from "./pages/DepartmentDetailPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { DepartmentWorkspacePage, WorkspaceRedirect } from "./pages/DepartmentWorkspacePage";
import { DocumentViewerPage } from "./pages/DocumentViewerPage";
import { AuditPage } from "./pages/AuditPage";
import { SharesPage } from "./pages/SharesPage";
import { ExternalLinkPage } from "./pages/ExternalLinkPage";
import { useAuthStore } from "./store/authStore";

/**
 * Where "/" goes depends on who you are. A Super Admin owns the organization, so the overview is
 * their home. Everyone else works inside a department — dropping them on an org dashboard they
 * can barely use would be a detour on every single sign-in (Feature Spec §4: "on login the user
 * lands directly in their department’s documents, not a generic dashboard").
 */
function LandingRoute() {
  const { organizations, currentOrganizationId } = useAuthStore();
  const isSuperAdmin = organizations.find((o) => o.id === currentOrganizationId)?.isSuperAdmin ?? false;
  return isSuperAdmin ? <DashboardPage /> : <WorkspaceRedirect />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthBootstrap>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route
            path="/verify-email-pending"
            element={
              <ProtectedRoute>
                <VerifyEmailPendingPage />
              </ProtectedRoute>
            }
          />
          {/* Public: the recipient may have no account yet, so this must render signed out. */}
          <Route path="/invitations/:token" element={<AcceptInvitationPage />} />
          <Route path="/l/:token" element={<ExternalLinkPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            path="/create-organization"
            element={
              <ProtectedRoute>
                <CreateOrganizationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/select-organization"
            element={
              <ProtectedRoute>
                <SelectOrganizationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/onboarding"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <OnboardingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/storage-setup"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <StorageSetupPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/organization-settings"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <OrganizationSettingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/user-directory"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <UserDirectoryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/w/:departmentId"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <DepartmentWorkspacePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/w/:departmentId/f/:folderId"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <DepartmentWorkspacePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/w/:departmentId/audit"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <AuditPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/documents/:documentId"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <DocumentViewerPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/shares"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <SharesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/departments"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <DepartmentsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/departments/new"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <DepartmentCreatePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/departments/:departmentId"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <DepartmentDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute requireVerified requireOrganization>
                <LandingRoute />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthBootstrap>
    </BrowserRouter>
  );
}
