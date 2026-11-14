import type { ReactNode } from "react";

export function NavButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:border-[#C9D2CD] hover:bg-surface-muted hover:text-ink"
    >
      {children}
    </button>
  );
}

export function GridChoice({
  selected,
  current,
  onClick,
  children,
}: {
  selected: boolean;
  current: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-12 rounded-xl text-[14px] transition-colors ${
        selected
          ? "bg-primary font-semibold text-white shadow-action hover:bg-primary-dark"
          : current
            ? "font-semibold text-primary ring-1 ring-inset ring-primary/30 hover:bg-primary-tint"
            : "font-medium text-ink hover:bg-surface-muted"
      }`}
    >
      {children}
    </button>
  );
}
