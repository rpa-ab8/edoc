import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { inputBase, primaryButtonBase, secondaryButtonBase } from "../components/AuthCard";
import {
  BellIcon,
  ChevronRightIcon,
  CopyIcon,
  DocumentIcon,
  FolderIcon,
  LockIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  TrashIcon,
  UploadCloudIcon,
  XIcon,
} from "../components/icons";
import { FileTypeIcon } from "../components/FileTypeIcon";
import { UploadPanel } from "../components/upload/UploadPanel";
import { NeedsDetailsPanel } from "../components/upload/NeedsDetailsPanel";
import { SearchFilterPanel } from "../components/search/SearchFilterPanel";
import { SharesList } from "../components/SharesList";
import { TrashList } from "../components/TrashList";
import {
  ConfidentialManageDialog,
  ConfidentialRecoveryDialog,
  PeoplePicker,
} from "../components/ConfidentialDialogs";
import { FolderPermissionsDialog } from "../components/FolderPermissionsDialog";
import { useAuthStore } from "../store/authStore";
import { searchDocuments, SHARE_QUICK_VIEWS, type QuickView, type SearchFilter } from "../lib/search";
import { ApiRequestError } from "../lib/api";
import { fetchDepartment, fetchDepartments } from "../lib/departments";
import {
  createFolder,
  deleteFolder,
  fetchFolders,
  fetchMyPermissions,
  pathTo,
  renameFolder,
} from "../lib/folders";
import {
  deleteDocument,
  fetchFolderDocuments,
  fetchNeedsDetails,
  humanFileSize,
  uploadNewVersion,
} from "../lib/documents";

