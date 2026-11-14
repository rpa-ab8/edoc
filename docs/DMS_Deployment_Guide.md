# Edoc — Production Deployment Guide (step by step)

This guide takes you from nothing to a live, secured Edoc at `https://<your-domain>`, one step at a time. Follow it in order and don't skip steps. Each step says **where** you type things (your Windows PC, the server, or a website) and **what you should see** when it worked.

- **Total time:** about 2–3 hours the first time, plus waiting for DNS. Most of that is account setup.
- **Server:** DigitalOcean `s-2vcpu-4gb` (2 vCPU / 4 GB), sized for Release 1 **without image OCR**. Budget: the *Edoc Production Budget* doc. Image OCR stays off (`OCR_IMAGES_ENABLED=false`); turning it on later needs a resize to `s-4vcpu-8gb`.
- **Day-to-day operations after go-live** (updates, rollback, rotating secrets): `deploy/README.md`.
- **How the data is protected, and every restore procedure:** `docs/DMS_Data_Protection_and_Restore.md`. This guide sets the protection up (Parts 5, 6, 7 and 10); that document explains it and is what you open on a bad day.

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
| 1 | A **DigitalOcean** account with a payment method | The server | ≈ $24/month + $4.80 backups |
| 2 | A **domain** you control, with DNS in **Cloudflare** | The address people type | ≈ $10–15/year |
| 3 | A **Cloudflare** account (same as #2) with **R2** enabled | Document storage | ≈ $1–25/month by volume |
| 4 | A **Backblaze B2** account | Off-site copies: encrypted database backups + a replica of every document file. A **different provider** on purpose, so one account problem can't take the data and its copies together. | ≈ $6 per TB per month |
| 5 | A **Healthchecks.io** account | Emails you if a nightly backup, check or replica stops running or fails | Free tier |
| 6 | A **Brevo** account | Verification, invitation and password-reset emails | Free tier |
| 7 | A **GitHub** account | To get the code onto the server (and run CI) | Free |
| 8 | A **password manager** (Bitwarden, 1Password, KeePass…) | To store the secrets you'll generate | — |
| 9 | A **USB stick** (or second safe place) | An offline copy of the backup encryption key | — |

### 0.2 Golden rules

1. **Never reuse anything from development.** Use new R2 buckets, new API keys, new passwords and a new database. The dev test scripts write to and delete from the dev bucket.
2. **Never copy your local `.env` file to the server.** You'll create a fresh `.env.production` on the server in Part 6.
3. **Every secret you generate goes into the password manager immediately.** If `STORAGE_CREDENTIALS_KEY` is lost, the storage connection has to be re-entered.
4. **The backup encryption key (age private key) never goes on the server**, and it lives in **two** places: the password manager and an offline USB stick. Without it, the off-site backups can't be opened.
5. **A backup on the same server is not a backup.** Don't go live until Part 10's checks pass: an encrypted copy in B2, the file replica running, and the alerts working.

### 0.3 A worksheet to keep open

Copy this into a note and fill it in as you go. It holds **no secrets**; those go in the password manager.

```
Domain ............................ dms.abateas.com
Droplet IP ........................
Droplet name ...................... dms-prod-1
GitHub repo ....................... github.com/<your-github-account>/dms
Cloudflare account ID .............
R2 documents bucket ............... dms-documents
B2 region / S3 endpoint ........... https://s3.<region>.backblazeb2.com
B2 backups bucket ................. abate-edoc-backups
B2 replica bucket ................. abate-edoc-docs-replica
age public key .................... age1…            (public — safe to write here)
Healthchecks: db-backup URL .......
Healthchecks: data-guard URL ......
Healthchecks: file-replica URL ....
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
| **Size** | **Basic** → **Regular** → **$24/mo: 2 vCPU / 4 GB / 80 GB SSD** (`s-2vcpu-4gb`). Not the 8 GB size: that's only needed if image OCR is turned on later. |
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
| SSH | TCP | 22 | **Your office/home public IP(s) only**. See the first note below |
| HTTP | TCP | 80 | All IPv4, All IPv6 |
| HTTPS | TCP | 443 | All IPv4, All IPv6 |
| Custom | **UDP** | 443 | All IPv4, All IPv6 (HTTP/3) |

- **Outbound rules:** leave the defaults (all allowed). The server needs to reach R2, Brevo, Let's Encrypt and Docker Hub.
- **Apply to Droplets:** select `dms-prod-1` → **Create Firewall**.

> **List every public IP your network uses.** Some office networks spread connections over several internet lines, each with its own public IP (the production office has three). In PowerShell run `curl.exe -s https://api.ipify.org` about ten times and add **every** address that appears, or ask whoever runs the network for the full list. With only one listed, SSH works sometimes and times out other times. Add home or mobile networks you work from too.

> If your IP changes later, SSH times out. Add the new IP to the SSH rule; the firewall can always be edited from the DigitalOcean website. To tell a firewall block from a dead server: if port 80 answers (even with "connection refused") while SSH times out, the server is up and the firewall is dropping SSH. The **Droplet Console** may not work once root login is turned off in 3.5, so don't rely on it.

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

> If your key isn't the default `id_ed25519` (for example you made one called `digitalocean`), add `-i ~/.ssh/<name>` to every `ssh` and `scp` command in this guide: `ssh -i ~/.ssh/digitalocean root@203.0.113.10`.

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

> Alternative used on the production server: a key-only `deploy` account with a locked password and passwordless sudo (`adduser --disabled-password deploy`, then `echo "deploy ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/90-deploy-user`). A member of the `docker` group is root-equivalent anyway, so the sudo password adds little. Either way works; the steps below don't change.

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

You can do 5.1–5.6 in any order while DNS propagates.

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
4. **Add the sender.** **Senders** → **Add sender** → Name `Edoc`, email `noreply@abateas.com`.
5. **Create an API key.** Profile menu → **SMTP & API** → **API Keys** → **Generate a new API key** → name `dms-production`.
   **Copy it into the password manager now**, because Brevo only shows it once. Make a new key; don't reuse the development one.
6. **Allow the server's IP.** Brevo blocks API calls from unknown IP addresses once its IP protection is on, and it switches that on by itself after about 30 days with no new IPs. Open **app.brevo.com/security/authorised_ips** and add the droplet's IP. Without this the server can't send any email (6.4 Block 4 tests it). Don't switch the protection off; one allowed IP is safer. If the server ever moves to a new IP, update this list.

> **Which domain sends the email.** The sender doesn't have to be on your company mail domain. Production sends as `noreply@abateas.app` (the site's own domain), which keeps Brevo's DKIM and DMARC records out of the company mail's DNS. Brevo's automatic Cloudflare authentication in step 1 also works: it adds the Brevo-code TXT, two DKIM CNAMEs (grey cloud) and a monitoring-only DMARC record.

