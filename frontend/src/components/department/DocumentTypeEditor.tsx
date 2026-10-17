import { useState } from "react";
import {
  FIELD_TYPE_HINTS,
  FIELD_TYPE_LABELS,
  type DraftDocumentType,
  type DraftField,
  type FieldType,
} from "../../lib/departments";
import { inputBase, inputClass } from "../AuthCard";
import { Select } from "../Select";
import { ChevronRightIcon, DocumentIcon, DragIcon, PlusIcon, TrashIcon } from "../icons";

const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];

// Purely categorical: a colour per position in the list, so a long set of document types stays
// scannable. It encodes no state and must never be read as one.
const CATEGORY_TINTS = [
  "bg-cat-teal-tint text-cat-teal",
  "bg-cat-green-tint text-cat-green",
  "bg-cat-orange-tint text-cat-orange",
  "bg-cat-indigo-tint text-cat-indigo",
];

function blankField(): DraftField {
  return { label: "", fieldType: "text", isRequired: false, isFilterable: true, isTitle: false };
}

function blankType(): DraftDocumentType {
  return {
    name: "",
    idCode: "",
    // A type always starts with one field, and that field is the title — a document type with no
    // title field can't be saved (exactly one is required), so starting valid beats starting broken.
    fields: [{ ...blankField(), label: "Title", isRequired: true, isTitle: true }],
  };
}

