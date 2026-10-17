import { create } from "zustand";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  isSuperAdmin: boolean;
}

const ORG_STORAGE_KEY = "dms:currentOrganizationId";

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  organizations: OrganizationSummary[];
  currentOrganizationId: string | null;
  initialized: boolean;
  setSession: (params: {
    accessToken: string;
    user: AuthUser;
    organizations?: OrganizationSummary[];
    currentOrganizationId?: string | null;
  }) => void;
  setAccessToken: (token: string) => void;
  setUser: (user: AuthUser) => void;
  setOrganizations: (orgs: OrganizationSummary[]) => void;
  selectOrganization: (id: string) => void;
  setInitialized: (v: boolean) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  organizations: [],
  currentOrganizationId: localStorage.getItem(ORG_STORAGE_KEY),
  initialized: false,

  setSession: ({ accessToken, user, organizations, currentOrganizationId }) =>
    set((state) => ({
      accessToken,
      user,
      organizations: organizations ?? state.organizations,
      currentOrganizationId:
        currentOrganizationId !== undefined
          ? currentOrganizationId
          : state.currentOrganizationId,
    })),

  setAccessToken: (accessToken) => set({ accessToken }),
  setUser: (user) => set({ user }),
  setOrganizations: (organizations) => set({ organizations }),

  selectOrganization: (id) => {
    localStorage.setItem(ORG_STORAGE_KEY, id);
    set({ currentOrganizationId: id });
  },

  setInitialized: (initialized) => set({ initialized }),

  clear: () => {
    localStorage.removeItem(ORG_STORAGE_KEY);
    set({ accessToken: null, user: null, organizations: [], currentOrganizationId: null });
  },
}));
