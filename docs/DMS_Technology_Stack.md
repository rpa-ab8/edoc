# Edoc — Technology Stack

**Status:** Recommendation for review
**Context:** Internal company product for now (one organization, up to 250 users, ~50 concurrent). Architecture remains the multi-organization design already specified — this stack simply avoids paying for scale, tooling, or managed services the project doesn't need yet.
**Companion documents:** *Edoc Product Requirements Document*, *Edoc Data Model*, *Edoc Scope & MVP Definition*

---

## 1. Guiding principle

At this scale, the biggest cost risk isn't infrastructure — it's **paying subscription/managed-service prices for problems a single well-configured server solves for free.** The approach throughout: self-host what would otherwise be a recurring bill, use generous free tiers for genuinely low-volume needs (email, CI), and defer anything (Kubernetes, a dedicated search cluster, an enterprise auth provider) that only earns its cost at a scale this deployment isn't at.

Nothing here blocks the multi-organization future already designed — it's the same architecture, run on inexpensive infrastructure rather than expensive infrastructure.

---

## 2. A note on hosting and storage

**This decision depends on which storage backend an organization chooses**, because the backend server needs actual network access to wherever documents live.

- **NAS (on-premise):** the backend must reach the NAS over SMB/NFS. Practically, this means either running the backend on infrastructure inside the same network as the NAS, or on a VPS connected to that network by a VPN/tunnel. A NAS reachable only from inside an office network cannot be reached by a backend sitting in an arbitrary cloud region without that tunnel.
- **Cloudflare R2 (cloud):** no such constraint — the backend can run anywhere with internet access.

**For an internal deployment using NAS, the simplest and cheapest option is running the whole application on your own server, on the same network as the NAS.** If R2 is chosen instead, a low-cost VPS is simpler and equally cheap. Both are covered below.

---

## 3. Stack by layer

### 3.1 Frontend

| Component | Choice | Reasoning |
|---|---|---|
| Framework | React + TypeScript | Matches the mockups already designed; large ecosystem, no license cost |
| Build tool | Vite | Fast builds, ships as static files — no server-side rendering infrastructure needed |
| Styling | Tailwind CSS | Matches the design system used throughout this project's mockups |
| State/data | TanStack Query (React Query) + Zustand | Query handles server data and caching; Zustand for light local UI state — both free, minimal boilerplate |
| Component primitives | Radix UI or shadcn/ui | Accessible, unstyled primitives — avoids a paid component library |

**Cost:** $0. The built app is static files served by the same server as the backend (Section 5) — no separate hosting bill.

### 3.2 Backend

| Component | Choice | Reasoning |
|---|---|---|
| Runtime | Node.js + TypeScript | One language across frontend and backend — smaller team, shared types |
| Framework | Fastify | Lightweight and fast; the domain complexity here (permissions, schema) lives in application code, not the framework — a heavier framework like NestJS adds structure this scale doesn't need |
| Validation | Zod | Type-safe request/response validation, shared schema types with the frontend |
| ORM | Prisma | Matches the relational data model directly (Section on Data Model); generates TypeScript types from the schema, migrations included |

**Cost:** $0 — all open source.

### 3.3 Database

| Component | Choice | Reasoning |
|---|---|---|
| Primary database | PostgreSQL | Matches the ERD exactly (organizations, memberships, folders, documents, versions); JSONB columns fit the permission matrix cleanly |
| Search | PostgreSQL full-text search (`tsvector`) | At this scale (a few thousand documents, ~50 concurrent users), Postgres's built-in full-text search is sufficient for both metadata and OCR-text search — **a dedicated search engine (Elasticsearch/Meilisearch) would be a real recurring cost for no real benefit yet.** Revisit only if search volume or document count grows an order of magnitude. |
| Cache / queue backing | Redis | Backs the job queue (below) and can double as a rate-limit store for login attempts |

**Cost:** $0 in software. Runs as a container alongside the backend (Section 5).

### 3.4 File storage

Already decided in the product design — included here for completeness.

| Option | Cost characteristics |
|---|---|
| NAS (on-premise) | Zero marginal storage cost — uses hardware you already own |
| Cloudflare R2 | ~$0.015/GB-month stored, **zero egress fees** — the cheapest cloud object storage available; a meaningful saving over S3, whose egress charges are the usual surprise cost in a document-heavy app |

### 3.5 OCR

| Component | Choice | Reasoning |
|---|---|---|
| Engine | Tesseract (open source, self-hosted) | Cloud OCR services (AWS Textract, Google Vision) charge per page — at meaningful document volumes this becomes a real recurring cost. Tesseract is free and runs on the same server, at the cost of somewhat lower accuracy on poor scans than the paid cloud options. |

> **Production decision (2026-11-11):** image OCR (Tesseract on JPG/PNG) is built but switched **off** in production (`OCR_IMAGES_ENABLED=false`), so the server can be 2 vCPU / 4 GB (budget ≈ $42/month). PDF embedded text, Markdown and plain text stay content-searchable; images are searchable by name, document ID and metadata only. Turning it on later = resize the server + one setting.

**Recommendation:** start with Tesseract; if OCR accuracy on real documents proves inadequate for a specific department (common with poor-quality scans), revisit a paid API for that case specifically rather than by default.

### 3.6 Background jobs

| Component | Choice | Reasoning |
|---|---|---|
| Queue | BullMQ (Redis-backed) | Handles OCR processing, email sending and any future async work (exports, notifications in R2) without blocking requests |

**Cost:** $0 — uses the same Redis instance as caching.

### 3.7 Authentication

Already decided in the product design (JWT + server-side refresh tokens, self-hosted) — included here for completeness.

