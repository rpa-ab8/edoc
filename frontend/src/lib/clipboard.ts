/**
 * Copy text to the clipboard. Resolves true on success.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost), so when the app is
 * opened over plain HTTP on the LAN (e.g. http://192.168.x.x:5173) it is undefined. In that case
 * fall back to the legacy hidden-textarea + execCommand("copy") path, which still works there.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused — try the fallback below.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // Off-screen but still selectable; fixed so the page doesn't scroll to it.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  const previousFocus = document.activeElement as HTMLElement | null;
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length); // iOS Safari ignores select()

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  previousFocus?.focus?.();
  return ok;
}