### 5.3 Document storage — Cloudflare R2

🌐 Cloudflare → **R2 Object Storage**. If R2 isn't enabled yet, follow its one-time setup.

1. **Find your Account ID.** It's on the R2 overview page (right side). Write it in the worksheet.
   Your S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
2. **Documents bucket:** **Create bucket** → name `dms-documents` → location **Automatic** → **Create**.
   Don't add a bucket lock or a lifecycle rule to this bucket. They would fight Edoc's own Trash and retention rules. Its safety copy is the B2 replica (5.4).
3. **Token for the app (read & write):** R2 overview → **Manage R2 API Tokens** (or **API → Manage API tokens**) → **Create API token**:
   - Name `dms-documents-prod`
   - Permissions **Object Read & Write**
   - **Specify bucket(s)** → `dms-documents` only
   - **Create**, then copy the **Access Key ID** and **Secret Access Key** into the password manager (the secret is shown once). You enter these in the app in Part 8. They're also what you use to put files back during a restore.
4. **Token for the replica job (read only):** same again, but:
   - Name `dms-documents-replica-read`
   - Permissions **Object Read only**
   - Bucket `dms-documents` only
   - Save both values in the password manager. Part 10 uses them. Read-only means the nightly copy job can never damage the live files.

> Database backups no longer go to R2. They go to Backblaze (5.4), a different provider, so a Cloudflare account problem can't take the data and its backups at the same time.

