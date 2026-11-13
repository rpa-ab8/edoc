import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { CheckIcon, CopyIcon } from "./icons";

type CopyButtonProps = {
  text: string;
  /** Accessible name, e.g. "Copy document ID". */
  label?: string;
  size?: number;
  className?: string;
};

/** Icon button that copies `text` and briefly swaps to a check mark to confirm it worked. */
export function CopyButton({ text, label = "Copy document ID", size = 13, className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function handleClick() {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : "Copy ID"}
      onClick={() => void handleClick()}
      className={`rounded transition-colors hover:bg-surface-muted ${
        copied ? "text-success" : "text-subtle hover:text-primary"
      } ${className}`}
    >
      {copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
    </button>
  );
}