export function DocumentTypeEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: DraftDocumentType[];
  onChange: (next: DraftDocumentType[]) => void;
  /** The department's ID prefix, so the sample document ID shown is the real one. */
  idPrefix?: string;
}) {
  const [selected, setSelected] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const active = value[Math.min(selected, value.length - 1)];
  const activeIndex = Math.min(selected, value.length - 1);

  function updateType(index: number, patch: Partial<DraftDocumentType>) {
    onChange(value.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function updateField(fieldIndex: number, patch: Partial<DraftField>) {
    if (!active) return;
    updateType(activeIndex, {
      fields: active.fields.map((f, i) => (i === fieldIndex ? { ...f, ...patch } : f)),
    });
  }

  function setTitleField(fieldIndex: number) {
    if (!active) return;
    // Exactly one title field per type (DEP-2) — selecting one always clears the others.
    updateType(activeIndex, {
      fields: active.fields.map((f, i) => ({ ...f, isTitle: i === fieldIndex })),
    });
  }

  function moveField(from: number, to: number) {
    if (!active || to < 0 || to >= active.fields.length || from === to) return;
    const fields = [...active.fields];
    const [moved] = fields.splice(from, 1);
    if (!moved) return;
    fields.splice(to, 0, moved);
    updateType(activeIndex, { fields });
  }

  function removeField(fieldIndex: number) {
    if (!active || active.fields.length <= 1) return;
    const removed = active.fields[fieldIndex];
    const fields = active.fields.filter((_, i) => i !== fieldIndex);
    // The title can't simply disappear — hand it to the first remaining field.
    if (removed?.isTitle && fields[0]) fields[0] = { ...fields[0], isTitle: true };
    updateType(activeIndex, { fields });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-1.5">
        {value.map((type, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setSelected(index)}
            className={`relative flex w-full items-center gap-3.5 overflow-hidden rounded-xl border px-4 py-3.5 text-left transition-colors ${
              index === activeIndex
                ? "border-primary/25 bg-primary-tint"
                : "border-line bg-surface hover:bg-surface-muted"
            }`}
          >
            {index === activeIndex && (
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-primary" />
            )}
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CATEGORY_TINTS[index % CATEGORY_TINTS.length]}`}
            >
              <DocumentIcon size={17} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-semibold text-ink">
                {type.name || "Untitled type"}
              </span>
              <span className="mt-0.5 block text-[12.5px] text-subtle">
                <span className="font-mono">{type.idCode || "···"}</span> · {type.fields.length} field
                {type.fields.length === 1 ? "" : "s"}
              </span>
            </span>
            {index === activeIndex && <ChevronRightIcon size={16} className="text-primary" />}
          </button>
        ))}

        <button
          type="button"
          onClick={() => {
            onChange([...value, blankType()]);
            setSelected(value.length);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 py-3.5 text-[14.5px] font-medium text-ink transition-colors hover:border-primary/40 hover:text-primary"
        >
          <PlusIcon size={17} /> Add document type
        </button>
      </div>

      {active && (
        <div className="rounded-2xl border border-line bg-surface p-7">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[200px] flex-1">
              <label className="mb-2 block text-[13.5px] font-medium text-ink">Type name</label>
              <input
                className={inputClass}
                value={active.name}
                placeholder="Contract"
                onChange={(e) => updateType(activeIndex, { name: e.target.value })}
              />
            </div>
            <div className="w-36">
              <label className="mb-2 block text-[13.5px] font-medium text-ink">ID code</label>
              <input
                className={`${inputClass} font-mono uppercase`}
                value={active.idCode}
                placeholder="CON"
                maxLength={8}
                onChange={(e) => updateType(activeIndex, { idCode: e.target.value.toUpperCase() })}
              />
            </div>
            {value.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  onChange(value.filter((_, i) => i !== activeIndex));
                  setSelected(Math.max(0, activeIndex - 1));
                }}
                className="mb-1 flex items-center gap-2 rounded-lg px-3 py-2.5 text-[14px] font-semibold text-danger transition-colors hover:bg-danger-tint"
              >
                <TrashIcon size={16} /> Remove type
              </button>
            )}
          </div>

          <p className="mt-4 flex flex-wrap items-center gap-2.5 text-[13.5px] text-muted">
            Document IDs for this type will read like
            <span className="plate px-2.5 py-1">
              {`${idPrefix || "«PREFIX»"}-${active.idCode || "···"}-${new Date().getFullYear()}-00001`}
            </span>
          </p>

          <div className="mt-6 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
              <h4 className="text-[15px] font-semibold text-ink">Fields</h4>
              <span className="text-[13px] text-subtle">Drag to reorder — this is the upload-form order</span>
            </div>

            {active.fields.map((field, index) => (
              <div
                key={index}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) moveField(dragIndex, index);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                className={`rounded-xl border bg-surface p-4 transition-shadow ${
                  dragIndex === index ? "border-primary/50 shadow-card-lg" : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-center gap-3.5">
                  <span className="cursor-grab text-subtle active:cursor-grabbing" aria-hidden="true">
                    <DragIcon size={16} />
                  </span>
                  <input
                    className={`${inputBase} min-w-[140px] flex-1`}
                    value={field.label}
                    placeholder="Field name"
                    onChange={(e) => updateField(index, { label: e.target.value })}
                  />
                  <Select
                    ariaLabel={`Type of ${field.label || "field"}`}
                    className="w-[150px]"
                    value={field.fieldType}
                    // The hint travels with the option, so the consequence of each type is visible
                    // while choosing rather than only after.
                    options={FIELD_TYPES.map((t) => ({
                      value: t,
                      label: FIELD_TYPE_LABELS[t],
                      hint: FIELD_TYPE_HINTS[t],
                    }))}
                    onChange={(next) => {
                      const fieldType = next as FieldType;
                      updateField(index, {
                        fieldType,
                        options: fieldType === "dropdown" ? (field.options ?? [""]) : undefined,
                      });
                    }}
                  />

                  <div className="flex items-center gap-5 text-[13.5px] text-muted">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={field.isRequired}
                        onChange={(e) => updateField(index, { isRequired: e.target.checked })}
                      />
                      Required
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-primary"
                        checked={field.isFilterable}
                        onChange={(e) => updateField(index, { isFilterable: e.target.checked })}
                      />
                      Filterable
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`title-${activeIndex}`}
                        className="h-4 w-4 accent-primary"
                        checked={field.isTitle}
                        onChange={() => setTitleField(index)}
                      />
                      Title
                    </label>
                  </div>

                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="Move up"
                      onClick={() => moveField(index, index - 1)}
                      disabled={index === 0}
                      className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface hover:text-ink disabled:opacity-30"
                    >
                      <ChevronRightIcon size={13} className="-rotate-90" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      onClick={() => moveField(index, index + 1)}
                      disabled={index === active.fields.length - 1}
                      className="rounded-md p-1.5 text-subtle transition-colors hover:bg-surface hover:text-ink disabled:opacity-30"
                    >
                      <ChevronRightIcon size={13} className="rotate-90" />
                    </button>
                    <button
                      type="button"
                      aria-label="Remove field"
                      onClick={() => removeField(index)}
                      disabled={active.fields.length <= 1}
                      className="rounded-md p-1.5 text-subtle transition-colors hover:bg-danger-tint hover:text-danger disabled:opacity-30"
                    >
                      <TrashIcon size={15} />
                    </button>
                  </div>
                </div>

                <p className="mt-2 pl-8 text-[13px] text-subtle">{FIELD_TYPE_HINTS[field.fieldType]}</p>

                {field.fieldType === "dropdown" && (
                  <div className="mt-2 pl-8">
                    <label className="mb-2 block text-[13px] font-medium text-ink">
                      Options — one per line
                    </label>
                    <textarea
                      className={`${inputClass} min-h-[92px] bg-surface-inset font-mono text-[13.5px] leading-6`}
                      value={(field.options ?? []).join("\n")}
                      onChange={(e) =>
                        updateField(index, { options: e.target.value.split("\n").map((o) => o.trimStart()) })
                      }
                    />
                  </div>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={() => updateType(activeIndex, { fields: [...active.fields, blankField()] })}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface py-3.5 text-[14.5px] font-medium text-ink transition-colors hover:border-primary/40 hover:text-primary"
            >
              <PlusIcon size={17} /> Add field
            </button>
          </div>

          <p className="mt-6 flex items-start gap-2.5 rounded-xl bg-primary-tint px-4 py-3.5 text-[13.5px] leading-relaxed text-muted">
            <DocumentIcon size={17} className="mt-0.5 shrink-0 text-primary" />
            Each field defined here becomes three things at once — a box on the upload form, a
            control in the filter panel, and an entry in the search index.
          </p>
        </div>
      )}
    </div>
  );
}

/** Client-side mirror of the server's document-type rules, so the wizard can block Next early. */
export function validateDocumentTypes(types: DraftDocumentType[]): string | null {
  if (types.length === 0) return "Add at least one document type.";
  for (const type of types) {
    if (!type.name.trim()) return "Every document type needs a name.";
    if (!/^[A-Z0-9]{1,8}$/.test(type.idCode)) return `"${type.name}" needs an ID code (uppercase letters/digits).`;
    if (type.fields.length === 0) return `"${type.name}" needs at least one field.`;
    if (type.fields.some((f) => !f.label.trim())) return `Every field in "${type.name}" needs a name.`;
    if (type.fields.filter((f) => f.isTitle).length !== 1)
      return `"${type.name}" needs exactly one title field.`;
    const labels = type.fields.map((f) => f.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) return `"${type.name}" has two fields with the same name.`;
    for (const field of type.fields) {
      if (field.fieldType === "dropdown" && (field.options ?? []).filter((o) => o.trim()).length === 0)
        return `Dropdown field "${field.label}" needs at least one option.`;
    }
  }
  const codes = types.map((t) => t.idCode);
  if (new Set(codes).size !== codes.length) return "Two document types share the same ID code.";
  const names = types.map((t) => t.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Two document types share the same name.";
  return null;
}

/** Strips empty dropdown options and trims labels before sending to the API. */
export function cleanDocumentTypes(types: DraftDocumentType[]): DraftDocumentType[] {
  return types.map((t) => ({
    ...t,
    name: t.name.trim(),
    idCode: t.idCode.trim().toUpperCase(),
    fields: t.fields.map((f) => ({
      ...f,
      label: f.label.trim(),
      options:
        f.fieldType === "dropdown" ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined,
    })),
  }));
}