### 5.4 Off-site copies — Backblaze B2

Two private buckets in Backblaze: one for the encrypted database backups, one for a copy of every document file. Create **both**: each needs its own lifecycle rule and its own key.

> **Free tier:** Backblaze includes 10 GB free across all buckets, without a card. The replica holds every document plus 90 days of deleted ones, so add payment details before the total nears 10 GB, or uploads and the nightly jobs start failing (Healthchecks will alert). Each gets a key that can **add** files but **cannot delete** them. So even someone who fully takes over the server can't destroy the copies.

**a) Account and region.** 🌐 backblaze.com → sign up for **B2 Cloud Storage**. Choose the region closest to you (for example EU Central or US East). The region can't be changed later.

**b) Backups bucket.** **Buckets → Create a Bucket**:
- **Bucket Unique Name:** `abate-edoc-backups` (B2 names are global; add your company prefix)
- **Files in Bucket are:** **Private**
- **Default Encryption:** **Enable**
- **Object Lock:** **Disable** (the no-delete key below does the protecting)
- **Create a Bucket**

Then on the bucket → **Lifecycle Settings** → **Use custom lifecycle rules** → add one rule:
- File path: leave empty (all files)
- **Days till hide:** `90`
- **Days till delete:** `30`
- **Update Bucket**

Backups are kept 90 days off-site, then hidden, then erased 30 days later. A backup hidden early, by mistake or by an attacker using the server's key, is still recoverable for 30 days.

**c) Replica bucket.** **Create a Bucket** again:
- Name `abate-edoc-docs-replica`
- **Private**, Default Encryption **Enable**, Object Lock **Disable**

Then **Lifecycle Settings** → **Keep prior versions for this number of days:** `90` → **Update Bucket**.

> ⚠️ On the replica bucket **never use "Days Till Hide"**. It hides *current* files too, so after that many days the live copy of every document would vanish from the replica. "Days Till Hide" belongs only on the backups bucket, where every file is a dated backup.

A file deleted in Edoc (or from R2 by mistake) stays recoverable here for 90 days.

> ⚠️ **Compliance check:** this means a permanently deleted document still exists in this replica for up to 90 days. If your retention policy requires faster destruction, use a smaller number. That shortens the recovery window by the same amount. See `docs/DMS_Data_Protection_and_Restore.md` §3.6.

**d) Write the endpoint down.** Each bucket card shows an **Endpoint** such as `s3.eu-central-003.backblazeb2.com`. Put `https://` plus that into the worksheet.

**e) Create the two no-delete keys.**

The B2 web page can only create keys that **include** delete permission, so use the B2 command-line tool once, on your PC. 🖥️ PowerShell:

```powershell
# Install (needs Python 3); or download b2-windows.exe from github.com/Backblaze/B2_Command_Line_Tool/releases
pip install --upgrade b2
```

🌐 In Backblaze → **Application Keys** → **Generate New Master Application Key** (or use your existing master key). Copy its **keyID** and **applicationKey**. The master key stays on your PC only, never on the server.

🖥️ PowerShell:

```powershell
b2 account authorize            # paste the master keyID, then the master applicationKey
b2 key create --bucket abate-edoc-backups       edoc-backups-prod  listAllBucketNames,listBuckets,listFiles,readFiles,writeFiles
b2 key create --bucket abate-edoc-docs-replica  edoc-replica-prod  listAllBucketNames,listBuckets,listFiles,readFiles,writeFiles
```

(Older versions of the tool spell these `b2 authorize-account` and `b2 create-key`.)

✅ **Expected:** each `key create` prints two values: a **key ID** and a **key**. Put both pairs in the password manager right away, labelled **backups** and **replica**. The key is shown only once.

Notice what's missing from the permission lists: `deleteFiles`. These keys can upload, list and read, and can *hide* a file, but they can never erase one. Check with `b2 key list`: each key should name one bucket and no `deleteFiles`.

