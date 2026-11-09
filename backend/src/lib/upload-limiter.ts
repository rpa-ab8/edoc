/**
 * Caps how many uploads this API process holds in memory at once (SECURITY_AUDIT.md M-5).
 *
 * An upload is buffered whole (up to MAX_UPLOAD_BYTES, 120 MB) before it is hashed for duplicate
 * detection and stored, so concurrency is memory: ~50 simultaneous uploads could exhaust an 8 GB
 * host. This bounds the worst case at MAX_CONCURRENT_UPLOADS × MAX_UPLOAD_BYTES, and stops one
 * account from taking every slot. The web client uploads a batch one file at a time, so a normal
 * user never meets the per-user cap.
 *
 * Per process, in memory: correct for the single API container this deployment runs. Several API
 * replicas would each get their own budget (still bounded per host), which is the right unit anyway.
 */
export class UploadLimiter {
  private total = 0;
  private perUser = new Map<string, number>();

  constructor(
    private maxTotal: number,
    private maxPerUser: number,
  ) {}

  /** Takes a slot, or returns why not. The returned release must be called exactly once. */
  tryAcquire(userId: string): { ok: true; release: () => void } | { ok: false; reason: "server_busy" | "user_busy" } {
    const mine = this.perUser.get(userId) ?? 0;
    if (mine >= this.maxPerUser) return { ok: false, reason: "user_busy" };
    if (this.total >= this.maxTotal) return { ok: false, reason: "server_busy" };
    this.total++;
    this.perUser.set(userId, mine + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total--;
        const left = (this.perUser.get(userId) ?? 1) - 1;
        if (left <= 0) this.perUser.delete(userId);
        else this.perUser.set(userId, left);
      },
    };
  }
}
