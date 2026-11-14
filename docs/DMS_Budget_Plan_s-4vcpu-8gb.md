# Edoc — Production Budget Plan (DigitalOcean `s-4vcpu-8gb`)

> **Superseded (2026-11-11).** Image OCR was taken out of Release 1, and the current budget is the *Edoc Production Budget* doc: a 2 vCPU / 4 GB server at about $42/month all-in. This file is kept as the costing **with** OCR, if it's ever turned on.

**Prepared:** 2026-10-17 · **Load:** 1 organization, up to 250 users, ~50 concurrent, files < 100 MB (limit 120 MB)

**Server (chosen):** DigitalOcean Basic Droplet, Regular CPU — 4 vCPU · 8 GB RAM · 160 GB disk · 5 TB bandwidth (`s-4vcpu-8gb`), with OCR (Tesseract) enabled.

> All prices are USD estimates from third-party listings and general knowledge, not the providers' own pages. Confirm on digitalocean.com and cloudflare.com before paying. Document volume is an assumption — the project docs give none.

---

## 1. Monthly budget

| # | Line item | Provider | Small (~50 GB) | **Medium (~300 GB)** | Large (~1.5 TB) |
|---|---|---|---|---|---|
| 1 | Droplet `s-4vcpu-8gb` | DigitalOcean | $48.00 | **$48.00** | $48.00 |
| 2 | Automated Droplet backups (~20%) | DigitalOcean | $9.60 | **$9.60** | $9.60 |
| 3 | File storage (versions included) | Cloudflare R2 ($0.015/GB, no egress fees) | $1.00 | **$5.00** | $25.00 |
| 4 | Database-dump backups (`pg_dump`) | Cloudflare R2 | $1.00 | **$1.00** | $1.00 |
| 5 | DNS, TLS, basic DDoS | Cloudflare Free | $0 | **$0** | $0 |
| 6 | Domain (~$12/yr) | Cloudflare Registrar | $1.00 | **$1.00** | $1.00 |
| 7 | Email (verification, invites, resets) | Brevo free tier | $0 | **$0** | $0 |
| 8 | Error tracking | Sentry free tier | $0 | **$0** | $0 |
| 9 | Uptime monitoring | Uptime Kuma (self-hosted) | $0 | **$0** | $0 |
| 10 | CI/CD | GitHub Actions free tier | $0 | **$0** | $0 |
| | **Subtotal** | | **$60.60** | **$64.60** | **$84.60** |
| | Contingency (15%) | overage, price drift, FX | $9.09 | **$9.69** | $12.69 |
| | **Monthly total** | | **≈ $70** | **≈ $74** | **≈ $97** |
| | **Yearly total** | | **≈ $840** | **≈ $890** | **≈ $1,170** |

R2 scenario assumptions: Small ≈ 5,000 documents, Medium ≈ 30,000, Large ≈ 150,000, at ~1.3–1.5× live size for version history. Operations (uploads/reads) fall inside or near the free tier at this load (≈ $0–2/month).

## 2. Optional add-ons (not in the totals above)

| Item | Monthly | When it's worth it |
|---|---|---|
| Staging Droplet (`s-1vcpu-2gb`, ~$12; or destroy when idle) | $0–12 | Rehearse migrations before production. Recommended. |
| Cloudflare Pro (managed WAF) | ~$25 | App exposed to the open internet with sensitive documents. Skip if internal / VPN-only. |
| Extra block-storage volume | ~$0.10/GB | Only if the 160 GB disk fills (database growth, logs). Unlikely when files are on R2. |
| Penetration test / security review | one-off, quote-based | Before real confidential data goes in. |

## 3. Three-year view (Medium scenario)

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Server + backups | $691 | $691 | $691 |
| R2 (storage grows ~30%/yr) | $72 | $94 | $122 |
| Domain | $12 | $12 | $12 |
| Contingency 15% | $116 | $120 | $124 |
| **Total** | **≈ $890** | **≈ $917** | **≈ $949** |

## 4. Capacity check — is this server the right size?

| Resource | Expected use | Headroom on 4 vCPU / 8 GB |
|---|---|---|
| Postgres | ~1–2 GB | Ample |
| API (Fastify) | ~0.5 GB | Ample |
| Redis + Caddy | ~0.3 GB | Ample |
| OCR worker (Tesseract) | ~0.5–1 GB per job | Room for 2 concurrent jobs without hurting the API |
| OS + page cache | ~1–2 GB | Ample |

The plan sits comfortably above the stated load. Upgrade path if memory stays above 80% or the OCR queue backs up: `s-8vcpu-16gb` (≈ double the Droplet cost).

## 5. Setup requirements that protect the budget

1. Build Docker images in CI, not on the server.
2. Close Postgres (5432) and Redis (6379) to the public network — the dev compose file currently publishes them.
3. Cap OCR worker concurrency at 2.
4. Cloudflare's proxy caps uploads at 100 MB per request on Free/Pro (verify). The app accepts 120 MB — either serve the API hostname DNS-only (free) or lower `MAX_UPLOAD_BYTES`.
5. Set a DigitalOcean billing alert at ~$100/month and a Cloudflare R2 usage alert.

## 6. Decisions still open

- R2 vs NAS for files (NAS removes line 3–4 R2 cost but adds hardware, power and off-site backup).
- Expected year-one document count and average size.
- Public vs internal-only exposure (decides Cloudflare Pro and the proxy question).
- Droplet region (nearest to users).