### 5.5 Backup encryption key — age

Database dumps and the file manifest are encrypted on the server **before** they leave it, with a public key. They can only be opened with the matching private key, which never touches the server.

🖥️ PowerShell:

```powershell
winget install --id FiloSottile.age
# open a NEW PowerShell window so age is on the PATH, then:
age-keygen -o edoc-backup-age.key
```

✅ **Expected:** `Public key: age1…` is printed.

1. Copy the **public key** (`age1…`) into the worksheet. It's not secret, and it goes in `.env.production` in 6.4.
2. Store the file `edoc-backup-age.key` (the **private** key) in **two** places:
   - The password manager, as an attachment or with its full text in a secure note.
   - A USB stick kept somewhere safe, away from the office PC.
3. Then delete it from your PC: `Remove-Item .\edoc-backup-age.key`.

> If both copies of the private key are lost, every off-site backup becomes unreadable. Two copies, two places.

### 5.6 Alerts — Healthchecks.io

Each nightly job pings a URL when it succeeds. If a ping is late or reports failure, Healthchecks emails you. This is how you find out that backups **stopped**, which nothing else would tell you.

🌐 healthchecks.io → sign up → in your project, **Add Check** three times:

| Name | Period | Grace |
|---|---|---|
| `edoc-db-backup` | 1 day | 2 hours |
| `edoc-data-guard` | 1 day | 2 hours |
| `edoc-file-replica` | 1 day | 2 hours |

For each, copy the **ping URL** (`https://hc-ping.com/<uuid>`) into the worksheet.

Then go to **Integrations** and check that email goes to you. Add a second person as well, so an alert isn't missed during a holiday.

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

