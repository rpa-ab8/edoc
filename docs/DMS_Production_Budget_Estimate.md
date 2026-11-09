# Edoc — Production Server & Running-Cost Estimate

**Prepared:** 2026-10-17 · **Basis:** the stated load in the PRD / Tech Stack doc — one organization, up to **250 users, ~50 concurrent**, files typically under 100 MB (limit 120 MB).

> **Read this first.** Hetzner repriced its cloud on 15 June 2026 and sources disagree on the exact numbers (see Sources). Every price below is an **estimate to be confirmed on the provider's pricing page** before you commit. Storage volume is an **assumption** — the docs give no document count, so three scenarios are shown.

---

## 1. Server specification

Everything runs on one server via Docker Compose: Caddy (TLS), the Fastify API, the OCR worker, PostgreSQL 16, Redis 7. There is no case for more at this load.

| | Minimum | **Recommended** | Growth headroom |
|---|---|---|---|
| vCPU | 2 | **4** | 8 |
| RAM | 4 GB | **8 GB** | 16 GB |
| Disk | 80 GB NVMe | **160 GB NVMe** | 320 GB NVMe |
| Why | Works, but OCR bursts will slow the API | Postgres + API + OCR comfortably | Many concurrent bulk uploads / OCR backlog |

Notes:
- **Disk holds the database only** if files go to Cloudflare R2. If the NAS is used instead, files live on the NAS and the server disk stays small.
- **OCR (Tesseract) is the CPU spike.** The worker is a separate process; cap its concurrency to 1–2 so uploads never starve the API.
- OS: Ubuntu 24.04 LTS. Public IPv4 required (~€0.50/month on Hetzner).
- Region: nearest to your users. If files go on a **NAS**, the server must sit on the same network, or reach it over a WireGuard tunnel.

## 2. Monthly running costs

### 2.1 Fixed costs (all scenarios)

| Item | Provider (example) | Est. monthly | Notes |
|---|---|---|---|
| App server 4 vCPU / 8 GB / 160 GB | DigitalOcean Droplet (see 2.1a for AWS) | **≈ $48** | Hetzner dropped: it repriced in June 2026 and is no longer the choice. |
| Server snapshots / backups | DigitalOcean Backups | ~20% ≈ $10 | Optional if you rely on `pg_dump` to R2 alone. Recommended for fast whole-server restore. |
| Cloudflare plan (DNS, proxy, TLS) | Cloudflare **Free** | **$0** | See the upload-size warning in §3. |
| Transactional email | Brevo free tier | $0 | Code uses Brevo (the Tech Stack doc says Resend — the code governs). 300 emails/day is ample for 250 users. |
| Error tracking | Sentry free tier | $0 | 5,000 errors/month. |
| Uptime monitoring | Uptime Kuma (self-hosted) | $0 | Runs on the same server. |
| CI/CD | GitHub Actions free tier | $0 | 2,000 minutes/month on private repos. |
| TLS certificate | Let's Encrypt via Caddy | $0 | |
| **Fixed subtotal** | | **≈ $50–60/month** | |

### 2.1a Provider choice — DigitalOcean vs AWS (Hetzner ruled out)

| Option | Spec | Est. monthly | Notes |
|---|---|---|---|
| **DigitalOcean Droplet (recommended)** | 4 vCPU / 8 GB / 160 GB SSD / 5 TB transfer | **≈ $48** (+ ~$10 for 20% automated backups) | Flat price, IPv4 included, no surprise bills. Premium Intel/AMD variants are ~$56. |
| AWS Lightsail | 8 GB bundle | **≈ $44 (2 vCPU) to $168 (4 vCPU)** — sources conflict | Plan tables on AWS's regional pages disagree; check the US pricing page. Not cheaper for 4 vCPU. |
| AWS EC2 `t4g.large` (2 vCPU / 8 GB, ARM) | 2 vCPU / 8 GB | **≈ $49** US-East, **≈ $33** Mumbai (`ap-south-1`) | Compute only: add EBS disk (100 GB gp3 ≈ $8), public IPv4 (≈ $3.65) and snapshots. Needs ARM-compatible images (fine for this stack). |
| AWS EC2 `t4g.xlarge` (4 vCPU / 16 GB, ARM) | 4 vCPU / 16 GB | ≈ $98 US-East | The AWS equivalent of the recommended spec — roughly double DigitalOcean. |
| AWS EC2 `t3.large` (x86) | 2 vCPU / 8 GB | ≈ $61 US-East | Dearer than the ARM `t4g`. |

**Verdict:** DigitalOcean at ≈ $48 is the cheapest option that actually meets the 4 vCPU / 8 GB spec. AWS only wins on price if you accept 2 vCPU (`t4g.large` in Mumbai, ≈ $33 + ~$12 for disk/IP/snapshots ≈ $45) — workable for 50 concurrent users, but OCR bursts will compete with the API for two cores. AWS also bills egress, EBS, IPv4 and snapshots separately, so its real bill drifts above the headline; DigitalOcean's does not. Prices are from third-party aggregators, not the providers' own pages — confirm before buying.

The totals in §4 are recalculated with DigitalOcean.

