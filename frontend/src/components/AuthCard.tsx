import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon } from "./icons";

export function Logomark({ size = 40 }: { size?: number }) {
  const iconSize = Math.round(size * 0.45);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl bg-primary bg-gradient-to-b from-[#168363] to-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_1px_2px_rgba(10,33,29,0.3)]"
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
    <div className="mb-7">
      <p className="mb-2.5 text-[13.5px] font-medium text-subtle">
        Step {current} of {total}
      </p>
      <div className="flex gap-1.5" role="progressbar" aria-valuenow={current} aria-valuemin={1} aria-valuemax={total}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${i < current ? "bg-primary" : "bg-line"}`}
          />
        ))}
      </div>
    </div>
  );
}

// ── The background behind every signed-out screen ───────────────────────────
// Deliberately quiet: a deep green field with one soft light and three low, smooth hills at the
// bottom edge. Earlier versions (a moonlit valley, paper-cut hills with drifting pages) were
// judged too busy — the form is the point of this screen, the background only has to hold it.
// Inline SVG, anchored to the bottom so the hills always sit on the screen's lower edge.
const HILLS = [
  { d: "M0 700 C220 650 420 730 680 690 S1120 640 1440 700 V900 H0Z", fill: "#0E3A30" },
  { d: "M0 770 C240 730 480 800 760 760 S1200 725 1440 775 V900 H0Z", fill: "#0B2E26" },
  { d: "M0 840 C260 810 520 862 800 836 S1220 815 1440 846 V900 H0Z", fill: "#07221C" },
];

function AuthArt() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMax slice"
    >
      <defs>
        <linearGradient id="auth-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0A211D" />
          <stop offset="1" stopColor="#11473A" />
        </linearGradient>
        <radialGradient id="auth-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#3FA585" stopOpacity="0.4" />
          <stop offset="1" stopColor="#3FA585" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1440" height="900" fill="url(#auth-sky)" />
      <circle cx="1020" cy="560" r="520" fill="url(#auth-glow)" />
      {HILLS.map((h) => (
        <path key={h.fill} d={h.d} fill={h.fill} />
      ))}
    </svg>
  );
}
/**
 * The frame for every signed-out screen (sign in, register, reset, invitations…).
 *
 * The artwork fills the screen. The form sits on a white card on the LEFT — where the eye lands
 * first — and at `lg` and up a serif line sits in the sky on the right. On a phone only the brand
 * row and the card show, with the artwork still behind them.
 */
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
    <div className="relative min-h-screen overflow-hidden bg-rail">
      <AuthArt />

      <div className="relative flex min-h-screen flex-col">
        <header className="flex items-center gap-3 px-6 pt-7 sm:px-10 lg:px-16 lg:pt-11">
          <Logomark size={38} />
          <span className="text-[20px] font-semibold tracking-[-0.01em] text-rail-ink">Edoc</span>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center px-5 py-8 sm:px-10 lg:flex-row lg:justify-between lg:gap-12 lg:px-16">
          <main className="w-full max-w-[440px] animate-card-in lg:ml-[3vw] lg:shrink-0">
            <div className="rounded-[28px] bg-surface p-7 shadow-[0_44px_90px_-30px_rgba(1,8,6,0.9),0_2px_6px_rgba(1,8,6,0.3)] ring-1 ring-white/60 sm:p-10">
              {step && <StepProgress current={step.current} total={step.total} />}
              {eyebrow && <p className="mb-2 text-[13.5px] font-medium text-primary">{eyebrow}</p>}
              <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">{title}</h1>
              {subtitle && <p className="mt-2.5 text-[15px] leading-relaxed text-muted">{subtitle}</p>}
              <div className="mt-7">{children}</div>
            </div>
          </main>

          <div className="hidden max-w-[420px] text-right lg:block">
            <p
              className="text-[46px] leading-[1.08] tracking-[-0.02em] text-rail-ink xl:text-[54px]"
              style={{ fontFamily: '"Fraunces", Georgia, serif', fontWeight: 400, textWrap: "balance" }}
            >
              Every page in its place.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
/** A password field with a show/hide toggle. Takes every normal input prop. */
export function PasswordInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={visible ? "text" : "password"} className={`${inputClass} pr-11 ${className}`} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-subtle transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
      </button>
    </div>
  );
}

/** A form-level error: what went wrong, in a block that can't be missed. */
export function FormAlert({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-danger/20 bg-danger-tint px-3.5 py-3 text-[14px] leading-snug text-[#A31B1B]"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="mt-px shrink-0">
        <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 6.5v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="10" cy="13.4" r="0.9" fill="currentColor" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" className="animate-spin">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.2" />
      <path d="M17.5 10A7.5 7.5 0 0 0 10 2.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** Label + control pair with the label correctly tied to its input. */
export function Field({
  label,
  action,
  children,
}: {
  label: string;
  /** Sits on the label's row, right-aligned — e.g. "Forgot password?". */
  action?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="block text-[13.5px] font-medium text-ink">
          {label}
        </label>
        {action}
      </div>
      {children(id)}
    </div>
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
  "rounded-lg border border-line bg-surface px-3.5 py-2.5 font-sans text-[15px] leading-6 text-ink placeholder:text-subtle focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15 transition-[border-color,box-shadow] shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-[#CDD3CF] focus:hover:border-primary";

// Full-width by default — the common case in a form. Use `inputBase` when you need to set the
// width yourself; appending `w-52` to this one silently loses to the `w-full` already in it.
export const inputClass = `w-full ${inputBase}`;

// `*ButtonBase` carries no width — append your own. The `*ButtonClass` variants add `w-full`
// for the auth cards, where every button is a full-width form action. Don't try to narrow one of
// those by appending `w-auto`: both are single-class utilities of equal specificity, so which one
// wins depends on stylesheet order, not the order you wrote them in — it silently stayed full
// width. Use the base variant instead.
export const primaryButtonBase =
  "rounded-lg bg-primary px-5 py-2.5 text-center font-sans text-[14.5px] font-semibold text-white shadow-action transition-all hover:bg-primary-dark active:translate-y-px active:shadow-none disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export const secondaryButtonBase =
  "rounded-lg border border-line bg-surface px-5 py-2.5 text-center font-sans text-[14.5px] font-medium text-ink shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition-colors hover:border-[#CDD3CF] hover:bg-surface-muted active:translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export const primaryButtonClass = `w-full ${primaryButtonBase}`;

export const secondaryButtonClass = `w-full ${secondaryButtonBase}`;

export const linkClass = "font-medium text-primary transition-colors hover:text-primary-dark hover:underline";