Always clone into `~/dms`, whatever the repository is called (production's is `edoc`): the `dc` alias and the compose paths use that folder.

### 6.3 Create a short command alias

All management commands are long, so define `dc` once:

🐧 Server:

```bash
echo "alias dc='docker compose --project-directory ~/dms -f ~/dms/docker-compose.prod.yml --env-file ~/dms/.env.production'" >> ~/.bashrc
source ~/.bashrc
```

From now on, `dc <something>` runs Docker Compose for Edoc, from any folder.

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
| `EMAIL_FROM_NAME=` | `Edoc` (or similar) | Shown as the sender name |
| `BACKUP_S3_BUCKET=` | `abate-edoc-backups` | The **B2 backups** bucket (5.4 b) |
| `BACKUP_S3_ENDPOINT=` | `https://s3.<region>.backblazeb2.com` | From the worksheet (5.4 d), with `https://` |
| `BACKUP_S3_ACCESS_KEY_ID=` | the **backups** key ID (5.4 e) | |
| `BACKUP_S3_SECRET_ACCESS_KEY=` | the **backups** key (5.4 e) | |
| `BACKUP_REQUIRE_OFFSITE=` | leave `true` | A backup run with no off-site copy counts as a failure and alerts you |
| `BACKUP_AGE_RECIPIENT=` | the **public** key `age1…` (5.5) | Never the private key |
| `BACKUP_HEALTHCHECK_URL=` | the `edoc-db-backup` ping URL (5.6) | |
| `DATA_GUARD_HEALTHCHECK_URL=` | the `edoc-data-guard` ping URL (5.6) | |

Don't put the **documents** bucket keys here. You'll enter those in the app (Part 8), where they're stored encrypted. The `edoc-file-replica` URL and the replica keys are used in Part 10, not here.

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

### 7.0 Create the backups folder

Backups and the daily file manifest are written to `~/dms/backups`. The `data-guard` service runs as uid 1000, so that user must own the folder:

🐧 Server:

```bash
mkdir -p ~/dms/backups
sudo chown 1000:1000 ~/dms/backups
chmod 700 ~/dms/backups
```

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
| `retention-worker` | `Up` |
| `web` | `Up` |
| `backup` | `Up` |
| `data-guard` | `Up` |

### 7.3 Check each part

```bash
dc logs migrate | grep -E "applied|Error"
dc logs worker | tail -2
dc logs retention-worker | tail -2
dc logs backup | tail -1
dc logs data-guard | tail -1
dc logs web | grep -iE "certificate obtained|error" | tail -3
```

✅ **Expected:**
- migrate: `All migrations have been successfully applied`
- worker: `[ocr] worker ready, waiting for jobs (PDF text: on, image OCR: off)`. If it says `image OCR: ON`, set `OCR_IMAGES_ENABLED=false` in `.env.production` and run `dc up -d`.
- retention-worker: `[retention] scheduled daily at 02:00 Asia/Kolkata (cron "0 2 * * *")` then `[retention] worker ready`
- backup: `[backup] schedule '0 2 * * *' (UTC) … copying to s3://abate-edoc-backups`
- data-guard: `[data-guard] next run in … min`
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

Run this block **once**. ✅ **Expected:** `INSERT 0 1` and one `Invite code:` line. Copy the code. If you ran it twice there are two codes; 8.6 closes the spare.

### 8.2 Create the Super Admin account and the organization

🌐 `https://dms.abateas.com`:

1. Click **Create account**. Enter the Super Admin's **full name**, **work email** and a **strong, new password** (never a development one).
2. You land on **Create your organization**. Enter:
   - **Name:** `Abate`
   - **Invite code:** the code from 8.1
   - Click create.
3. You land on **Verify your email**. Open that inbox and click the link in the Edoc email.
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

Then close any code that was never used, so nobody can create another organization with it:

```bash
dc exec postgres psql -U dms -d dms -c "UPDATE signup_invite_code SET active = false WHERE \"usedCount\" = 0;"
```

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
| 7 | Backups and data protection | Do all of **Part 10** | Every check in 10.6 passes |
| 8 | Reboot survives | 🐧 `sudo reboot`, wait 1 minute, reload the site | The site comes back by itself. `dc ps` shows everything up again. |
| 9 | Audit trail | Workspace → **⋯** → **Audit log** | Your uploads, views and shares are listed |

---

## Part 10 — Data protection: file replica and go-live checks (🐧 + 🌐, ~30 min)

Parts 5–7 set up the database backups and the daily manifest. This part adds the last copy (a nightly replica of every document file in B2), then **proves** every protection works before real data arrives. Background and all restore procedures: `docs/DMS_Data_Protection_and_Restore.md`.

### 10.1 Install the tools

🐧 Server:

> ⚠️ **Don't install rclone with `apt`.** Ubuntu 24.04 ships rclone 1.60.1, and Backblaze now accepts only version 4 of its login API, which rclone uses from **1.73.0**. An older rclone fails with `This request is not currently supported on API version number 1`. Install the current release from rclone.org and check its checksum:

```bash
sudo apt update && sudo apt install -y jq
V=v1.76.0      # any release 1.73.0 or newer; the latest is in https://downloads.rclone.org/version.txt
cd /tmp
curl -fsSLO https://downloads.rclone.org/$V/rclone-$V-linux-amd64.deb
curl -fsSL https://downloads.rclone.org/$V/SHA256SUMS | grep " rclone-$V-linux-amd64.deb" | sha256sum -c -
sudo apt install -y ./rclone-$V-linux-amd64.deb
rclone version | head -1
timedatectl | grep "Time zone"
```

✅ **Expected:** `rclone-v1.76.0-linux-amd64.deb: OK` (if it says FAILED, stop), then `rclone v1.76.0`, and `Time zone: Etc/UTC`. The schedules below assume UTC.

### 10.2 Connect rclone to R2 (read only) and B2 (replica)

Use the **read-only** R2 token (5.3 step 4) and the **replica** B2 key (5.4 e).

🐧 Server. Start each line with a **space**: on Ubuntu, a leading space keeps the command, and the keys in it, out of the shell history.

```bash
 rclone config create r2-docs-ro s3 provider=Cloudflare \
   access_key_id=<replica-read key id> secret_access_key=<replica-read secret> \
   endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com no_check_bucket=true
 rclone config create b2-offsite b2 account=<replica key ID> key=<replica key>
chmod 600 ~/.config/rclone/rclone.conf
```

Check both:

```bash
rclone ls r2-docs-ro:dms-documents | head -5
rclone lsd b2-offsite:
```

✅ **Expected:**
- The first command lists the files uploaded in Part 9: lines like `183422 <org-id>/<uuid>`.
- The second shows `abate-edoc-docs-replica`.

An `AccessDenied` or `401` means a key was pasted wrong. Re-run the `config create` line; it overwrites the remote.

### 10.3 Create the nightly replica job

Replace the `HC=` URL with your `edoc-file-replica` ping URL (5.6) and the bucket names if yours differ:

🐧 Server:

```bash
sudo tee /usr/local/bin/dms-replicate.sh > /dev/null <<'EOF'
#!/bin/sh
# Nightly copy of the R2 documents bucket to the B2 replica.
# See docs/DMS_Data_Protection_and_Restore.md §3.6. Deletions in R2 only HIDE files in B2 (kept 90 days).
HC="https://hc-ping.com/<edoc-file-replica-uuid>"
SRC="r2-docs-ro:dms-documents"
DST="b2-offsite:abate-edoc-docs-replica"

echo "[replica] $(date -u +%FT%TZ) start"
if rclone sync "$SRC" "$DST" --fast-list --transfers 8 --checkers 16 --max-delete 500 --log-level NOTICE; then
  echo "[replica] $(date -u +%FT%TZ) ok"
  curl -fsS -m 10 --retry 3 -o /dev/null "$HC"
else
  rc=$?
  echo "[replica] $(date -u +%FT%TZ) FAILED (exit $rc)"
  curl -fsS -m 10 --retry 3 -o /dev/null "$HC/fail"
  exit $rc
fi
EOF
sudo chmod 755 /usr/local/bin/dms-replicate.sh
```

`--max-delete 500` is a tripwire. If more than 500 files disappeared from R2 since the last night, the job refuses to mirror that and alerts you instead. That pattern means an accident or an attack, and it needs a human. If you ever purge more than 500 documents on purpose, run the script once by hand with a higher number.

### 10.4 Run it once now

```bash
/usr/local/bin/dms-replicate.sh 2>&1 | tee -a ~/dms-replicate.log
```

✅ **Expected:** `[replica] … ok`. In 🌐 Backblaze → **Browse Files** → `abate-edoc-docs-replica`, the same `<org-id>/…` files are now there, and Healthchecks shows `edoc-file-replica` as **up** (green).

If a run fails, the script pings Healthchecks `/fail`, so you (and the second person) get an alert email; the next successful run turns the check green again. The replica can hold fewer files than the database has versions: restoring an old version reuses its stored file.

With a large existing bucket the first run can take hours. Start it inside `tmux` (`tmux new -s replica`, run it, then `Ctrl+B` `D` to detach) so it survives closing SSH.

### 10.5 Schedule it

```bash
echo "30 3 * * * $USER /usr/local/bin/dms-replicate.sh >> /home/$USER/dms-replicate.log 2>&1" | sudo tee /etc/cron.d/dms-replicate
sudo chmod 644 /etc/cron.d/dms-replicate
```

It runs at 03:30 UTC every night, after the 01:30 manifest and the 02:00 database backup.

### 10.6 Go-live checks: prove every protection

Do these **in order**. Don't put real documents in until all pass.

**a) Manifest and scrub.**

