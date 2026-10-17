import { useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { SharesList } from "../components/SharesList";

type Tab = "with-me" | "by-me";

/** The org-level Shares page (for the Super Admin, who has no department workspace). Department
 *  members reach the same lists as workspace quick views (bug 2). */
export function SharesPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "by-me" ? "by-me" : "with-me";

  function setTab(next: Tab) {
    setParams(next === "with-me" ? {} : { tab: next }, { replace: true });
  }

  return (
    <AppShell>
      <h1 className="text-[30px] font-bold leading-[1.15] tracking-[-0.6px] text-ink">Shares</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Documents shared with you, and everything you've sent out.
      </p>

      <div className="mt-6 inline-flex rounded-lg border border-line p-0.5">
        {(["with-me", "by-me"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-[13.5px] font-medium transition-colors ${
              tab === t ? "bg-primary text-white" : "text-muted hover:text-ink"
            }`}
          >
            {t === "with-me" ? "Shared with me" : "Shared by me"}
          </button>
        ))}
      </div>

      <div className="mt-6">
        <SharesList mode={tab} />
      </div>
    </AppShell>
  );
}
