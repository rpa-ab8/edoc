# Edoc — Where the documentation and records are kept

Who should keep which file, and where, so the system can be maintained and recovered by people other than the one
who deployed it. Written 2026-11-14, on the day production went live (`https://edoc.abateas.app`).

There are three groups, and they must not be mixed:

1. **Documents for developers.** They live in the GitHub repository.
2. **Copies for the organization.** The same key documents, kept outside GitHub.
3. **Secrets.** Kept in the password manager only. They never go in GitHub, shared folders, email or chat.

---

## 1. For future developers: the GitHub repository (`rpa-ab8/edoc`, private)

Give a new developer access to the repository and point them at these, in this order:

| File | What it gives them |
|---|---|
| `docs/developer/README.md` | The starting point and the reading order for all developer chapters |
| `docs/developer/09_Deployment_and_Operations.md` | How production is built, and what code changes mean for it |
| `docs/developer/11_Backup_and_Restore.md` | The restore runbook for the live system, with real names |
| `docs/DMS_Production_Details.md` | What is live right now, and the full deployment history |
| `docs/DMS_Deployment_Guide.md` | How to build a production server from scratch |
| `docs/DMS_Data_Protection_and_Restore.md` | Why the backups are designed this way, and every restore procedure |
| `deploy/README.md` | Day-to-day operations: updates, rollback, rotating keys |
| `each_update.md` | The chronological log of every change |
| `CLAUDE.md` | The hard rules of the codebase |

These contain no passwords or keys, so anyone with repository access may read them.

## 2. For the organization: a copy outside GitHub

If access to GitHub is ever lost, the company still needs to know how to recover the system. Export these as **PDF**
into a company folder that management can reach (the IT share or the company document system), and refresh the
copies after major changes:

- `docs/DMS_Production_Details.md`
- `docs/developer/11_Backup_and_Restore.md`
- `docs/DMS_Data_Protection_and_Restore.md`
- the budget document, *Edoc Production Budget*

They contain no passwords, so they are safe to share inside the company.

## 3. Secrets: the password manager only

| Item | Where it is kept |
|---|---|
| All production keys, passwords and ping URLs (the admin PC's working copy is the gitignored `PRODUCTION.local.md`) | The company password manager, in a vault named "Edoc production" |
| The whole `~/dms/.env.production` from the server | The same vault |
| The **age private key** (opens the encrypted backups) | The password manager **and** a USB stick kept somewhere safe, away from the office PC. Never on the server. |
| The SSH key used to log in to the server (`~/.ssh/digitalocean` on the admin PC) | The password manager, as a backup copy |
| Account logins: DigitalOcean, Cloudflare, Backblaze, Brevo, Healthchecks.io, GitHub | The password manager |

Rules:

- **At least two trusted people** must have access to that vault, so the company is never locked out because one person is unavailable.
- `PRODUCTION.local.md` is only a working copy on the admin PC. It is listed in `.gitignore`, so it cannot reach GitHub. Don't copy it anywhere else.
- If both copies of the age private key are lost, every off-site backup becomes unreadable. Check once a year that the USB copy still opens. The monthly restore drill uses one copy; alternate between the two.

## 4. Keeping this up to date

- After any change to production (a new release, new keys, a new server or IP), update `docs/DMS_Production_Details.md` and `each_update.md`, and change the secrets in the password manager.
- After each monthly restore drill, record it in `each_update.md` (`docs/developer/11_Backup_and_Restore.md` §4, step 6).
- Re-export the PDFs in §2 when those documents change.