```bash
dc run --rm data-guard node dist/worker/data-guard.js --once
```

✅ **Expected:**
- `[data-guard] manifest: N version(s) → /backups/manifest-….jsonl.gz`
- `[data-guard] scrub org=…: N/N verified (of N versions)`, where both numbers are the same

Healthchecks shows `edoc-data-guard` **up**.
- `EACCES: permission denied` means 7.0 was skipped.
- `MISSING`/`MISMATCH` on a brand-new install means the storage settings point at the wrong bucket.

**b) Encrypted off-site backup.**

```bash
dc run --rm backup backup.sh
```

✅ **Expected**, in this order:
- `wrote /backups/dms-….dump.age (…), verified`
- `copied to s3://abate-edoc-backups/dms/dms-….dump.age`
- `copied manifest manifest-….jsonl.gz (encrypted)`

In 🌐 Backblaze → **Browse Files** → `abate-edoc-backups` → `dms/`, both `.age` files are there. Healthchecks shows `edoc-db-backup` **up**.

**c) The off-site keys can't delete.**

```bash
echo test > /tmp/delete-test.txt
rclone copyto /tmp/delete-test.txt b2-offsite:abate-edoc-docs-replica/_delete-test.txt
rclone deletefile --b2-hard-delete b2-offsite:abate-edoc-docs-replica/_delete-test.txt
```

