import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { primaryButtonBase, secondaryButtonBase } from "../AuthCard";
import { MetadataFields, type FieldValues } from "./MetadataFields";
import { CheckCircleIcon, DocumentIcon, XIcon } from "../icons";
import { editDocumentMetadata, fetchDocument, fetchNeedsDetails } from "../../lib/documents";
import { ApiRequestError } from "../../lib/api";
import type { DraftDocumentType } from "../../lib/departments";

type DocType = DraftDocumentType & { id: string };

/**
 * The needs-details queue (UPL-5): documents saved by a never-block upload that are missing a
 * required field value. Completing the metadata here removes them from the queue — the same
 * `field_def` set that generated the upload form generates the completion form.
 */
export function NeedsDetailsPanel({
  departmentId,
  documentTypes,
  onClose,
  onUpdated,
}: {
  departmentId: string;
  documentTypes: DocType[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { data: items, refetch, isLoading } = useQuery({
    queryKey: ["needs-details", departmentId],
    queryFn: () => fetchNeedsDetails(departmentId),
  });
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl animate-card-in rounded-2xl border border-line bg-surface shadow-card-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="text-[17px] font-bold tracking-[-0.3px] text-ink">Needs details</h2>
            <p className="text-[13px] text-subtle">
              Documents saved with missing information — complete them anytime.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {isLoading ? (
            <p className="py-8 text-center text-[14px] text-subtle">Loading…</p>
          ) : !items || items.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success-tint text-success">
                <CheckCircleIcon size={22} />
              </span>
              <p className="mt-4 text-[15px] font-semibold text-ink">Everything's complete</p>
              <p className="mt-1 text-[13.5px] text-subtle">No documents are waiting for details.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {items.map((item) => (
                <li key={item.id} className="rounded-xl border border-line bg-surface">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-subtle">
                      <DocumentIcon size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="plate px-2 py-0.5">{item.documentRef}</span>
                        <span className="truncate text-[14px] font-medium text-ink">
                          {item.titleValue ?? "Untitled"}
                        </span>
                      </div>
                      <p className="mt-1 text-[12.5px] text-subtle">
                        Missing: {item.missingFields.join(", ")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditing(editing === item.id ? null : item.id)}
                      className={`${secondaryButtonBase} px-4 py-2 text-[13.5px]`}
                    >
                      {editing === item.id ? "Close" : "Complete"}
                    </button>
                  </div>

                  {editing === item.id && (
                    <CompleteDetailsForm
                      documentId={item.id}
                      documentTypes={documentTypes}
                      onSaved={() => {
                        setEditing(null);
                        void refetch();
                        onUpdated();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CompleteDetailsForm({
  documentId,
  documentTypes,
  onSaved,
}: {
  documentId: string;
  documentTypes: DocType[];
  onSaved: () => void;
}) {
  const { data: doc, isLoading } = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => fetchDocument(documentId),
  });
  const [values, setValues] = useState<FieldValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = doc ? documentTypes.find((t) => t.id === doc.documentType.id) : undefined;

  // Prefill once the document loads, from its existing field values.
  const initial: FieldValues = {};
  if (doc) for (const fv of doc.fieldValues) if (fv.fieldDefId) initial[fv.fieldDefId] = fv.value;
  const current = values ?? initial;

  async function save() {
    if (!type) return;
    setSaving(true);
    setError(null);
    try {
      const fieldValues = Object.entries(current)
        .filter(([, v]) => v.trim() !== "")
        .map(([fieldDefId, value]) => ({ fieldDefId, value: value.trim() }));
      await editDocumentMetadata(documentId, fieldValues);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't save the details.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !doc || !type) {
    return <p className="border-t border-line px-4 py-4 text-[13.5px] text-subtle">Loading fields…</p>;
  }

  return (
    <div className="border-t border-line bg-surface-muted/40 px-4 py-4">
      <MetadataFields
        fields={type.fields}
        values={current}
        onChange={(id, value) => setValues({ ...current, [id]: value })}
      />
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2.5">
        <button type="button" disabled={saving} onClick={() => void save()} className={`${primaryButtonBase} px-5`}>
          {saving ? "Saving…" : "Save details"}
        </button>
      </div>
    </div>
  );
}
