# DMS — Production Deployment Guide (step by step)

This guide takes you from nothing to a live, secured DMS at `https://<your-domain>`, one step at a time. Follow it in order and don't skip steps. Each step says **where** you type things (your Windows PC, the server, or a website) and **what you should see** when it worked.

- **Total time:** about 2–3 hours the first time, plus waiting for DNS. Most of that is account setup.
- **Server:** DigitalOcean `s-4vcpu-8gb` (see `docs/DMS_Budget_Plan_s-4vcpu-8gb.md`).
- **Day-to-day operations after go-live** (updates, rollback, restore, rotating secrets): `deploy/README.md`.

> **Conventions used below**
> - `dms.abateas.com` is the example domain. Replace it with yours everywhere.
> - `203.0.113.10` is the example server IP. Replace it with your droplet's IP.
> - `<your-github-account>` is your GitHub user or organization name.
> - 🖥️ **Windows** = PowerShell on your PC · 🐧 **Server** = the SSH session on the droplet · 🌐 **Browser** = a website.
> - In a terminal, **paste** with right-click (Windows Terminal/PowerShell) or `Ctrl+Shift+V` (Linux terminals).

---

## Part 0 — Before you start

### 0.1 What you need

| # | Item | Why | Cost |
|---|---|---|---|
| 1 | A **DigitalOcean** account with a payment method | The server | ≈ $48/month + backups |
| 2 | A **domain** you control, with DNS in **Cloudflare** | The address people type | ≈ $10–15/year |
| 3 | A **Cloudflare** account (same as #2) with **R2** enabled | Document storage + database backups | ≈ $1–25/month by volume |
| 4 | A **Brevo** account | Verification, invitation and password-reset emails | Free tier |
| 5 | A **GitHub** account | To get the code onto the server (and run CI) | Free |
| 6 | A **password manager** (Bitwarden, 1Password, KeePass…) | To store the secrets you'll generate | — |

### 0.2 Golden rules

1. **Never reuse anything from development.** Use new R2 buckets, new API keys, new passwords and a new database. The dev test scripts write to and delete from the dev bucket.
2. **Never copy your local `.env` file to the server.** You'll create a fresh `.env.production` on the server in Part 6.
3. **Every secret you generate goes into the password manager immediately.** If `STORAGE_CREDENTIALS_KEY` is lost, the storage connection has to be re-entered.

### 0.3 A worksheet to keep open

Copy this into a note and fill it in as you go. It holds **no secrets**; those go in the password manager.

```
Domain ............................ dms.abateas.com
Droplet IP ........................
Droplet name ...................... dms-prod-1
GitHub repo ....................... github.com/<your-github-account>/dms
Cloudflare account ID .............
R2 documents bucket ............... dms-documents
R2 backups bucket ................. dms-backups
Brevo sender ...................... noreply@abateas.com
First Super Admin email ...........
Release tag deployed .............. v1.0.0
```

---

## Part 1 — Put the code on GitHub (🖥️ Windows, ~10 min)

The server downloads the code from a **private** GitHub repository.

### 1.1 Check that no secrets are committed

🖥️ Open PowerShell and run:

```powershell
cd C:\apps\DMS
git status
git ls-files | Select-String -Pattern "\.env"
```

✅ **Expected:** the second command lists **only** `.env.example` and `.env.production.example`. If you see `.env` or `.env.production`, **stop** and remove it from git before continuing.

### 1.2 Create the repository

🌐 On github.com: **+** (top right) → **New repository**
- **Repository name:** `dms`
- **Visibility:** **Private** ← important
- Do **not** tick "Add a README", ".gitignore" or "license" (the repo already has them)
- Click **Create repository**

### 1.3 Push the code

🖥️ PowerShell:

```powershell
cd C:\apps\DMS
git remote add origin https://github.com/<your-github-account>/dms.git
git push -u origin master
```

The first push opens a browser window asking you to sign in to GitHub. Approve it.

✅ **Expected:** refresh the GitHub page and the files are there. A **CI** run starts under the **Actions** tab. It isn't required for deployment, but it should go green.

### 1.4 Tag the release you're about to deploy

🖥️ PowerShell:

```powershell
git tag -a v1.0.0 -m "First production release"
git push origin v1.0.0
```

A tag is a permanent name for this exact version, so you can always return to it.

---

## Part 2 — Create the server (🌐 DigitalOcean, ~15 min)

### 2.1 Create an SSH key on your PC (skip if you already have one)

🖥️ PowerShell:

```powershell
ssh-keygen -t ed25519 -C "your-name@abateas.com"
```

- Press **Enter** to accept the default location.
- Enter a **passphrase** (recommended) and type it twice.

Show the **public** key so you can copy it:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

Copy the whole line that starts with `ssh-ed25519`. This is the **public** half and is safe to share. **Never** share the file without `.pub` (`id_ed25519`).

### 2.2 Create the droplet

🌐 DigitalOcean → **Create** → **Droplets**:

| Setting | Choose |
|---|---|
| **Region** | Nearest to your users (for India: **Bangalore BLR1**) |
| **Image** | **Ubuntu 24.04 (LTS) x64** |
| **Size** | **Basic** → **Regular** → **$48/mo: 4 vCPU / 8 GB / 160 GB SSD** (`s-4vcpu-8gb`) |
| **Backups** | **Enable**, weekly is fine (≈ 20% extra) |
| **Authentication** | **SSH Key** → **New SSH Key** → paste the line from 2.1 → name it `my-pc` |
| **Advanced → Monitoring** | Tick **improved metrics monitoring and alerting** (free) |
| **Hostname** | `dms-prod-1` |

Click **Create Droplet**. After about a minute it shows an **IPv4 address**. Write it in the worksheet.

### 2.3 Create the firewall

The firewall lives **outside** the server, so nothing running on the server can accidentally open a port.

🌐 DigitalOcean → **Networking** → **Firewalls** → **Create Firewall**
- **Name:** `dms-prod`
- **Inbound rules.** Delete the defaults, then add exactly these:

| Type | Protocol | Port | Sources |
|---|---|---|---|
| SSH | TCP | 22 | **Your office/home public IP only**: search "what is my IP" and enter it |
| HTTP | TCP | 80 | All IPv4, All IPv6 |
| HTTPS | TCP | 443 | All IPv4, All IPv6 |
| Custom | **UDP** | 443 | All IPv4, All IPv6 (HTTP/3) |

- **Outbound rules:** leave the defaults (all allowed). The server needs to reach R2, Brevo, Let's Encrypt and Docker Hub.
- **Apply to Droplets:** select `dms-prod-1` → **Create Firewall**.

> If your office IP changes later, SSH will stop connecting. Edit the SSH rule to the new IP. If you're ever locked out, use **Droplet → Access → Launch Droplet Console** in DigitalOcean, which works without SSH.

> Don't rely on Ubuntu's `ufw` firewall for this. Docker bypasses it for published ports. The DigitalOcean firewall above is the one that counts.

### 2.4 Turn on alerts

🌐 DigitalOcean → **Monitoring** → **Create alert policy**. Create three alerts for `dms-prod-1` that email you:
- CPU above **85%** for 10 minutes
- Memory above **85%** for 10 minutes
- Disk usage above **80%**

🌐 **Billing → Billing alerts:** set an alert at **$100**.

---

## Part 3 — Secure the server (🐧 Server, ~15 min)

### 3.1 First login

🖥️ PowerShell:

```powershell
ssh root@203.0.113.10
```

- The first time, it asks `Are you sure you want to continue connecting (yes/no)?`. Type `yes` and press Enter.
- Enter your SSH key passphrase if you set one.

✅ **Expected:** a prompt like `root@dms-prod-1:~#`

### 3.2 Update the system

🐧 Server:

```bash
apt update && apt upgrade -y
```

If a purple screen asks which services to restart, accept the defaults and press Enter. Then:

```bash
[ -f /var/run/reboot-required ] && reboot
```

If it rebooted, wait 30 seconds and log in again (`ssh root@203.0.113.10`).

### 3.3 Create your own admin user

Working as `root` all the time is risky. Create a user called `deploy`:

🐧 Server (as root):

```bash
adduser deploy
```

Set a strong password and store it in the password manager. You only need it for `sudo`. Press Enter through the name/phone questions, then type `Y`.

```bash
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

The second line copies your SSH key so you can log in as `deploy`.

### 3.4 Test the new user before locking anything down

**Keep the root window open.** Open a **second** PowerShell window:

```powershell
ssh deploy@203.0.113.10
```

✅ **Expected:** prompt `deploy@dms-prod-1:~$`. Then check that sudo works:

```bash
sudo whoami
```

Enter the `deploy` password. ✅ **Expected:** it prints `root`.

**Don't continue until this works.**

### 3.5 Disable root login and password login over SSH

🐧 Server (in the `deploy` window):

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl restart ssh
sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication'
```

✅ **Expected:** `permitrootlogin no` and `passwordauthentication no`.

> The file is named `00-…` on purpose. SSH uses the **first** value it reads, and files load in alphabetical order, so this one wins over DigitalOcean's own `50-cloud-init.conf`.

Now open a **third** PowerShell window and confirm `ssh deploy@203.0.113.10` still works. After that you can close the root window. **From now on, always log in as `deploy`.**

### 3.6 Add swap (a safety net for memory)

🐧 Server:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

✅ **Expected:** the `Swap:` line shows `2.0Gi`.

### 3.7 Confirm automatic security updates are on

🐧 Server:

```bash
systemctl is-enabled unattended-upgrades
```

✅ **Expected:** `enabled`. If not: `sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades` and choose **Yes**.

Leave the server's timezone as **UTC**. Backup times and logs use UTC.

---

## Part 4 — Install Docker (🐧 Server, ~5 min)

🐧 Server:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker deploy
```

**Log out and back in** so the group change takes effect:

```bash
exit
```

🖥️ `ssh deploy@203.0.113.10`, then 🐧:

```bash
docker run --rm hello-world
docker compose version
sudo systemctl is-enabled docker
```

✅ **Expected:** "Hello from Docker!", a version like `Docker Compose version v2.x`, and `enabled`, so Docker starts automatically after a reboot.

---

## Part 5 — Accounts: domain, email, storage (🌐 ~30–60 min, mostly waiting)

You can do 5.1–5.3 in any order while DNS propagates.

### 5.1 Point the domain at the server

🌐 Cloudflare → your domain (`abateas.com`) → **DNS** → **Records** → **Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `dms` |
| IPv4 address | your droplet IP |
| Proxy status | **DNS only** (grey cloud), recommended |
| TTL | Auto |

→ **Save**.

> **Why grey cloud?** The app accepts uploads up to 120 MB. Cloudflare's proxy (orange cloud) caps uploads at 100 MB on the Free and Pro plans, and needs extra settings (`deploy/README.md` §2). Grey cloud means Caddy talks to browsers directly and gets its own free HTTPS certificate.

🖥️ Check it (may take 1–10 minutes):

```powershell
nslookup dms.abateas.com 1.1.1.1
```

✅ **Expected:** the answer shows your droplet IP.

### 5.2 Email — Brevo

The app sends verification, invitation and password-reset emails through Brevo. The sender domain **must be authenticated**, or messages fail or land in spam.

🌐 Brevo:

1. **Authenticate the domain.** Profile menu (top right) → **Senders, Domains & Dedicated IPs** → **Domains** → **Add a domain** → `abateas.com`. Choose to configure DNS manually.
2. Brevo shows several DNS records: a Brevo-code TXT record, DKIM and DMARC. For **each one**, 🌐 Cloudflare → DNS → **Add record** with exactly the type, name and value Brevo shows. Set **Proxy status: DNS only** where offered.
3. Back in Brevo, click **Authenticate this email domain**. It can take a few minutes to go green.
4. **Add the sender.** **Senders** → **Add sender** → Name `DMS`, email `noreply@abateas.com`.
5. **Create an API key.** Profile menu → **SMTP & API** → **API Keys** → **Generate a new API key** → name `dms-production`.
   **Copy it into the password manager now**, because Brevo only shows it once. Make a new key; don't reuse the development one.

### 5.3 Storage — two Cloudflare R2 buckets

🌐 Cloudflare → **R2 Object Storage**. If R2 isn't enabled yet, follow its one-time setup.

1. **Find your Account ID.** It's on the R2 overview page (right side). Write it in the worksheet.
   Your S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
2. **Documents bucket:** **Create bucket** → name `dms-documents` → location **Automatic** → **Create**.
3. **Backups bucket:** **Create bucket** → name `dms-backups` → **Create**.
4. **Auto-delete old backups:** open `dms-backups` → **Settings** → **Object lifecycle rules** → **Add rule** → name `expire-old-dumps` → apply to all objects → **delete objects after 60 days** → **Save**.
5. **API token for documents:** R2 overview → **Manage R2 API Tokens** (or **API → Manage API tokens**) → **Create API token**:
   - Name `dms-documents-prod`
   - Permissions **Object Read & Write**
   - **Specify bucket(s)** → `dms-documents` only
   - **Create**, then copy the **Access Key ID** and **Secret Access Key** into the password manager (the secret is shown once).
6. **API token for backups:** same again, named `dms-backups-prod`, scoped to `dms-backups` only. Save both values.

> Two separate tokens means a leaked backup key can't touch documents, and the reverse.

---

## Part 6 — Get the code and configure it (🐧 Server, ~20 min)

### 6.1 Give the server read-only access to the repository

🐧 Server:

```bash
ssh-keygen -t ed25519 -C "dms-prod-1 deploy key" -f ~/.ssh/github_dms -N ""
cat ~/.ssh/github_dms.pub
```

Copy the printed line.

🌐 GitHub → your `dms` repository → **Settings** → **Deploy keys** → **Add deploy key**:
- **Title:** `dms-prod-1`
- **Key:** paste the line
- **Allow write access:** leave **unticked** (the server only ever reads)
- **Add key**

🐧 Server:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_dms
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com
```

Type `yes` when asked about the host. ✅ **Expected:** `Hi <your-github-account>/dms! You've successfully authenticated, but GitHub does not provide shell access.` This message means it worked.

### 6.2 Download the code

🐧 Server:

```bash
git clone git@github.com:<your-github-account>/dms.git ~/dms
cd ~/dms
git checkout v1.0.0
```

The checkout prints a note about "detached HEAD". That's normal: you're on the exact tagged release.

### 6.3 Create a short command alias

All management commands are long, so define `dc` once:

🐧 Server:

```bash
echo "alias dc='docker compose --project-directory ~/dms -f ~/dms/docker-compose.prod.yml --env-file ~/dms/.env.production'" >> ~/.bashrc
source ~/.bashrc
```

From now on, `dc <something>` runs Docker Compose for the DMS, from any folder.

### 6.4 Create the production settings file

🐧 Server:

```bash
cd ~/dms
cp .env.production.example .env.production
chmod 600 .env.production
```

**Fill in the four secrets automatically.** This generates strong random values and writes them into the file:

```bash
cd ~/dms
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env.production
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 32)|" .env.production
sed -i "s|^STORAGE_CREDENTIALS_KEY=.*|STORAGE_CREDENTIALS_KEY=$(openssl rand -base64 32)|" .env.production
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -hex 48)|" .env.production
grep -E '^(POSTGRES_PASSWORD|REDIS_PASSWORD|STORAGE_CREDENTIALS_KEY|JWT_ACCESS_SECRET)=' .env.production
```

✅ **Expected:** four lines, each with a long random value. **Copy all four into the password manager now.** `STORAGE_CREDENTIALS_KEY` matters most.

**Edit the rest by hand:**

```bash
nano .env.production
```

*nano basics: arrow keys move, type to edit, **Ctrl+O** then **Enter** saves, **Ctrl+X** exits.*

Change these lines and leave everything else as it is:

| Line | Set to | Notes |
|---|---|---|
| `SITE_ADDRESS=` | `dms.abateas.com` | Domain only, **no** `https://` |
| `ACME_EMAIL=` | `it@abateas.com` | Let's Encrypt sends certificate warnings here |
| `TRUSTED_PROXIES=` | leave `127.0.0.1/32` | Correct for grey cloud |
| `CORS_ORIGIN=` | `https://dms.abateas.com` | With `https://` |
| `FRONTEND_URL=` | `https://dms.abateas.com` | Used in email links |
| `BREVO_API_KEY=` | the key from 5.2 | |
| `EMAIL_FROM=` | `noreply@abateas.com` | Must be the Brevo sender from 5.2 |
| `EMAIL_FROM_NAME=` | `Abate DMS` (or similar) | Shown as the sender name |
| `BACKUP_S3_BUCKET=` | `dms-backups` | |
| `BACKUP_S3_ENDPOINT=` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | Your real Account ID |
| `BACKUP_S3_ACCESS_KEY_ID=` | from the **backups** token (5.3 step 6) | |
| `BACKUP_S3_SECRET_ACCESS_KEY=` | from the **backups** token | |

Don't put the **documents** bucket keys here. You'll enter those in the app (Part 8), where they're stored encrypted.

**Check for anything left empty:**

```bash
grep -nE '^[A-Z_]+=$' .env.production
```

✅ **Expected:** no output. If a line is listed, fill it in.

**Check that the configuration is valid:**

```bash
dc config --quiet && echo "CONFIG OK"
```

✅ **Expected:** `CONFIG OK`. An error such as `required variable … is missing a value` names the line to fix.

**Store the whole file in the password manager** as a secure note (`cat .env.production` prints it). If the server is ever lost, this file and a backup are what you need to rebuild.

---

## Part 7 — Build and start (🐧 Server, ~10–15 min)

### 7.1 Build the images

🐧 Server:

```bash
cd ~/dms
dc build
```

This takes **5–10 minutes** the first time. ✅ **Expected:** ends with `Built` lines for `dms-backend`, `dms-web` and `dms-backup` and no `ERROR`.

### 7.2 Start everything

```bash
dc up -d
dc ps
```

✅ **Expected after about 30 seconds** (run `dc ps` again if needed):

| Service | Status |
|---|---|
| `postgres` | `Up … (healthy)` |
| `redis` | `Up … (healthy)` |
| `migrate` | `Exited (0)` ← correct: it runs once and stops |
| `api` | `Up … (healthy)` |
| `worker` | `Up` |
| `web` | `Up` |
| `backup` | `Up` |

### 7.3 Check each part

```bash
dc logs migrate | grep -E "applied|Error"
dc logs worker | tail -2
dc logs backup | tail -1
dc logs web | grep -iE "certificate obtained|error" | tail -3
```

✅ **Expected:**
- migrate: `All migrations have been successfully applied`
- worker: `[ocr] worker ready, waiting for jobs`
- backup: `[backup] schedule '0 2 * * *' (UTC) … copying to s3://dms-backups`
- web: `certificate obtained successfully`. If you don't see it yet, wait a minute and check again. Caddy retries by itself.

### 7.4 Check from outside

🖥️ PowerShell:

```powershell
curl.exe -s https://dms.abateas.com/api/health
curl.exe -sI https://dms.abateas.com | Select-String "HTTP|strict-transport|x-content-type"
```

✅ **Expected:** `{"status":"ok",…}`, then `HTTP/1.1 200` (or `HTTP/2 200`) with the `strict-transport-security` and `x-content-type-options` headers.

🌐 Open `https://dms.abateas.com`. You should see the **Sign in** page with a padlock in the address bar.

---

## Part 8 — Set up the organization (🐧 + 🌐, ~20 min)

### 8.1 Create a one-time invite code

Creating an organization needs an invite code, and a fresh database has none. Make one that works once:

🐧 Server:

```bash
CODE=$(openssl rand -hex 12)
dc exec postgres psql -U dms -d dms -c \
  "INSERT INTO signup_invite_code (id, code, \"maxUses\") VALUES (gen_random_uuid()::text, '$CODE', 1);"
echo "Invite code: $CODE"
```

✅ **Expected:** `INSERT 0 1` and the code printed. Copy the code.

### 8.2 Create the Super Admin account and the organization

🌐 `https://dms.abateas.com`:

1. Click **Create account**. Enter the Super Admin's **full name**, **work email** and a **strong, new password** (never a development one).
2. You land on **Create your organization**. Enter:
   - **Name:** `Abate`
   - **Invite code:** the code from 8.1
   - Click create.
3. You land on **Verify your email**. Open that inbox and click the link in the DMS email.
   - No email after 2 minutes? Check spam, then 🐧 `dc logs api | grep -i mail`. Most often the Brevo key or sender domain isn't right (5.2).
4. After verifying, you arrive at **Onboarding**.

### 8.3 Onboarding step 1 — Storage

1. Choose **Cloudflare R2**.
2. Fill in:
   - **Endpoint:** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - **Bucket:** `dms-documents`
   - **Access key ID / Secret access key:** from the **documents** token (5.3 step 5)
3. Click **Test & save connection**.

✅ **Expected:** **"Connection verified and saved."** The app wrote a test file to the bucket, read it back and deleted it. It moves on to step 2.

A failure message names the cause (wrong key, wrong bucket name, bucket not found). Fix it and try again. Onboarding can't continue until this passes.

### 8.4 Onboarding step 2 — First department

1. Click **Set up a department**. The wizard has five steps: template → vocabulary → document types → roles & members → rules.
2. Pick the closest template (Healthcare, Education, Accounts, HR, Legal or Blank) and adjust it.
3. **Roles & members:** a Super Admin **can't read documents** in a department unless they're a member. To work with this department's documents yourself, add yourself here with the **Department Admin** role.
4. **Rules:** external sharing links are **off** by default (Legal is the exception). Turn them on only if the department needs them.
5. Finish the wizard, then click **Continue** in onboarding.

### 8.5 Onboarding step 3 — Invite people

Invitations are per department, so each person arrives with a role already set:
department → **Members** tab → invite by email and role. Each person gets an email, sets a password and lands in their department.

### 8.6 Remove the invite code

The code was single-use, so it's already spent. Confirm:

🐧 Server:

```bash
dc exec postgres psql -U dms -d dms -c 'SELECT code, "usedCount", "maxUses" FROM signup_invite_code;'
```

✅ **Expected:** `usedCount` = `1` = `maxUses`.

---

## Part 9 — Verify everything (~15 min)

Do every check. Each one tests a different part of the system.

| # | Check | How | ✅ Expected |
|---|---|---|---|
| 1 | Upload + text search | As a department member: **Add document** → upload a PDF that contains text. Wait 10 s, then search for a word that appears **only inside** the PDF. | The document is found |
| 2 | Preview + download | Open the document | It previews, and Download works |
| 3 | Versioning | **New version** → upload another file | v2 is current, v1 is kept |
| 4 | External link | (Only if links are enabled for the department.) Share → create a link → open it in a **private/incognito** window → then **Revoke** and reload | It opens, then shows "Link unavailable" |
| 5 | Invitation email | Invite a colleague | They receive it and can join |
| 6 | Password reset | Sign out → **Forgot password?** | The reset email arrives |
| 7 | Backup now | 🐧 `dc run --rm backup backup.sh` | `wrote /backups/dms-….dump` and `copied to s3://dms-backups/…`. The file also shows in the R2 `dms-backups` bucket. |
| 8 | Reboot survives | 🐧 `sudo reboot`, wait 1 minute, reload the site | The site comes back by itself. `dc ps` shows everything up again. |
| 9 | Audit trail | Workspace → **⋯** → **Audit log** | Your uploads, views and shares are listed |

---

## Part 10 — Monitoring (~10 min)

### 10.1 External uptime check (recommended, free)

🌐 uptimerobot.com → create a free account → **Add New Monitor**:
- Type **HTTP(s)**
- URL `https://dms.abateas.com/api/health`
- Interval **5 minutes**
- Alert contact: your email (and a second person)

This tells you within minutes if the site goes down, even if the whole server is gone.

### 10.2 What's already watching

- **DigitalOcean alerts** (Part 2.4): CPU, memory and disk.
- **Docker** restarts any crashed service automatically.
- **Logs:** 🐧 `dc logs -f api` (Ctrl+C to stop). Logs are rotated automatically and can't fill the disk.

---

## Part 11 — Your routine after go-live

| When | What | Command / where |
|---|---|---|
| **Weekly** | Glance at service status and the latest backup | 🐧 `dc ps` · `ls -lh ~/dms/backups \| tail -3` · R2 `dms-backups` has recent files |
| **Monthly** | OS updates + reboot (out of hours) | 🐧 `sudo apt update && sudo apt upgrade -y && sudo reboot` |
| **Every release** | Backup first, then update | `deploy/README.md` §6 |
| **Quarterly** | **Rehearse a restore** on a scratch droplet | `deploy/README.md` §7 |
| **Yearly** | Review who is Super Admin / Department Admin; rotate API keys | Directory + `deploy/README.md` §8 |

### Deploying a new version (summary; full detail in `deploy/README.md` §6)

🖥️ On your PC, tag and push the release:

```powershell
git tag -a v1.0.1 -m "Describe the change"
git push origin master v1.0.1
```

🐧 On the server:

```bash
cd ~/dms
dc run --rm backup backup.sh              # 1. restore point first
git fetch --tags && git checkout v1.0.1   # 2. new code
dc up -d --build                          # 3. rebuild + migrate + restart
dc ps                                     # 4. all healthy?
```

Then update the worksheet's "Release tag deployed".

---

## Part 12 — Troubleshooting

| Problem | What to do |
|---|---|
| `ssh` hangs or times out | Your IP changed. Update the SSH rule in the DigitalOcean firewall (2.3), or use the Droplet Console. |
| `Permission denied (publickey)` | Use the same PC/key you added in 2.2, and log in as `deploy`, not `root` (root login is disabled). |
| `docker: permission denied` | You didn't log out and back in after Part 4. Run `exit`, then SSH in again. |
| `dc config` says a variable is missing | Fill that line in `.env.production` (6.4). |
| `api` keeps restarting | `dc logs api \| head -30`. "Invalid environment configuration" names the bad setting. A weak `JWT_ACCESS_SECRET` or malformed `STORAGE_CREDENTIALS_KEY` is refused on purpose. |
| Site shows a certificate error | DNS not pointing at the droplet yet (5.1), port 80/443 blocked (2.3), or the orange cloud is on. Check `dc logs web`. |
| No emails arrive | Brevo domain not authenticated, or `EMAIL_FROM` isn't the verified sender (5.2). Check `dc logs api \| grep -i mail`. |
| Storage test fails | Wrong endpoint (needs `https://` and your Account ID), wrong bucket name, or the token isn't scoped to `dms-documents` with Read & Write (5.3). |
| Documents stay "pending" for search | `dc logs worker`. The worker must be up. Image OCR downloads language data on first use, so outbound internet must work. |
| "Too many attempts" for everyone | Only happens behind the Cloudflare orange cloud without `TRUSTED_PROXIES` set (`deploy/README.md` §2). |
| Backup didn't reach R2 | `dc run --rm backup backup.sh` and read the error: usually the backups token, bucket name or endpoint (6.4). |
| Need to undo a bad release | `deploy/README.md` §6 → Rollback. |

---

## Final checklist

- [ ] Code on GitHub (private), release tagged
- [ ] Droplet created, firewall applied, alerts on, droplet backups on
- [ ] Logged in as `deploy`; root and password SSH disabled
- [ ] Docker installed and starting on boot
- [ ] DNS points at the droplet (grey cloud)
- [ ] Brevo domain authenticated, sender added, new API key
- [ ] R2: `dms-documents` + `dms-backups` (60-day lifecycle) with separate scoped tokens
- [ ] `.env.production` complete, `chmod 600`, copy in password manager
- [ ] All services healthy; HTTPS certificate obtained
- [ ] Organization created; invite code used up
- [ ] Storage verified; first department created; people invited
- [ ] All nine checks in Part 9 pass
- [ ] Uptime monitor configured
- [ ] Worksheet filled in and saved
