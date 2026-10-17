import { useAuthStore } from "../store/authStore";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, string[] | undefined>;
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, string[] | undefined>,
  ) {
    super(message);
  }
}

async function rawFetch(path: string, options: RequestInit, accessToken: string | null) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(`${API_URL}${path}`, { ...options, headers, credentials: "include" });
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) {
    const err = (body ?? {}) as ApiErrorBody;
    throw new ApiRequestError(
      res.status,
      err.error ?? "unknown_error",
      err.message ?? "Request failed",
      err.details,
    );
  }
  return body as T;
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const organizationId = useAuthStore.getState().currentOrganizationId;
      const res = await rawFetch(
        "/auth/refresh",
        { method: "POST", body: JSON.stringify(organizationId ? { organizationId } : {}) },
        null,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string };
      return body.accessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** Auth endpoints manage their own token lifecycle — only non-auth calls get the
 * automatic refresh-and-retry-once-on-401 treatment. */
export async function apiRequest<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const accessToken = useAuthStore.getState().accessToken;
  let res = await rawFetch(path, options, accessToken);

  if (res.status === 401 && !path.startsWith("/auth/")) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      useAuthStore.getState().setAccessToken(newToken);
      res = await rawFetch(path, options, newToken);
    }
  }

  return parseOrThrow<T>(res);
}

export { refreshAccessToken };