export function DepartmentWorkspacePage() {
  const { departmentId = "", folderId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [createConfidential, setCreateConfidential] = useState(false);
  const [createMembers, setCreateMembers] = useState<string[]>([]);
  const [manageFolderId, setManageFolderId] = useState<string | null>(null);
  const [permsFolderId, setPermsFolderId] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { user: authUser, organizations, currentOrganizationId } = useAuthStore();
  const isSuperAdmin = organizations.find((o) => o.id === currentOrganizationId)?.isSuperAdmin === true;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[] | null>(null); // non-null = upload panel open
  const [needsOpen, setNeedsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [versionMsg, setVersionMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const versionTargetRef = useRef<string | null>(null);

  // ── Search & retrieval (Module 7) ──
  // The search / quick-view / filter state lives in the URL query string, not component state, so it
  // survives opening a document in the viewer and pressing Back: the workspace remounts and reads it
  // straight back from the query string (fixing "Back drops me in the file's folder, not my search").
  const [searchParams, setSearchParams] = useSearchParams();
  const activeQuery = searchParams.get("q") ?? "";
  const quickView = (searchParams.get("view") as QuickView | null) ?? null;
  const filterTypeId = searchParams.get("type") ?? "";
  const filters: SearchFilter[] = useMemo(() => {
    const raw = searchParams.get("filters");
    if (!raw) return [];
    try {
      return JSON.parse(raw) as SearchFilter[];
    } catch {
      return [];
    }
  }, [searchParams]);
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  const [showFilters, setShowFilters] = useState(false);

  function updateSearch(mutate: (p: URLSearchParams) => void) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      },
      { replace: true },
    );
  }
  const setQuickView = (view: QuickView | null) => {
    setSearchInput("");
    updateSearch((p) => {
      p.delete("q");
      p.delete("type");
      p.delete("filters");
      if (view) p.set("view", view);
      else p.delete("view");
    });
  };
  // Changing (or clearing) the document type also clears field filters — fields differ per type.
  // Done in one URL update: two separate setSearchParams calls in a handler don't chain, so the
  // second would overwrite the first and drop the type (which is exactly what broke selection).
  const setFilterTypeId = (id: string) =>
    updateSearch((p) => {
      if (id) p.set("type", id);
      else p.delete("type");
      p.delete("filters");
    });
  const setFilters = (next: SearchFilter[]) =>
    updateSearch((p) => (next.length ? p.set("filters", JSON.stringify(next)) : p.delete("filters")));
  const clearSearch = () => {
    setSearchInput("");
    updateSearch((p) => {
      p.delete("q");
      p.delete("view");
      p.delete("type");
      p.delete("filters");
    });
  };

  // Search-as-you-type: debounce the raw input into the `q` query param the API runs on. Uses the
  // stable `setSearchParams` directly (functional form) so this doesn't re-fire every render.
  useEffect(() => {
    const id = setTimeout(() => {
      const trimmed = searchInput.trim();
      if (trimmed === activeQuery) return;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set("q", trimmed);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 250);
    return () => clearTimeout(id);
  }, [searchInput, activeQuery, setSearchParams]);

  // A plain folder click is a fresh context (its URL carries no query) — sync the input box to it.
  // The Back-from-viewer case is a remount, handled by the useState initialiser above. Intentionally
  // keyed on folderId only: we resync on folder change, not on every query-param edit.
  useEffect(() => {
    setSearchInput(searchParams.get("q") ?? "");
    setShowFilters(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const { data: departments } = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });
  const { data: folders, refetch: refetchFolders, error: foldersError } = useQuery({
    queryKey: ["folders", departmentId],
    queryFn: () => fetchFolders(departmentId),
    enabled: Boolean(departmentId),
    retry: false,
  });
  // Re-resolved per folder, because a folder override can take permissions away further down the
  // tree — the toolbar has to reflect where you actually are, not where you entered.
  // `keepPreviousData`: navigating between folders changes this query's key, and without it `access`
  // would briefly become undefined — tripping the loading guard below, which unmounts the whole
  // shell and collapses the sidebar's folder tree back to its initial state on every click.
  const { data: access } = useQuery({
    queryKey: ["my-permissions", departmentId, folderId ?? null],
    queryFn: () => fetchMyPermissions(departmentId, folderId),
    enabled: Boolean(departmentId),
    placeholderData: keepPreviousData,
  });
  // The department's document types (with their field definitions) drive the generated upload form.
  const { data: departmentDetail } = useQuery({
    queryKey: ["department-detail", departmentId],
    queryFn: () => fetchDepartment(departmentId),
    enabled: Boolean(departmentId),
    retry: false,
  });
  // Documents in the current folder — only meaningful once we're inside a folder.
  const { data: documents, refetch: refetchDocuments } = useQuery({
    queryKey: ["documents", departmentId, folderId ?? null],
    queryFn: () => fetchFolderDocuments(departmentId, folderId!),
    enabled: Boolean(departmentId && folderId),
    placeholderData: keepPreviousData,
  });
  const { data: needsDetails, refetch: refetchNeeds } = useQuery({
    queryKey: ["needs-details", departmentId],
    queryFn: () => fetchNeedsDetails(departmentId),
    enabled: Boolean(departmentId),
  });

  // The department "landing" drops the member straight into the default **"General"** folder (every
  // department has one), so the first page is an actual documents view they can upload into rather
  // than a "pick a folder first" screen. Falls back to the first root folder if "General" was
  // renamed or removed. Folders remain optional organisation in the sidebar for anyone who wants them.
  useEffect(() => {
    if (folderId) return;
    const roots = (folders ?? []).filter((f) => (f.parentFolderId ?? null) === null);
    const mainFolder = roots.find((f) => f.name === "General") ?? roots[0];
    if (mainFolder) navigate(`/w/${departmentId}/f/${mainFolder.id}`, { replace: true });
  }, [folderId, folders, departmentId, navigate]);

  // The share-backed quick views ("Shared with me/by me") are org-wide and draw from the sharing
  // API, not the department search endpoint — so they take over the results panel on their own terms.
  const isShareView = quickView !== null && SHARE_QUICK_VIEWS.includes(quickView);
  const isTrashView = quickView === "trash";
  const searchActive =
    Boolean(activeQuery) || quickView !== null || filters.length > 0 || Boolean(filterTypeId);
  const { data: searchResults, isFetching: searchLoading } = useQuery({
    queryKey: ["search", departmentId, activeQuery, quickView, filterTypeId, JSON.stringify(filters)],
    queryFn: () =>
      searchDocuments(departmentId, {
        q: activeQuery || undefined,
        documentTypeId: filterTypeId || undefined,
        quickView: quickView ?? undefined,
        filters: filters.length ? filters : undefined,
      }),
    enabled:
      Boolean(departmentId) &&
      searchActive &&
      !isShareView &&
      !isTrashView &&
      access?.permissions["search.search"] === true,
    placeholderData: keepPreviousData,
  });

  const department = departments?.find((d) => d.id === departmentId);

  // Being able to administer a department is not the same as being able to read it: a Super Admin
  // who hasn't been given a role sees this instead of the files, which is the point of the rule.
  if (department && access && foldersError) {
    const canAdminister = access.permissions["members.change_role"] === true;
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-subtle">
          <LockIcon size={22} />
        </span>
        <h1 className="mt-6 text-[24px] font-bold tracking-[-0.4px] text-ink">
          You're not a member of {department.name}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          {canAdminister
            ? "You can configure this department and manage who belongs to it, but reading its documents needs a role here — add yourself as a member if you need access to the files."
            : "Ask an administrator to give you a role in this department."}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          {canAdminister && (
            <Link to={`/departments/${department.id}`} className={`${primaryButtonBase} px-6`}>
              Open department settings
            </Link>
          )}
          <Link to="/departments" className={`${secondaryButtonBase} px-6`}>
            All departments
          </Link>
        </div>
      </div>
    );
  }

  if (!department || !folders || !access) {
    return <div className="p-10 text-[14.5px] text-muted">Opening workspace…</div>;
  }

  const permissions = access.permissions;
  const canUpload = permissions["documents.upload"] === true;
  const canCreateFolder = permissions["folders.create"] === true;
  const canRename = permissions["folders.rename"] === true;
  const canDelete = permissions["folders.delete"] === true;
  // Confidential recovery is a Super-Admin / Department-Admin authority (CNF-4). Department-Admin
  // capability is holding both member-management and rules editing (see the backend constant).
  const canDeleteDoc = permissions["documents.delete"] === true;
  const canViewAudit = permissions["audit.view_audit"] === true;
  const isDeptAdmin =
    permissions["members.change_role"] === true && permissions["configuration.edit_rules"] === true;
  const canRecover = isSuperAdmin || isDeptAdmin;
  // The parent a new folder would be created under, to know whether a "Confidential" toggle applies
  // (a child of a confidential folder is always confidential — no choice to offer).
  const createParentConfidential =
    creatingIn != null && folders.find((f) => f.id === creatingIn)?.isConfidential === true;

  // A subfolder of a folder at depth d sits at depth d+1, allowed only while d+1 <= limit — so a
  // folder at the limit can hold no more. The department root ("no current folder") is above
  // depth 0, so a folder created there is always within range.
  const depthLimit = access.subfolderDepthLimit;
  const canNestUnder = (folderDepth: number) => folderDepth + 1 <= depthLimit;
  const canSearch = permissions["search.search"] === true;
  const canUploadVersion = permissions["documents.upload_version"] === true;
  const documentTypes = departmentDetail?.documentTypes ?? [];
  const needsCount = needsDetails?.length ?? 0;

  const breadcrumb = pathTo(folders, folderId ?? null);
  const currentChildren = folders.filter((f) => (f.parentFolderId ?? null) === (folderId ?? null));
  const current = folderId ? folders.find((f) => f.id === folderId) : null;
  const subject = department.subjectTerm ?? "record";

  // Can a new folder be created *at the level currently shown*? Always yes at the department root;
  // inside a folder, only while that folder isn't already at the depth limit.
  const canCreateHere = canCreateFolder && (current ? canNestUnder(current.depth) : true);

  // Every document lives in a folder, so the upload panel picks a destination (defaulting to the
  // current folder). Uploading is therefore offered wherever there's at least one folder to target
  // — including the department root, where it defaults to the first folder.
  const canUploadAny = canUpload && folders.length > 0;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refetchFolders();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshAfterUpload() {
    await Promise.all([refetchDocuments(), refetchFolders(), refetchNeeds()]);
  }

  function triggerVersionUpload(documentId: string) {
    versionTargetRef.current = documentId;
    versionInputRef.current?.click();
  }
  async function onVersionFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    const docId = versionTargetRef.current;
    if (!file || !docId) return;
    setVersionMsg({ id: docId, text: "Uploading new version…", ok: true });
    try {
      const { document } = await uploadNewVersion(docId, file);
      setVersionMsg({ id: docId, text: `New version added (v${document.versions.length}).`, ok: true });
      await refreshAfterUpload();
    } catch (err) {
      setVersionMsg({
        id: docId,
        text: err instanceof ApiRequestError ? err.message : "Couldn't upload the new version.",
        ok: false,
      });
    }
  }

  return (
    <WorkspaceShell
      department={department}
      departments={departments ?? []}
      folders={folders}
      currentFolderId={folderId ?? null}
      permissions={permissions}
      roleName={access.roleName}
      onCreateFolder={(parent) => {
        setCreatingIn(parent);
        setNewFolderName("");
      }}
      activeQuickView={quickView}
      onQuickView={setQuickView}
    >
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-canvas/95 px-8 py-4 backdrop-blur">
        <div className="relative min-w-[240px] flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle">
            <SearchIcon size={17} />
          </span>
          <input
            className={`${inputBase} w-full pl-10 pr-9`}
            placeholder={
              canSearch
                ? `Search ${department.name} — name, ID or text inside files`
                : `Search isn't part of your role in ${department.name}`
            }
            value={searchInput}
            disabled={!canSearch}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchInput("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
        {canSearch && (
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={`${secondaryButtonBase} flex items-center gap-2 ${
              filters.length || filterTypeId ? "border-primary text-primary" : ""
            }`}
          >
            <SlidersIcon size={15} /> Filters{filters.length ? ` · ${filters.length}` : ""}
          </button>
        )}
        {/* The needs-details queue is department-wide — a real attention signal, styled as an alert
            chip rather than a plain button so it reads as "something needs you". */}
        {needsCount > 0 && (
          <button
            type="button"
            onClick={() => setNeedsOpen(true)}
            className="flex items-center gap-2 rounded-full border border-warning/25 bg-warning-tint px-3.5 py-2 text-[13px] font-semibold text-warning transition-colors hover:brightness-[0.97]"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-warning/15">
              <BellIcon size={13} />
            </span>
            {needsCount} need{needsCount === 1 ? "s" : ""} details
          </button>
        )}

        {/* A hairline divider separates search tools from the action group, so the row reads as two
            intentional clusters rather than one long line of look-alike buttons. */}
        {(canUploadAny || canCreateHere || canRecover || canViewAudit) && (
          <span className="mx-0.5 hidden h-7 w-px bg-line lg:block" aria-hidden />
        )}

        {canCreateHere && (
          <button
            type="button"
            onClick={() => {
              setCreatingIn(folderId ?? null);
              setNewFolderName("");
            }}
            className={`${secondaryButtonBase} flex items-center gap-2`}
          >
            <PlusIcon size={16} /> New folder
          </button>
        )}
        {/* Permission-driven: a role without upload has no upload button, not a disabled one. The
            panel picks a destination folder, so this is offered at the root too. */}
        {canUploadAny && (
          <button
            type="button"
            onClick={() => setUploadFiles([])}
            className={`${primaryButtonBase} flex items-center gap-2`}
          >
            <UploadCloudIcon size={16} /> Add {subject.toLowerCase()}
          </button>
        )}

        {/* Occasional admin utilities live behind a single "More" affordance — this keeps the toolbar
            calm and gives new admin actions a home without growing the row. */}
        {(canRecover || canViewAudit) && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-label="More actions"
              aria-expanded={moreOpen}
              className={`flex h-[42px] w-[42px] items-center justify-center rounded-lg border transition-colors ${
                moreOpen
                  ? "border-primary bg-primary-tint text-primary"
                  : "border-line bg-surface text-muted hover:bg-surface-muted hover:text-ink"
              }`}
            >
              <MoreIcon size={18} />
            </button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMoreOpen(false)} aria-hidden />
                <div className="absolute right-0 top-full z-30 mt-2 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-card-lg">
                  {canViewAudit && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        navigate(`/w/${departmentId}/audit`);
                      }}
                      className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-muted"
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-info-tint text-info">
                        <ShieldIcon size={16} />
                      </span>
                      <span>
                        Audit log
                        <span className="block text-[12px] font-normal text-subtle">Who did what, and when</span>
                      </span>
                    </button>
                  )}
                  {canRecover && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoreOpen(false);
                        setRecoveryOpen(true);
                      }}
                      className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-[13.5px] font-medium text-ink transition-colors hover:bg-surface-muted"
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning-tint text-warning">
                        <LockIcon size={16} />
                      </span>
                      <span>
                        Recovery
                        <span className="block text-[12px] font-normal text-subtle">Reopen an orphaned vault</span>
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </header>

      <div
        className="relative px-8 py-7"
        onDragOver={(e) => {
          if (!canUploadAny) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer actually leaves the content region, not on child boundaries.
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          if (!canUploadAny) return;
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) setUploadFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {dragging && canUploadAny && (
          <div className="pointer-events-none absolute inset-4 z-20 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary-tint/80 backdrop-blur-sm">
            <UploadCloudIcon size={30} className="text-primary" />
            <p className="mt-2 text-[15px] font-semibold text-primary">
              Drop to add {subject.toLowerCase()}s{current ? ` to ${current.name}` : ""}
            </p>
          </div>
        )}

        <nav className="flex flex-wrap items-center gap-1.5 text-[13.5px] text-subtle">
          <Link to={`/w/${department.id}`} className="hover:text-primary">
            {department.name}
          </Link>
          {breadcrumb.map((folder) => (
            <span key={folder.id} className="flex items-center gap-1.5">
              <ChevronRightIcon size={13} />
              <Link to={`/w/${department.id}/f/${folder.id}`} className="hover:text-primary">
                {folder.name}
              </Link>
            </span>
          ))}
        </nav>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          {renaming === current?.id && current ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await renameFolder(departmentId, current.id, renameValue.trim());
                  setRenaming(null);
                });
              }}
            >
              <input
                autoFocus
                className={`${inputBase} w-72`}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
              <button type="submit" className={`${primaryButtonBase} px-4 py-2`}>
                Save
              </button>
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className={`${secondaryButtonBase} px-4 py-2`}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">
                {current?.name ?? department.name}
              </h1>
              {current?.isConfidential && (
                <span className="flex items-center gap-1.5 rounded-md bg-warning-tint px-2.5 py-1 text-[12.5px] font-medium text-warning">
                  <LockIcon size={13} /> Confidential
                </span>
              )}
              {current?.isConfidential && (
                <button
                  type="button"
                  onClick={() => setManageFolderId(current.id)}
                  className="rounded-md px-2.5 py-1 text-[12.5px] font-medium text-primary hover:bg-primary-tint"
                >
                  Manage access
                </button>
              )}
              {current && !current.isConfidential && isDeptAdmin && (
                <button
                  type="button"
                  onClick={() => setPermsFolderId(current.id)}
                  title="Restrict a role's access to this folder"
                  className="rounded-md px-2.5 py-1 text-[12.5px] font-medium text-primary hover:bg-primary-tint"
                >
                  Folder access
                </button>
              )}
              {current && canRename && (
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(current.id);
                    setRenameValue(current.name);
                  }}
                  aria-label="Rename folder"
                  title="Rename this folder"
                  className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-muted hover:text-primary"
                >
                  <PencilIcon size={15} />
                </button>
              )}
              {current && canDelete && (
                <button
                  type="button"
                  aria-label="Delete folder"
                  title="Delete this folder"
                  onClick={() =>
                    void run(async () => {
                      await deleteFolder(departmentId, current.id);
                      navigate(
                        `/w/${department.id}${current.parentFolderId ? `/f/${current.parentFolderId}` : ""}`,
                      );
                    })
                  }
                  className="rounded-md p-1.5 text-subtle transition-colors hover:bg-danger-tint hover:text-danger"
                >
                  <TrashIcon size={16} />
                </button>
              )}
            </>
          )}
        </div>
        <p className="mt-1.5 text-[14.5px] text-muted">
          {folderId
            ? `${documents?.length ?? 0} document${(documents?.length ?? 0) === 1 ? "" : "s"}` +
              (currentChildren.length
                ? ` · ${currentChildren.length} subfolder${currentChildren.length === 1 ? "" : "s"} in the sidebar`
                : "")
            : `${folders.length} folder${folders.length === 1 ? "" : "s"} in the sidebar`}
        </p>

        {error && <p className="mt-4 text-[14px] font-medium text-danger">{error}</p>}

        {creatingIn !== undefined && (
          <form
            className="mt-5 rounded-2xl border border-line bg-surface p-5 shadow-card"
            onSubmit={(e) => {
              e.preventDefault();
              const wantsConfidential = createConfidential && !createParentConfidential;
              void run(async () => {
                await createFolder(departmentId, {
                  name: newFolderName.trim(),
                  parentFolderId: creatingIn,
                  ...(wantsConfidential
                    ? { isConfidential: true, memberUserIds: createMembers }
                    : {}),
                });
                setCreatingIn(undefined);
                setCreateConfidential(false);
                setCreateMembers([]);
              });
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <label className="mb-2 block text-[13.5px] font-medium text-ink">
                  New folder{creatingIn ? ` in ${folders.find((f) => f.id === creatingIn)?.name}` : ""}
                </label>
                <input
                  autoFocus
                  required
                  className={`${inputBase} w-full`}
                  value={newFolderName}
                  placeholder="Contracts"
                  onChange={(e) => setNewFolderName(e.target.value)}
                />
              </div>
              <button type="submit" disabled={busy} className={`${primaryButtonBase} px-6`}>
                Create folder
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreatingIn(undefined);
                  setCreateConfidential(false);
                  setCreateMembers([]);
                }}
                className={`${secondaryButtonBase} px-6`}
              >
                Cancel
              </button>
            </div>

            {/* Confidentiality: offered only where it's a real choice. Under a confidential parent the
                new folder is always confidential (inherited), so we say so rather than offer a toggle. */}
            {createParentConfidential ? (
              <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-accent">
                <LockIcon size={13} /> Inside a confidential folder — this will be confidential too.
              </p>
            ) : (
              <div className="mt-3 border-t border-line-muted pt-3">
                <label className="flex items-center gap-2.5 text-[13.5px] text-ink">
                  <input
                    type="checkbox"
                    checked={createConfidential}
                    onChange={(e) => setCreateConfidential(e.target.checked)}
                    className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
                  />
                  <span className="flex items-center gap-1.5">
                    <LockIcon size={13} className="text-accent" /> Make this a confidential folder
                  </span>
                </label>
                {createConfidential && (
                  <div className="mt-3 max-w-md">
                    <p className="mb-2 text-[12.5px] text-subtle">
                      Only named people can see it — roles grant no access, and you're added as its owner.
                    </p>
                    <PeoplePicker
                      selected={createMembers}
                      onChange={setCreateMembers}
                      exclude={authUser?.id ? [authUser.id] : []}
                    />
                  </div>
                )}
              </div>
            )}
          </form>
        )}

        {showFilters && canSearch && (
          <SearchFilterPanel
            documentTypes={documentTypes}
            documentTypeId={filterTypeId}
            onDocumentTypeChange={setFilterTypeId}
            filters={filters}
            onFiltersChange={setFilters}
            onClose={() => setShowFilters(false)}
          />
        )}

        {isTrashView ? (
          <div className="mt-6">
            <div className="mb-3 flex justify-end">
              <button type="button" onClick={clearSearch} className="text-[13.5px] font-medium text-primary hover:underline">
                Back to folder
              </button>
            </div>
            <TrashList departmentId={departmentId} canPurge={isDeptAdmin} />
          </div>
        ) : isShareView ? (
          <div className="mt-6">
            <div className="mb-3 flex items-center gap-3">
              <h2 className="text-[15px] font-semibold text-ink">{QUICK_VIEW_LABELS[quickView!]}</h2>
              <button
                type="button"
                onClick={clearSearch}
                className="ml-auto text-[13.5px] font-medium text-primary hover:underline"
              >
                Clear
              </button>
            </div>
            <SharesList mode={quickView === "shared_by_me" ? "by-me" : "with-me"} />
          </div>
        ) : searchActive ? (
          <SearchResultsView
            results={searchResults ?? []}
            loading={searchLoading}
            label={
              quickView
                ? QUICK_VIEW_LABELS[quickView]
                : activeQuery
                  ? `Results for “${activeQuery}”`
                  : "Filtered results"
            }
            onClear={clearSearch}
          />
        ) : (
          <>
        {/* The main panel is files-only: folders are navigated from the sidebar. Inside a folder we
            list its documents; at the department root we point the way into (or into creating) a
            folder, since every document lives in one. */}
        {folderId ? (
          documents && documents.length > 0 ? (
            <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-surface-muted">
                    <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">
                      Document
                    </th>
                    <th className="hidden px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle sm:table-cell">
                      Type
                    </th>
                    <th className="hidden px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle sm:table-cell">
                      Size
                    </th>
                    <th className="px-6 py-3.5" />
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={doc.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/50">
                      <td className="px-6 py-4">
                        <div className="flex items-start gap-3">
                          <FileTypeIcon mimeType={doc.mimeType} fileName={doc.fileName} className="mt-0.5 h-9 w-9" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="plate px-2 py-0.5">{doc.documentRef}</span>
                              <button
                                type="button"
                                aria-label="Copy document ID"
                                title="Copy ID"
                                onClick={() => void navigator.clipboard?.writeText(doc.documentRef)}
                                className="rounded p-1 text-subtle transition-colors hover:bg-surface-muted hover:text-primary"
                              >
                                <CopyIcon size={13} />
                              </button>
                            </div>
                            <Link
                              to={`/documents/${doc.id}`}
                              className="mt-1 block truncate text-[14.5px] font-medium text-ink hover:text-primary hover:underline"
                            >
                              {doc.titleValue ?? doc.fileName ?? "Untitled"}
                            </Link>
                            {versionMsg?.id === doc.id && (
                              <p className={`mt-1 text-[12.5px] ${versionMsg.ok ? "text-subtle" : "text-danger"}`}>
                                {versionMsg.text}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-6 py-4 text-[14px] text-muted sm:table-cell">{doc.documentType}</td>
                      <td className="hidden px-6 py-4 text-[14px] text-muted sm:table-cell">
                        {humanFileSize(doc.fileSize)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="flex items-center justify-end gap-4">
                          {canUploadVersion && (
                            <button
                              type="button"
                              onClick={() => triggerVersionUpload(doc.id)}
                              className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-primary hover:underline"
                            >
                              <RefreshIcon size={14} /> New version
                            </button>
                          )}
                          {canDeleteDoc && (
                            <button
                              type="button"
                              title="Move to trash"
                              onClick={() =>
                                void deleteDocument(doc.id).then(() => void refreshAfterUpload())
                              }
                              className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-muted hover:text-danger hover:underline"
                            >
                              <TrashIcon size={14} /> Delete
                            </button>
                          )}
                          <Link
                            to={`/documents/${doc.id}`}
                            className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-primary hover:underline"
                          >
                            Open <ChevronRightIcon size={13} />
                          </Link>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-6 flex flex-col items-center rounded-2xl border border-dashed border-line bg-surface px-6 py-16 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-subtle">
                <DocumentIcon size={22} />
              </span>
              <p className="mt-5 text-[16px] font-semibold text-ink">No documents here yet</p>
              <p className="mt-1.5 max-w-md text-[14px] text-subtle">
                {canUploadAny
                  ? `Drop files anywhere in this folder, or use “Add ${subject.toLowerCase()}”.`
                  : "Nothing here yet, and your role doesn't include uploading."}
              </p>
              {canUploadAny && (
                <button
                  type="button"
                  onClick={() => setUploadFiles([])}
                  className={`${primaryButtonBase} mt-6 flex items-center gap-2 px-5`}
                >
                  <UploadCloudIcon size={16} /> Add {subject.toLowerCase()}
                </button>
              )}
            </div>
          )
        ) : (
          <div className="mt-6 flex flex-col items-center rounded-2xl border border-dashed border-line bg-surface px-6 py-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-subtle">
              <FolderIcon size={22} />
            </span>
            {folders.length === 0 ? (
              <>
                <p className="mt-5 text-[16px] font-semibold text-ink">No folders yet</p>
                <p className="mt-1.5 max-w-md text-[14px] text-subtle">
                  {canCreateFolder
                    ? "Create a folder to start organising this department's documents."
                    : "Nothing here yet, and your role doesn't include creating folders."}
                </p>
                {canCreateFolder && (
                  <button
                    type="button"
                    onClick={() => {
                      setCreatingIn(null);
                      setNewFolderName("");
                    }}
                    className={`${primaryButtonBase} mt-6 flex items-center gap-2 px-5`}
                  >
                    <PlusIcon size={16} /> New folder
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="mt-5 text-[16px] font-semibold text-ink">Choose a folder to see its files</p>
                <p className="mt-1.5 max-w-md text-[14px] text-subtle">
                  Pick a folder from the sidebar to view its documents
                  {canUploadAny ? `, or add ${subject.toLowerCase()}s straight away.` : "."}
                </p>
                {canUploadAny && (
                  <button
                    type="button"
                    onClick={() => setUploadFiles([])}
                    className={`${primaryButtonBase} mt-6 flex items-center gap-2 px-5`}
                  >
                    <UploadCloudIcon size={16} /> Add {subject.toLowerCase()}
                  </button>
                )}
              </>
            )}
          </div>
        )}
          </>
        )}

        {!searchActive && folderId && documents && documents.length > 0 && (
          <p className="mt-6 flex items-start gap-2.5 rounded-xl bg-surface-muted px-4 py-3 text-[13px] leading-relaxed text-subtle">
            <DocumentIcon size={16} className="mt-0.5 shrink-0" />
            Open a document to preview it, edit its details, see its version history, and download it.
          </p>
        )}

        {access.source === "role_restricted_by_folder" && (
          <p className="mt-3 text-[13.5px] text-subtle">
            A folder override restricts what your role can do here.
          </p>
        )}
      </div>

      {/* Hidden picker for "upload a new version" of a specific document. */}
      <input
        ref={versionInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx"
        onChange={(e) => void onVersionFileChosen(e)}
      />

      {uploadFiles !== null && (
        <UploadPanel
          departmentId={departmentId}
          folders={folders}
          initialFolderId={folderId ?? null}
          subject={subject.toLowerCase()}
          documentTypes={documentTypes}
          initialFiles={uploadFiles}
          onClose={() => setUploadFiles(null)}
          onUploaded={() => void refreshAfterUpload()}
        />
      )}

      {needsOpen && (
        <NeedsDetailsPanel
          departmentId={departmentId}
          documentTypes={documentTypes}
          onClose={() => setNeedsOpen(false)}
          onUpdated={() => void refreshAfterUpload()}
        />
      )}

      {manageFolderId && (
        <ConfidentialManageDialog folderId={manageFolderId} onClose={() => setManageFolderId(null)} />
      )}
      {permsFolderId && (
        <FolderPermissionsDialog
          departmentId={departmentId}
          folderId={permsFolderId}
          onClose={() => setPermsFolderId(null)}
        />
      )}
      {recoveryOpen && (
        <ConfidentialRecoveryDialog departmentId={departmentId} onClose={() => setRecoveryOpen(false)} />
      )}
    </WorkspaceShell>
  );
}

const QUICK_VIEW_LABELS: Record<QuickView, string> = {
  recent: "Recent",
  uploaded_by_me: "Uploaded by me",
  shared_with_me: "Shared with me",
  shared_by_me: "Shared by me",
  trash: "Trash",
};

/** The search / quick-view results panel. Each result opens the document viewer. */
function SearchResultsView({
  results,
  loading,
  label,
  onClear,
}: {
  results: import("../lib/search").SearchResult[];
  loading: boolean;
  label: string;
  onClear: () => void;
}) {
  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-ink">{label}</h2>
        <span className="text-[13.5px] text-subtle">
          {loading ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}
        </span>
        <button type="button" onClick={onClear} className="ml-auto text-[13.5px] font-medium text-primary hover:underline">
          Clear
        </button>
      </div>

      {results.length === 0 && !loading ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-line bg-surface px-6 py-14 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-subtle">
            <SearchIcon size={22} />
          </span>
          <p className="mt-5 text-[16px] font-semibold text-ink">No matches</p>
          <p className="mt-1.5 max-w-md text-[14px] text-subtle">
            Nothing here matches. Try fewer words, or adjust the filters.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-surface-muted">
                <th className="px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle">Document</th>
                <th className="hidden px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle md:table-cell">Type</th>
                <th className="hidden px-6 py-3.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-subtle md:table-cell">Folder</th>
                <th className="px-6 py-3.5" />
              </tr>
            </thead>
            <tbody>
              {results.map((doc) => (
                <tr key={doc.id} className="border-b border-line-muted last:border-b-0 hover:bg-surface-muted/50">
                  <td className="px-6 py-4">
                    <div className="flex items-start gap-3">
                      <FileTypeIcon mimeType={doc.mimeType} fileName={doc.fileName} className="mt-0.5 h-9 w-9" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="plate px-2 py-0.5">{doc.documentRef}</span>
                          <button
                            type="button"
                            aria-label="Copy document ID"
                            title="Copy ID"
                            onClick={() => void navigator.clipboard?.writeText(doc.documentRef)}
                            className="rounded p-1 text-subtle transition-colors hover:bg-surface-muted hover:text-primary"
                          >
                            <CopyIcon size={13} />
                          </button>
                        </div>
                        <Link
                          to={`/documents/${doc.id}`}
                          className="mt-1 block truncate text-[14.5px] font-medium text-ink hover:text-primary hover:underline"
                        >
                          {doc.titleValue ?? doc.fileName ?? "Untitled"}
                        </Link>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-6 py-4 text-[14px] text-muted md:table-cell">{doc.documentType}</td>
                  <td className="hidden px-6 py-4 text-[14px] text-muted md:table-cell">{doc.folderName ?? "—"}</td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      to={`/documents/${doc.id}`}
                      className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-primary hover:underline"
                    >
                      Open <ChevronRightIcon size={13} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Sends someone to their own workspace — used as the landing decision after sign-in. */
export function WorkspaceRedirect() {
  const navigate = useNavigate();
  const { data: departments, isLoading } = useQuery({ queryKey: ["departments"], queryFn: fetchDepartments });

  const first = departments?.[0];
  // Navigating during render is what produced a blank screen: React bails out of the render and
  // nothing is returned. The redirect belongs in an effect.
  useEffect(() => {
    if (first) navigate(`/w/${first.id}`, { replace: true });
  }, [first, navigate]);

  if (isLoading) return <div className="p-10 text-[14.5px] text-muted">Loading…</div>;

  if (!first) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20 text-center">
        <h1 className="text-[24px] font-bold tracking-[-0.4px] text-ink">No department yet</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          Your account is part of this organization, but you haven't been given a role in a
          department. Ask an administrator to add you to one.
        </p>
        <button onClick={() => navigate("/login")} className={`${secondaryButtonBase} mt-6 px-6`}>
          Sign out
        </button>
      </div>
    );
  }
  return <div className="p-10 text-[14.5px] text-muted">Opening your department…</div>;
}
