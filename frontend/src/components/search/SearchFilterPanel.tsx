import { inputBase } from "../AuthCard";
import { DateRangePicker } from "../DateRangePicker";
import { Select } from "../Select";
import { MultiSearchSelect } from "../SearchableSelect";
import { XIcon } from "../icons";
import type { DraftDocumentType, DraftField } from "../../lib/departments";
import type { SearchFilter } from "../../lib/search";

type DocType = DraftDocumentType & { id: string };

/**
 * The filter panel, generated from the schema (SRCH-2). Filters are per-document-type because
 * fields belong to a type, so choosing a type reveals its filterable fields, each rendered with the
 * control its `field_type` dictates: text/ID → contains, dropdown → multi-select, date → range,
 * number → range. Filters stack and combine with the text search.
 *
 * Two standard filters lead every department's panel with no admin setup (SRCH-6): Document Type
 * and Upload Date (From – To, both inclusive, read on the organization's calendar by the server).
 * They AND with each other, with the field filters and with the search text.
 */
export function SearchFilterPanel({
  documentTypes,
  documentTypeId,
  onDocumentTypeChange,
  filters,
  onFiltersChange,
  uploadedFrom,
  uploadedTo,
  onUploadedChange,
  dateRangeError,
  onClearAll,
  onClose,
}: {
  documentTypes: DocType[];
  documentTypeId: string;
  onDocumentTypeChange: (id: string) => void;
  filters: SearchFilter[];
  onFiltersChange: (filters: SearchFilter[]) => void;
  uploadedFrom: string;
  uploadedTo: string;
  onUploadedChange: (from: string, to: string) => void;
  dateRangeError: string | null;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const type = documentTypes.find((t) => t.id === documentTypeId);
  const filterable = (type?.fields ?? []).filter((f) => f.id && f.isFilterable);

  const filterFor = (fieldDefId: string) => filters.find((f) => f.fieldDefId === fieldDefId);
  function setFilter(fieldDefId: string, next: SearchFilter | null) {
    const rest = filters.filter((f) => f.fieldDefId !== fieldDefId);
    onFiltersChange(next ? [...rest, next] : rest);
  }

  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-subtle">Filters</h3>
        <div className="flex items-center gap-3">
          {(filters.length > 0 || documentTypeId || uploadedFrom || uploadedTo) && (
            <button
              type="button"
              onClick={onClearAll}
              className="text-[13px] font-medium text-primary hover:underline"
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            aria-label="Close filters"
            onClick={onClose}
            className="rounded-md p-1 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={15} />
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Document type</label>
          <Select
            value={documentTypeId}
            ariaLabel="Filter by document type"
            className="w-full"
            options={[
              { value: "", label: "All types" },
              ...documentTypes.map((t) => ({ value: t.id, label: t.name, hint: t.idCode })),
            ]}
            onChange={onDocumentTypeChange}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">Upload date</label>
          <DateRangePicker
            from={uploadedFrom}
            to={uploadedTo}
            onChange={onUploadedChange}
            presets
            invalid={Boolean(dateRangeError)}
            label="Upload date"
            className="w-full"
          />
          {dateRangeError ? (
            <p role="alert" className="mt-1.5 text-[12.5px] font-medium text-danger">
              {dateRangeError}
            </p>
          ) : (
            <p className="mt-1.5 text-[12px] text-subtle">Either date alone works. Both days are included.</p>
          )}
        </div>
      </div>

      {filterable.length > 0 && (
        <div className="mt-5 grid gap-4 border-t border-line-muted pt-5 sm:grid-cols-2 lg:grid-cols-3">
          {filterable.map((field) => (
            <FieldFilter
              key={field.id}
              field={field}
              current={filterFor(field.id!)}
              onChange={(next) => setFilter(field.id!, next)}
            />
          ))}
        </div>
      )}

      {documentTypeId && filterable.length === 0 && (
        <p className="mt-3 text-[13px] text-subtle">This document type has no filterable fields.</p>
      )}
      {!documentTypeId && (
        <p className="mt-3 text-[13px] text-subtle">
          Choose a document type to filter by its fields. Text search works across all types.
        </p>
      )}
    </div>
  );
}

/** Dropdown fields with more options than this switch from chips to a searchable list. */
const CHIP_LIMIT = 20;

function FieldFilter({
  field,
  current,
  onChange,
}: {
  field: DraftField;
  current: SearchFilter | undefined;
  onChange: (next: SearchFilter | null) => void;
}) {
  const id = field.id!;
  const label = <label className="mb-1.5 block text-[12.5px] font-medium text-ink">{field.label}</label>;
  const input = `${inputBase} w-full`;

  if (field.fieldType === "dropdown") {
    const selected = current?.values ?? [];
    const toggle = (opt: string) => {
      const next = selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt];
      onChange(next.length ? { fieldDefId: id, op: "in", values: next } : null);
    };
    const options = field.options ?? [];
    // Up to 20 options read best as tappable chips; past that (some departments have 200+), a wall
    // of chips is unusable, so the field becomes a searchable tick-list instead.
    if (options.length > CHIP_LIMIT) {
      return (
        <div>
          {label}
          <MultiSearchSelect
            values={selected}
            ariaLabel={field.label}
            className="w-full"
            placeholder="Any"
            searchPlaceholder={`Search ${options.length} options…`}
            options={options.map((o) => ({ value: o, label: o }))}
            onChange={(next) => onChange(next.length ? { fieldDefId: id, op: "in", values: next } : null)}
          />
        </div>
      );
    }
    return (
      <div>
        {label}
        <div className="flex flex-wrap gap-1.5">
          {(field.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                selected.includes(opt)
                  ? "border-primary bg-primary-tint text-primary"
                  : "border-line text-muted hover:border-primary/40"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.fieldType === "date" || field.fieldType === "number") {
    const op = field.fieldType === "date" ? "date_range" : "number_range";
    const setRange = (from: string, to: string) =>
      onChange(from || to ? { fieldDefId: id, op, from: from || undefined, to: to || undefined } : null);
    const set = (part: "from" | "to", v: string) =>
      setRange(part === "from" ? v : (current?.from ?? ""), part === "to" ? v : (current?.to ?? ""));

    if (field.fieldType === "date") {
      return (
        <div>
          {label}
          <DateRangePicker
            from={current?.from ?? ""}
            to={current?.to ?? ""}
            onChange={setRange}
            label={field.label}
            className="w-full"
          />
        </div>
      );
    }
    return (
      <div>
        {label}
        <div className="flex items-center gap-2">
          <input type="number" aria-label={`${field.label} from`} className={input} value={current?.from ?? ""} onChange={(e) => set("from", e.target.value)} />
          <span className="text-subtle">–</span>
          <input type="number" aria-label={`${field.label} to`} className={input} value={current?.to ?? ""} onChange={(e) => set("to", e.target.value)} />
        </div>
      </div>
    );
  }

  // text / id / person → contains
  return (
    <div>
      {label}
      <input
        className={input}
        value={current?.value ?? ""}
        placeholder="Contains…"
        onChange={(e) => onChange(e.target.value ? { fieldDefId: id, op: "contains", value: e.target.value } : null)}
      />
    </div>
  );
}