| Component | Choice | Reasoning |
|---|---|---|
| Tokens | `jsonwebtoken` (Node) | Standard, well-audited library |
| Password hashing | `argon2` | Stronger than bcrypt at equivalent cost, no license |
| Rate limiting | Redis-backed counter | Avoids a paid rate-limiting service for login protection |

**Cost:** $0. Consistent with the earlier decision to avoid a managed auth provider (Auth0/Clerk) since on-premise NAS clients expect identities kept in-house.

### 3.8 Email

| Component | Choice | Reasoning |
|---|---|---|
| Transactional email | Resend (or equivalent: Postmark, SES) | Verification, invites and password resets are low-volume for 250 users — comfortably within a free or near-free tier (Resend: 3,000 emails/month free) |

**Cost:** $0 at this volume.

### 3.9 Hosting and infrastructure

**Recommended: a single VPS running everything via Docker Compose.** At 250 users / ~50 concurrent, one well-specified server comfortably handles the backend, database, Redis, and OCR processing — there is no case for Kubernetes or multi-node infrastructure at this scale, and introducing it would only add cost and operational complexity.

| Component | Choice | Reasoning |
|---|---|---|
| Server | A single VPS (DigitalOcean) — **2 vCPU / 4 GB (`s-2vcpu-4gb`) with image OCR off** (decision 2026-11-11); 4 vCPU / 8 GB only if image OCR is enabled | Sized comfortably above the stated load; Hetzner in particular offers strong price-to-performance for this tier |
| Orchestration | Docker Compose | One file defining backend, Postgres, Redis, and a reverse proxy — simple to operate without container-orchestration overhead |
| Reverse proxy / TLS | Caddy or Nginx + Let's Encrypt | Free automatic HTTPS |
| Static frontend | Served by the same reverse proxy | No separate frontend hosting bill |

**If storage is NAS:** run this server on the same network as the NAS (on-premise, or a VPS joined to the network by a WireGuard tunnel).
**If storage is R2:** any VPS region works; no tunnel needed.

**Estimated infrastructure cost at this scale: roughly $20–40/month** for the VPS, plus R2 storage costs (a few dollars/month for typical document volumes) if that backend is chosen. NAS storage has no marginal cost beyond hardware already owned.

### 3.10 Monitoring and operations

| Component | Choice | Reasoning |
|---|---|---|
| Uptime monitoring | Uptime Kuma (self-hosted) | Free, simple, sufficient for one internal deployment |
| Error tracking | Sentry free tier | 5,000 errors/month free — enough for this scale |
| Logs | Container logs + basic log rotation | A dedicated log-aggregation service (Datadog, etc.) is not justified at this scale |
| Backups | Nightly verified, `age`-encrypted `pg_dump` to a second provider (Backblaze B2, no-delete key); a daily off-DB manifest (storage key → document/file/folder) and checksum scrub (`data-guard`); a nightly `rclone` replica of the R2 documents bucket to B2 (deletions kept 90 days); Healthchecks.io dead-man's-switch alerts | The database is the only map from opaque storage keys to documents, so neither half is useful alone. Every off-site copy is at a different provider, and can't be erased from the server. Full design: `docs/DMS_Data_Protection_and_Restore.md` |

### 3.11 CI/CD

| Component | Choice | Reasoning |
|---|---|---|
| Pipeline | GitHub Actions | Free tier (2,000 minutes/month) comfortably covers build, test and deploy for a project this size |
| Deployment | SSH deploy or a simple Docker-image push to the VPS | No need for a managed deployment platform |

---

## 4. What's deliberately not in this stack (yet)

| Considered | Deferred because |
|---|---|
| Kubernetes | Operational overhead unjustified below thousands of concurrent users |
| Managed search (Elasticsearch, Algolia, Meilisearch Cloud) | Postgres full-text search covers this scale; revisit if document volume grows an order of magnitude |
| Managed auth (Auth0, Clerk) | Recurring per-user cost, and inconsistent with on-premise NAS clients wanting identities in-house |
| Cloud OCR (Textract, Google Vision) | Per-page cost; Tesseract is free and adequate to start |
| Multi-region / multi-node hosting | Unjustified for one internal organization; the architecture (Section 10 of the Data Model) already supports scaling out later without a rewrite |
| A dedicated DevOps platform (managed Kubernetes, etc.) | Same reasoning as above — one VPS is sufficient and far cheaper to operate |

None of these are ruled out permanently — they're the natural upgrades if and when the product moves beyond internal use into the multi-organization SaaS product the architecture was already built for.

---

## 5. Estimated monthly cost at this scale

| Item | Approximate cost |
|---|---|
| VPS (backend, DB, Redis, OCR, reverse proxy) | $20–40/month |
| Cloudflare R2 storage (if chosen) | A few dollars/month at typical document volumes (no egress fees) |
| Transactional email | $0 (free tier) |
| Error tracking / uptime monitoring | $0 (free tiers) |
| CI/CD | $0 (free tier) |
| Domain + TLS | ~$10–15/year domain; TLS free via Let's Encrypt |
| **Total** | **Roughly $20–45/month**, plus a nominal annual domain fee |

This is deliberately close to the minimum viable cost for a production system serving 250 users — the trade-off is that the team operates the server themselves rather than paying a managed-service premium for convenience they don't yet need.

---

## 6. Migration path when it's no longer "internal only"

Because the architecture (multi-organization, tenant isolation, storage abstraction) was designed for this from the start, moving beyond internal use later is a matter of **adding infrastructure, not rebuilding software**:

- Single VPS → multiple app servers behind a load balancer, when concurrent load requires it.
- Postgres full-text search → a dedicated search engine, if search volume outgrows it.
- Self-hosted email → a higher email-volume plan.
- Tesseract → a paid OCR API for specific high-accuracy needs, if required.

No component in this stack is a dead end; each has a known, well-trodden upgrade path.
