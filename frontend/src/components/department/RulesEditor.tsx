import { ShieldIcon, TagIcon } from "../icons";
import { inputBase } from "../AuthCard";
import type { DepartmentRules } from "../../lib/departments";

/**
 * Feature Spec §3 Step 5. Only default sharing is editable, because it is the only part of that
 * step the data model can store — see Data Model §2.4's note on `department.rules`. The other two
 * blocks below are stated plainly rather than shown as switches that do nothing.
 */
export function RulesEditor({
  value,
  onChange,
  subjectTerm,
}: {
  value: DepartmentRules;
  onChange: (next: DepartmentRules) => void;
  subjectTerm?: string | null;
}) {
  const sharing = value.defaultSharing;

  function patchSharing(patch: Partial<DepartmentRules["defaultSharing"]>) {
    onChange({ ...value, defaultSharing: { ...sharing, ...patch } });
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-line-muted bg-surface-muted p-6">
        <h3 className="text-[15.5px] font-semibold text-ink">Default sharing</h3>
        <p className="mt-1 text-[14px] text-muted">
          The baseline applied to every {(subjectTerm ?? "record").toLowerCase()} document nobody
          thinks to configure — which is most of them.
        </p>

        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-line-muted bg-surface px-4 py-3.5 transition-colors hover:border-primary/40">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={sharing.externalLinksEnabled}
            onChange={(e) => patchSharing({ externalLinksEnabled: e.target.checked })}
          />
          <span>
            <span className="block text-[13.5px] font-medium text-ink">
              Allow external share links from this department
            </span>
            <span className="mt-0.5 block text-[12.5px] text-muted">
              Off by default. Even when on, a link can only be created by someone whose role grants
              it — this setting can close the door, never open one a role has shut.
            </span>
          </span>
        </label>

        <div className="mt-4">
          <label className="mb-1.5 block text-[13px] font-medium text-muted">
            External links expire after
          </label>
          <div className="flex items-center gap-2.5">
            <input
              type="number"
              min={1}
              max={365}
              className={`${inputBase} w-28`}
              value={sharing.linkExpiryDays}
              onChange={(e) => patchSharing({ linkExpiryDays: Number(e.target.value) })}
            />
            <span className="text-[14.5px] text-muted">days</span>
          </div>
          <p className="mt-1.5 text-[12px] text-subtle">
            Expiry is mandatory on external links — this sets the default offered when one is
            created, not whether it expires.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-dashed border-line bg-surface-inset/70 p-6">
        <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
          <TagIcon size={17} className="text-subtle" /> Auto-tagging
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Not built yet, and deliberately not faked: a rule like "anything uploaded to Contracts is
          tagged Legal" needs folders to point at (not built yet) and a tag field on the document
          (which the data model doesn't have). It arrives with folders and upload.
        </p>
      </div>

      <div className="rounded-2xl border border-dashed border-line bg-surface-inset/70 p-6">
        <h3 className="flex items-center gap-2 text-[15.5px] font-semibold text-ink">
          <ShieldIcon size={17} className="text-subtle" /> Retention, expiry reminders and workflow
        </h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Release 2. Retention periods, auto-archiving, retention locks and approval routing are out
          of scope for this release, so they aren't shown as switches that do nothing.
        </p>
      </div>
    </div>
  );
}
