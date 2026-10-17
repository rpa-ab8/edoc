import { inputBase } from "../AuthCard";
import { Select } from "../Select";
import type { DraftField } from "../../lib/departments";

export type FieldValues = Record<string, string>;

/**
 * The upload/metadata form, generated from a document type's field definitions (Feature Spec §6.2:
 * "there is no single fixed upload form"). One `field_def` drives the input control here just as it
 * drives the filter control and the search index — define once, works everywhere.
 *
 * Nothing here blocks: required fields are marked, but a file can always save incomplete and land
 * in the needs-details queue (UPL-5). The asterisk is a nudge, not a gate.
 */
export function MetadataFields({
  fields,
  values,
  onChange,
  omitFieldIds = [],
  columns = 2,
}: {
  fields: DraftField[];
  values: FieldValues;
  onChange: (fieldDefId: string, value: string) => void;
  omitFieldIds?: string[];
  columns?: 1 | 2;
}) {
  const shown = fields.filter((f) => f.id && !omitFieldIds.includes(f.id));
  if (shown.length === 0) {
    return <p className="text-[13.5px] text-subtle">This document type has no metadata fields.</p>;
  }

  return (
    <div className={`grid gap-4 ${columns === 2 ? "sm:grid-cols-2" : ""}`}>
      {shown.map((field) => {
        const id = field.id!;
        const value = values[id] ?? "";
        return (
          <div key={id} className={field.fieldType === "dropdown" || columns === 1 ? "" : ""}>
            <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink">
              {field.label}
              {field.isRequired && (
                <span className="text-[11px] font-normal text-subtle" title="Recommended — you can complete it later">
                  required
                </span>
              )}
              {field.isTitle && (
                <span className="rounded bg-primary-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
                  title
                </span>
              )}
            </label>

            {field.fieldType === "dropdown" ? (
              <Select
                value={value}
                ariaLabel={field.label}
                placeholder="Select…"
                className="w-full"
                options={[
                  { value: "", label: "—" },
                  ...(field.options ?? []).map((o) => ({ value: o, label: o })),
                ]}
                onChange={(v) => onChange(id, v)}
              />
            ) : (
              <input
                type={field.fieldType === "date" ? "date" : field.fieldType === "number" ? "number" : "text"}
                className={`${inputBase} w-full`}
                value={value}
                placeholder={placeholderFor(field)}
                onChange={(e) => onChange(id, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function placeholderFor(field: DraftField): string {
  switch (field.fieldType) {
    case "id":
      return "e.g. EMP-1042";
    case "number":
      return "0";
    case "person":
      return "Full name";
    default:
      return "";
  }
}