### 2.2 Cloudflare R2 (file storage) — scales with volume

R2 rates: **$0.015 per GB-month**, Class A (writes/lists) $4.50 per million, Class B (reads) $0.36 per million, **egress free**. Free tier: 10 GB, 1M Class A, 10M Class B per month.

Version history keeps every version as a separate file, so budget storage at roughly 1.3–1.5× the live document size.

| Scenario | Documents | Stored (incl. versions) | Storage | Operations | **R2 monthly** |
|---|---|---|---|---|---|
| Small | ~5,000 | ~50 GB | $0.60 | ~$0 (inside free tier) | **≈ $1** |
| Medium | ~30,000 | ~300 GB | $4.35 | ~$0.50 | **≈ $5** |
| Large | ~150,000 | ~1.5 TB | $22.35 | ~$2 | **≈ $25** |

Add ~$1/month for `pg_dump` backups kept in a second R2 bucket (database dumps are small).

**If the NAS is chosen instead of R2:** R2 cost is $0, but you own the hardware, power, disk replacement and an off-site backup of the NAS itself. Budget that separately.

### 2.3 Domain

~$10–15 per year (≈ $1/month). Cloudflare Registrar sells at wholesale cost, so it's a reasonable place to buy it.

## 3. Cloudflare — two things to decide before launch

1. **Upload size limit.** Traffic that passes through Cloudflare's proxy (the orange cloud) is capped at **100 MB per request on Free and Pro plans** (200 MB on Business). The app accepts uploads up to **120 MB**. Options:
   - Set the API hostname to **DNS-only** (grey cloud) so uploads go straight to your server — free, and Caddy still handles TLS. You lose Cloudflare's proxy/WAF for that hostname.
   - Or lower `MAX_UPLOAD_BYTES` to under 100 MB (the PRD target is "typically under 100 MB").
   - Or pay for Business (~$200/month) — not justified here.
   - Confirm the current limit on Cloudflare's docs before deciding.
2. **Paid plan is optional.** Free covers DNS, TLS and basic DDoS protection. Pro (~$25/month) adds a managed WAF; worth it only if the system is exposed to the open internet and handles sensitive documents. Put this in the budget as an optional line.

## 4. Totals

| | Lean | **Recommended** | With extras |
|---|---|---|---|
| Server (DigitalOcean 4 vCPU / 8 GB) | $48 | $48 | $48 |
| Backups / snapshots | — | $10 | $10 |
| R2 storage (scenario) | $1 (small) | $5 (medium) | $25 (large) |
| Cloudflare plan | $0 | $0 | $25 (Pro WAF) |
| Domain | $1 | $1 | $1 |
| Email / Sentry / CI / monitoring | $0 | $0 | $0 |
| **Monthly total** | **≈ $50** | **≈ $64** | **≈ $109** |
| **Yearly** | ≈ $600 | ≈ $770 | ≈ $1,300 |

If you choose AWS `t4g.large` in Mumbai instead (2 vCPU), the recommended total drops to roughly $55–60/month.

## 5. One-off and optional costs

| Item | Est. cost | Notes |
|---|---|---|
| Staging server (smaller, run on demand) | $0–15/month | Strongly advised so migrations are rehearsed before production. Can be a 2 vCPU / 4 GB box, or turned off when idle. |
| Paid Sentry / log service | $0 now | Free tiers suffice at this scale. |
| Security review / penetration test | quote-based | Worth doing before real confidential data goes in. |
| Engineering time for Module 14 (Dockerfiles, proxy, backups, CI, member-login browser pass) | internal | Not a cash cost, but it is the actual remaining work. |

## 6. What drives the cost up

- **Document volume** is the only line that really scales (R2 storage). Everything else is flat until concurrency grows well beyond 50.
- **OCR backlog** after a large bulk import will pin the CPU; upgrade the server one tier (8 vCPU / 16 GB, ≈ double) if migrating a big archive.
- **Search and Postgres** are fine at this scale; no extra service needed until document count grows roughly tenfold.

## 7. Assumptions to confirm

1. Storage backend: **R2 or NAS**? (Changes §2.2 completely.)
2. Expected document count and average size in year one.
3. Hosting location / provider preference (Hetzner is cheapest, but the June 2026 repricing narrowed the gap).
4. Whether the app is exposed publicly or only on a company network/VPN. An internal-only deployment can skip the Cloudflare proxy and WAF entirely.
5. Backup retention period (affects snapshot and R2 backup cost slightly).

## Sources

- Hetzner June 2026 repricing: [Hetzner's 2026 Price Increase](https://findstack.com/resources/hetzner-price-increase-2026), [Hetzner Repriced Its Cloud Today](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do), [Hetzner Cloud cost-optimized plans](https://www.bitdoze.com/md/hetzner-cloud-cost-optimized-plans.md). The sources give €35.49 and €35.99 for the 4 vCPU / 8 GB plan; not confirmed on Hetzner's own page.
- Cloudflare R2: [official pricing](https://developers.cloudflare.com/r2/pricing).
- Cloudflare proxy upload limit and DigitalOcean/other-provider prices are from general knowledge, **not** verified in this session — check before relying on them.