✅ **Expected:** the last command **fails** with an `unauthorized`/`401` error. That failure is the pass. (The test file is cleaned up by the next nightly replica run and the 90-day rule.) If it succeeds, the replica key has delete permission: redo 5.4 e.

**d) Alerts really fire.** In Healthchecks, open `edoc-db-backup` → **⋯ / Ping URL** and send a test `/fail`:

```bash
curl -fsS -o /dev/null "<edoc-db-backup URL>/fail"
```

✅ **Expected:** an alert email within a minute or two. Then send a normal ping (`curl -fsS -o /dev/null "<URL>"`) to set it back to up.

**e) First restore drill.** With the age private key from your USB stick, follow `docs/DMS_Data_Protection_and_Restore.md` **§6 (Monthly restore drill)** once now, end to end.

✅ **Expected:** the drill database restores and its counts match live. Then **shred the key off the server** (`shred -u ~/dms/backups/age.key`, the last step of §6).

The copy-paste version with production names, the `dms_drill` guard and a file checksum check is `docs/developer/11_Backup_and_Restore.md` §4. Run the clean-up commands **one at a time** (files the containers created are owned by root, so use `rm -f`, or `rm` stops to ask and swallows the next pasted lines), and delete the temporary key copy from your PC in PowerShell.

**f) Droplet backups** are enabled (2.2): 🌐 DigitalOcean → droplet → **Backups** shows "enabled".

---

## Part 11 — Monitoring (~10 min)

### 11.1 External uptime check (recommended, free)

🌐 DigitalOcean → **Monitoring** → **Uptime** → **Create Uptime Check**. DigitalOcean's pricing includes one uptime check free each month (1-minute checks from several regions, email alerts); if the screen shows a price, stop and check.
- Name `edoc-health`, type **HTTPS**, URL `https://dms.abateas.com/api/health`, two or more regions
- Alert: **Down** for about 2 minutes, to your email and a second person; add **SSL certificate expiry** (about 14 days) if offered
- Save; within a minute it shows **Up**

This tells you within minutes if the site goes down, even if the whole server is gone. A reboot (Part 9, check 8) is too short to trigger it. To test the alert once, at a quiet moment: `dc stop web`, wait for the "down" email (3–4 minutes), `dc start web`.

> UptimeRobot's free plan is the usual alternative, but sources disagree on whether its terms allow business use. Check its current terms before using it for a company system.

### 11.2 What's already watching

- **Healthchecks.io** (5.6, Part 10): database backup, manifest and scrub, file replica. An email means something stopped or failed. What to do for each alert: `docs/DMS_Data_Protection_and_Restore.md` §4.
- **DigitalOcean alerts** (Part 2.4): CPU, memory and disk.
- **Docker** restarts any crashed service automatically.
- **Logs:** 🐧 `dc logs -f api` (Ctrl+C to stop). Logs are rotated automatically and can't fill the disk.

---

## Part 12 — Your routine after go-live

