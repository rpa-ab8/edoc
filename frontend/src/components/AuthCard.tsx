import type { ReactNode } from "react";

export function Logomark({ size = 40 }: { size?: number }) {
  const iconSize = Math.round(size * 0.45);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl bg-primary"
      style={{ width: size, height: size }}
    >
      <svg width={iconSize} height={iconSize} viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M4 1.5h6.5L14 5v11a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4 16V1.5Z"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M10.25 1.5V5h3.75" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M6.5 9.5h5M6.5 12h5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function StepProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-5 flex gap-1.5" role="progressbar" aria-valuenow={current} aria-valuemin={1} aria-valuemax={total}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors ${i < current ? "bg-primary" : "bg-line"}`}
        />
      ))}
    </div>
  );
}

export function AuthCard({
  title,
  subtitle,
  eyebrow,
  step,
  children,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  step?: { current: number; total: number };
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm animate-card-in">
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-card-lg">
          <Logomark />
          {step && <div className="mt-6"><StepProgress current={step.current} total={step.total} /></div>}
          {eyebrow && (
            <p className={`${step ? "" : "mt-6"} mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-subtle`}>
              {eyebrow}
            </p>
          )}
          <h1 className={`${eyebrow || step ? "" : "mt-6"} text-[22px] font-bold leading-tight tracking-[-0.4px] text-ink`}>
            {title}
          </h1>
          {subtitle && <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}

export function SuccessIcon() {
  return (
    <div className="mx-auto mb-4 flex h-12 w-12 animate-pop items-center justify-center rounded-full bg-success-tint">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M4 10.5 8 14.5 16 5.5" stroke="#0F6B52" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "primary";
  children: ReactNode;
}) {
  const tones = {
    success: "bg-success-tint text-success",
    warning: "bg-warning-tint text-warning",
    danger: "bg-danger-tint text-danger",
    primary: "bg-primary-tint text-primary",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="mb-2 block text-[13.5px] font-medium text-ink">{children}</label>;
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-2 text-[13.5px] text-danger">{message}</p>;
}

// Inputs are recessed into the card rather than outlined on top of it — a warm neutral well with
// a hairline, so a form reads as a set of places to put something rather than a stack of boxes.
// The focus ring is generous: it is the only state change a text field gets.
export const inputBase =
  "rounded-lg border border-line bg-surface px-3.5 py-2.5 font-sans text-[15px] leading-6 text-ink placeholder:text-subtle focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 transition-[border-color,box-shadow]";

// Full-width by default — the common case in a form. Use `inputBase` when you need to set the
// width yourself; appending `w-52` to this one silently loses to the `w-full` already in it.
export const inputClass = `w-full ${inputBase}`;

// `*ButtonBase` carries no width — append your own. The `*ButtonClass` variants add `w-full`
// for the auth cards, where every button is a full-width form action. Don't try to narrow one of
// those by appending `w-auto`: both are single-class utilities of equal specificity, so which one
// wins depends on stylesheet order, not the order you wrote them in — it silently stayed full
// width. Use the base variant instead.
export const primaryButtonBase =
  "rounded-lg bg-primary px-5 py-2.5 text-center font-sans text-[14.5px] font-semibold text-white shadow-action transition-all hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export const secondaryButtonBase =
  "rounded-lg border border-line bg-surface px-5 py-2.5 text-center font-sans text-[14.5px] font-medium text-ink transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export const primaryButtonClass = `w-full ${primaryButtonBase}`;

export const secondaryButtonClass = `w-full ${secondaryButtonBase}`;

export const linkClass = "font-medium text-primary transition-colors hover:text-primary-dark hover:underline";
