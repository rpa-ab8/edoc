import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRequest, ApiRequestError } from "../lib/api";
import { AuthCard, SuccessIcon, primaryButtonClass } from "../components/AuthCard";

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState("Verifying your email...");

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("This link is missing its verification token.");
      return;
    }
    apiRequest("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => {
        setState("success");
        setMessage("Your email is verified.");
      })
      .catch((err) => {
        setState("error");
        setMessage(err instanceof ApiRequestError ? err.message : "Verification failed.");
      });
  }, [token]);

  return (
    <AuthCard title="Email verification" step={{ current: 2, total: 3 }}>
      {state === "success" && <SuccessIcon />}
      <p className={`text-center text-[13.5px] ${state === "error" ? "text-danger" : "text-muted"}`}>
        {message}
      </p>
      {state !== "pending" && (
        <Link to="/login" className={`mt-6 block ${primaryButtonClass}`}>
          Continue to sign in
        </Link>
      )}
    </AuthCard>
  );
}