| When | What | Command / where |
|---|---|---|
| **Any alert email** | Act the same day | `docs/DMS_Data_Protection_and_Restore.md` §4 |
| **Weekly** | Glance at service status, the latest backups and the replica log | 🐧 `dc ps` · `sudo ls -lh ~/dms/backups \| tail -4` · `tail -3 ~/dms-replicate.log` · 🌐 Healthchecks: all three green |
| **Monthly** | OS updates + reboot (out of hours) | 🐧 `sudo apt update && sudo apt upgrade -y && sudo reboot` |
| **Monthly** | **Restore drill** (30 min) | `docs/DMS_Data_Protection_and_Restore.md` §6 |
| **Every release** | Backup first, then update | `deploy/README.md` §6 |
| **Yearly** | **Full rebuild rehearsal** on a temporary droplet | `docs/DMS_Data_Protection_and_Restore.md` §5.2 |
| **Yearly** | Review who is Super Admin / Department Admin; rotate API keys; check the USB key copy still reads | Directory + `deploy/README.md` §8 |

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

## Part 13 — Troubleshooting

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
| PDFs stay "pending" for search | `dc logs worker`. The worker must be up: it extracts the text inside PDFs. (Images are never pending: with image OCR off they're searchable by name and metadata only, by design.) |
| "Too many attempts" for everyone | Only happens behind the Cloudflare orange cloud without `TRUSTED_PROXIES` set (`deploy/README.md` §2). |
| Backup fails / `edoc-db-backup` alert | `dc run --rm backup backup.sh` and read the error. `BACKUP_REQUIRE_OFFSITE=true but BACKUP_S3_BUCKET is not set` means 6.4 is incomplete. `AccessDenied`/`InvalidAccessKeyId` means the B2 backups key, bucket name or endpoint is wrong (5.4). `age: … recipient` means `BACKUP_AGE_RECIPIENT` isn't a valid `age1…` key. |
| `data-guard` fails with `EACCES` | `~/dms/backups` isn't owned by uid 1000 (7.0). |
| `data-guard` reports `MISSING` or `MISMATCH` | A stored file is gone or damaged. Restore it from the replica: `docs/DMS_Data_Protection_and_Restore.md` §5.3. |
| Replica log says "max delete" | **Stop.** More than 500 files disappeared from R2 since last night. Find out why before running anything (§4 of the Data Protection doc). |
| Uploads fail after this update with a checksum or `BadDigest` error | The new upload checksum isn't accepted by the storage provider. Check `dc logs api` and report it; don't disable it silently. |
| SSH works sometimes, times out other times | Your network uses more than one public IP. Add all of them to the SSH rule (2.3). |
| Replica fails: `not currently supported on API version number 1` | rclone is older than 1.73. Install the current one from rclone.org (10.1). |
| Emails fail and Brevo mentions an unrecognised IP | Add the server's IP at app.brevo.com/security/authorised_ips (5.2 step 6). |
| `rm: remove write-protected regular file …?` in `~/dms/backups` | The file was made by a container (owned by root). Use `rm -f`. |
| Need to undo a bad release | `deploy/README.md` §6 → Rollback. |

---

## Final checklist

- [ ] Code on GitHub (private), release tagged
- [ ] Droplet created, firewall applied, alerts on, droplet backups on
- [ ] Logged in as `deploy`; root and password SSH disabled
- [ ] Docker installed and starting on boot
- [ ] DNS points at the droplet (grey cloud)
- [ ] Brevo domain authenticated, sender added, new API key, server IP in Authorised IPs
- [ ] R2: `dms-documents`, an app token (read & write) and a replica token (read only)
- [ ] B2: backups bucket (hide 90 / delete 30) + replica bucket (keep prior versions 90), two **no-delete** keys
- [ ] age key pair made; private key in the password manager **and** on a USB stick; not on the PC or the server
- [ ] Three Healthchecks.io checks, email to two people
- [ ] `.env.production` complete, `chmod 600`, copy in password manager
- [ ] All services healthy; HTTPS certificate obtained
- [ ] Organization created; invite code used up
- [ ] Storage verified; first department created; people invited
- [ ] All nine checks in Part 9 pass
- [ ] Part 10: rclone ≥ 1.73 installed; replica job scheduled; all go-live checks a–f pass, including the first restore drill
- [ ] Uptime monitor configured
- [ ] Worksheet filled in and saved
