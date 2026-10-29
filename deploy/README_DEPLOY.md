# RegAssist DZ — Production & Linux Deployment Guide

This directory contains the production-hardened deployment configuration for RegAssist DZ on Linux (Ubuntu 24.04 LTS / 4 vCPU / 8 GB RAM VPS) and containerized environments.

---

## Architecture Overview

```
[ Internet Client (Browser) ]
              │  (HTTPS : 443)
              ▼
    [ Nginx Reverse Proxy ]
         │ (Drop unknown SNI/Host - HTTP 444)
         │ (Overwrites X-Forwarded-* headers)
         ▼ (HTTP : 8790)
   [ Gunicorn WSGI Worker ] (deploy.wsgi:app)
         │ (1 worker, 4 gthread threads)
         │ (Shared single-flight inference lock)
         │ (HTTP 429 + Retry-After: 30 on contention)
         ▼
   [ RegAssist Core Engine ]
         ├─ BM25 Lexical + multilingual-e5-small Embeddings
         ├─ ONNX mmarco Reranker
         └─ Local CPU llama-server (127.0.0.1:8187, Qwen3-4B Q4_K_M)
```

---

## Access Control

The service is **public by default**: anyone with the link can use it, without a password. Gunicorn has no access gate (the access code of the Windows LAN mode lives in `local_app/lan.py` and is not wired into `deploy/wsgi.py`), so the protections against abuse are these:

- **Persistent waiting queue** (`local_app/persist.py`; design and rationale in `docs/SUIVI_ASYNCHRONE.md`). The model handles one question at a time (about 150 s on the VPS CPU). The page submits the question (`POST /api/queue`, answered at once with a personal tracking link) and polls its state (`GET /api/queue/<ticket>`); the visitor may close the page and come back later (link, notification, or the browser remembering the pending question). Requests live in **SQLite** at `${REGASSIST_DATA_ROOT}/state/requests.sqlite3` (mode 600, WAL), survive a restart (waiting: resumed in order; running when the service stopped: re-queued once, then reported as an error) and are deleted after **7 days** (`REGASSIST_RETENTION_DAYS`) or on request. The link is a 132-bit secret of which only the SHA-256 is stored; addresses are stored salted and hashed; an unknown request and someone else's request answer identically (404). Limits: 8 running or waiting questions (`REGASSIST_QUEUE_MAX`), 2 per client IP (`REGASSIST_QUEUE_PER_IP`), 2000 stored requests in total. Without a data directory (or with `REGASSIST_QUEUE_PERSIST=0`) the queue falls back to the in-memory version of `local_app/waitqueue.py` (page must stay open); `REGASSIST_QUEUE_MAX=0` restores the old HTTP 429 `busy`.
- **Web Push notifications** (`local_app/webpush.py`, library `cryptography` only, pinned in `requirements-deploy.txt`; disable with `REGASSIST_PUSH=0`). Offered after the submission, permission asked only after a click; the subscription is attached to one request, used once when the answer is ready, then deleted (or earlier if the push service answers 404/410). The message is encrypted end to end (RFC 8291), signed with the server's VAPID key (RFC 8292) created at first start in `${REGASSIST_DATA_ROOT}/state/vapid_private.pem` (mode 600, never in the repository) and contains neither the question nor the answer. The subscription address comes from the browser, so it is accepted only if it is HTTPS and belongs to a closed list of push services (Google FCM, Mozilla, Apple, Microsoft WNS): no server-side request forgery. Without push, the visitor keeps the personal link; a push failure never affects the answer.
- **Privacy**: while persistence is active the interface and the "À propos" panel say that the question and its answer are kept on the server for the retention period (the default text "ne conserve pas" is shown only otherwise). Question texts are never written to the logs; nginx does not log `/api/queue`; the link travels in the URL fragment (never sent to the server or in a Referer). Backups of the SQLite file are not configured: losing it only loses pending/finished requests.
- **Rate limits** in nginx (`/api/chat` and the queue submissions: 10 requests/min per IP; status polling: 300/min per IP) and in the application (10 submissions/min per IP, behind the trusted proxy address).
- Host and Origin checks, TLS only, unknown host names dropped, `fail2ban` for SSH.

The service exposes an unvalidated legal assistant (status NO-GO PROVISOIRE; the interface says so on every page). To restrict it to a few evaluators instead, use **`--private`**: nginx then requires HTTP Basic authentication on the whole site (see `setup_vps.sh` and `update_vps.sh` below).

---

## Directory Contents

- `requirements-deploy.txt`: Production requirements extending root `requirements.txt` with `gunicorn==23.0.0`.
- `linux_env.sh`: Non-intrusive Linux path mapping and environment setup.
- `start_llm_linux.sh`: Script to launch `llama-server` (b11411 build) with matching arguments on Linux.
- `wsgi.py`: Gunicorn WSGI entry point ensuring single `Service` instance and thread safety.
- `nginx-regassist.conf`: Hardened reverse proxy configuration with catch-all TLS dropping, rate limits and the waiting-queue location.
- `setup_vps.sh` / `update_vps.sh`: one-command installation of a fresh server / update of a running one (see below).
- `systemd/`: Service supervision unit files (`regassist-llm.service`, `regassist-web.service`).
- `regassist.env`: Environment file containing production secrets and path configurations.
- `test_proxy_security.sh`: 3-case automated test script for host/origin security and header spoofing defenses.
- `test_concurrency_and_load.sh`: End-to-end contention test validating sibling thread liveness and HTTP 429 `Retry-After`.
- `run_linux_poc.sh`: Automation script for running the 3 diagnostic queries and measuring RSS RAM on Linux.

---

## Quick path: `setup_vps.sh`

On a fresh Ubuntu 24.04 server whose DNS name already points to it, as root:
```bash
apt-get update && apt-get install -y git certbot
certbot register --agree-tos --register-unsafely-without-email --no-eff-email   # or give an e-mail address instead
git clone https://github.com/SalimMabed/regassist-dz.git /opt/regassist-dz
bash /opt/regassist-dz/deploy/setup_vps.sh regassist.example.org            # public access with the waiting queue
# bash /opt/regassist-dz/deploy/setup_vps.sh regassist.example.org --private  # or: password-protected (login written to /root/regassist-access.txt)
```
The script runs steps 1 to 7 below (it refuses to start when memory, disk or DNS are insufficient) and prints a result block without secrets, including one real question sent through the queue. With `--private` it also generates the Basic-auth login and writes it to `/root/regassist-access.txt` (mode 600). It can be re-run after a failure. Without the `certbot register` line above, certbot asks for an e-mail address and the Let's Encrypt terms interactively.

### Updating a running server: `update_vps.sh`

After new commits on `main`, as root on the server (no download, the language model is not reloaded, about two minutes including the application warm-up):
```bash
cd /opt/regassist-dz && git -c safe.directory=/opt/regassist-dz pull --ff-only
bash /opt/regassist-dz/deploy/update_vps.sh --public      # or --private; without an option the current mode is kept
```
The first command is only needed when `update_vps.sh` itself is not on the server yet. The script pulls the repository, refreshes the Python environment only when its requirements changed, restarts `regassist-web`, regenerates the nginx site from the template (the old one is saved to `/root/nginx-regassist.conf.*.bak` and restored if `nginx -t` fails) and prints a result block.

**First real run (2026-10-29).** Octenium VPS Ultimate: 4 vCPU, 8 GB RAM, 500 GB HDD (RAID 10), Intel Xeon E5-2690 v2 (Ivy Bridge: **AVX but no AVX2**), Ubuntu 24.04. Models and corpus were downloaded and verified in about one minute, the whole setup took about 15 minutes. Checks: HTTP 301, HTTPS 401 without password and 200 with it, valid Let's Encrypt certificate. One real question ("Quel est le plafond d'indemnisation par déposant ?") returned `answered` with 3 sources and 1 citation in **148 s** (generation 144.7 s). On a CPU without AVX2 the reranker and llama.cpp run, but slower, and ranks may differ slightly from an AVX2 machine (see `docs/OUTDATED_AMOUNTS_STUDY.md`).

Two defects found by that run are fixed: the shell scripts were committed without the executable bit (systemd could not start `start_llm_linux.sh`), and the virtualenv was created after the data step that needs numpy.

## Deployment Steps (Ubuntu 24.04 LTS)

### 1. System Preparation
```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-pip nginx curl libgomp1 git certbot apache2-utils ufw
sudo useradd -r -s /bin/false regassist
# The reranker (model_quint8_avx2.onnx) needs AVX2: this must print "avx2". If it prints nothing, stop here.
lscpu | grep -o -m1 avx2
```

### 2. Directory Layout
```bash
sudo git clone https://github.com/SalimMabed/regassist-dz.git /opt/regassist-dz
sudo mkdir -p /opt/regassist-data/llm /var/log/regassist
sudo chown -R regassist:regassist /opt/regassist-dz /opt/regassist-data /var/log/regassist
```
The repository (about 1.1 GB with the corpus) keeps its bytes as committed (`.gitattributes` sets `* -text`): do not convert line endings, the frozen-system hashes depend on them.

### 3. Populate Data Folders (`/opt/regassist-data/llm`)

On a fresh VPS, model files, vectors, and corpus snapshots must be initialized in `/opt/regassist-data/llm`. You can run the automated helper script or execute the commands manually.

#### Option A: Automated (Recommended)
```bash
sudo bash deploy/populate_data_linux.sh /opt/regassist-data/llm
```

#### Option B: Manual Step-by-Step

1. **Create subdirectories:**
```bash
mkdir -p /opt/regassist-data/llm/{models/embeddings/multilingual-e5-small/onnx,models/rerankers/mmarco-mMiniLMv2-L12-H384/onnx,llama.cpp/b11411,index,snapshots/corpus_phase4}
```

2. **Download Qwen3-4B-Instruct GGUF (2.5 GB) & verify SHA-256:**
```bash
curl -L -C - --retry 10 -o /opt/regassist-data/llm/models/qwen3-4b-instruct-2507-q4_k_m.gguf \
  https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf

echo "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597  /opt/regassist-data/llm/models/qwen3-4b-instruct-2507-q4_k_m.gguf" | sha256sum -c
```

3. **Download Embedding & Reranker models & verify SHA-256:**
```bash
# multilingual-e5-small (Embedding)
curl -L -C - --retry 10 -o /opt/regassist-data/llm/models/embeddings/multilingual-e5-small/onnx/model.onnx \
  https://huggingface.co/intfloat/multilingual-e5-small/resolve/main/onnx/model.onnx
curl -L -C - --retry 10 -o /opt/regassist-data/llm/models/embeddings/multilingual-e5-small/tokenizer.json \
  https://huggingface.co/intfloat/multilingual-e5-small/resolve/main/tokenizer.json

echo "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665  /opt/regassist-data/llm/models/embeddings/multilingual-e5-small/onnx/model.onnx" | sha256sum -c
echo "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39  /opt/regassist-data/llm/models/embeddings/multilingual-e5-small/tokenizer.json" | sha256sum -c

# mmarco-mMiniLMv2-L12-H384 (Reranker)
curl -L -C - --retry 10 -o /opt/regassist-data/llm/models/rerankers/mmarco-mMiniLMv2-L12-H384/onnx/model_quint8_avx2.onnx \
  https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/resolve/main/onnx/model_quint8_avx2.onnx
curl -L -C - --retry 10 -o /opt/regassist-data/llm/models/rerankers/mmarco-mMiniLMv2-L12-H384/tokenizer.json \
  https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/resolve/main/tokenizer.json

echo "6c2513767fb63d008a4377bef7a7a3555433d9436342bb53e35a3a72ffc52d4b  /opt/regassist-data/llm/models/rerankers/mmarco-mMiniLMv2-L12-H384/onnx/model_quint8_avx2.onnx" | sha256sum -c
echo "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626  /opt/regassist-data/llm/models/rerankers/mmarco-mMiniLMv2-L12-H384/tokenizer.json" | sha256sum -c
```

4. **Install llama.cpp b11411 (Ubuntu Linux x64) & verify SHA-256:**
```bash
# Download official release tar.gz archive
curl -L -C - --retry 10 -o /tmp/llama-b11411-bin-ubuntu-x64.tar.gz \
  https://github.com/ggml-org/llama.cpp/releases/download/b11411/llama-b11411-bin-ubuntu-x64.tar.gz

# Cryptographic SHA-256 integrity verification
echo "4f0ff85bc63a1df9a3465fa99c78339ac5a2ac0e8dfa864a12d28f3521ff6111  /tmp/llama-b11411-bin-ubuntu-x64.tar.gz" | sha256sum -c

# Extract entire archive including all required shared libraries (.so)
tar -xzf /tmp/llama-b11411-bin-ubuntu-x64.tar.gz --strip-components=1 -C /opt/regassist-data/llm/llama.cpp/b11411/
chmod +x /opt/regassist-data/llm/llama.cpp/b11411/llama-server
echo "b11411" > /opt/regassist-data/llm/llama.cpp/CURRENT_TAG.txt
rm -f /tmp/llama-b11411-bin-ubuntu-x64.tar.gz
```

5. **Copy Corpus Snapshot, Seed Vectors & Set Permissions:**
```bash
# Copy snapshot files
cp -n /opt/regassist-dz/replication/snapshots/corpus_phase4/* /opt/regassist-data/llm/snapshots/corpus_phase4/

# Seed and link runtime vector keys
cd /opt/regassist-dz
python3 -m deploy.ensure_vectors /opt/regassist-data/llm/index

# Set ownership of data root to regassist service user
sudo chown -R regassist:regassist /opt/regassist-data
```

### 4. Virtual Environment & Dependencies
```bash
cd /opt/regassist-dz
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r deploy/requirements-deploy.txt
```

### 5. Service Installation
```bash
sudo cp deploy/systemd/regassist-llm.service /etc/systemd/system/
sudo cp deploy/systemd/regassist-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now regassist-llm.service
sudo systemctl enable --now regassist-web.service
```

### 6. Domain, TLS Certificate, Private Access and Nginx
The domain must already resolve to this server (DNS `A` record) before the certificate is requested.
```bash
cd /opt/regassist-dz
DOMAIN=regassist.example.org     # replace with your own name

# Domain in the nginx site and in the allowed Host / Origin lists of the application
sed -i "s/YOUR_DOMAIN.COM/${DOMAIN}/g" deploy/nginx-regassist.conf
sed -i "s/regassist.example.com/${DOMAIN}/g" deploy/regassist.env
sudo systemctl restart regassist-web.service

# Let's Encrypt certificate (valid 90 days; renewal is not configured here). The stock nginx site also
# claims port 80 as default_server and would make "nginx -t" fail: remove it.
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl stop nginx
sudo certbot certonly --standalone -d "${DOMAIN}"

# Optional private access (skip for the public service): one user, a long random password (write it down, it is shown only here)
openssl rand -base64 18
sudo htpasswd -c /etc/nginx/regassist.htpasswd judge      # prompts twice for that password
sudo chown root:www-data /etc/nginx/regassist.htpasswd && sudo chmod 640 /etc/nginx/regassist.htpasswd

# Site activation (replace YOUR_DOMAIN.COM; for private access also remove the leading '#' of the two auth_basic lines)
sudo sed "s/YOUR_DOMAIN\.COM/${DOMAIN}/g" deploy/nginx-regassist.conf | sudo tee /etc/nginx/sites-available/regassist >/dev/null
# sudo sed -i 's/^    #auth_basic/    auth_basic/' /etc/nginx/sites-available/regassist
sudo ln -sf /etc/nginx/sites-available/regassist /etc/nginx/sites-enabled/regassist
sudo nginx -t && sudo systemctl start nginx

# Firewall: SSH, HTTP (redirect to HTTPS) and HTTPS only
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw --force enable
```

### 7. Verification & Security Tests
```bash
# Verify health endpoint
curl -s http://127.0.0.1:8790/api/health
# Verify readiness & provider status
curl -s http://127.0.0.1:8790/api/status

# Through nginx, public mode: 200 and {"status":"ok"}; private mode: 401 without the password, then 200 with it
curl -s -o /dev/null -w "%{http_code}\n" "https://${DOMAIN}/api/health"
curl -s "https://${DOMAIN}/api/status" | python3 -c 'import sys, json; d = json.load(sys.stdin); print(d["app"]["state"], d["queue"])'
# private mode only: curl -s -u judge "https://${DOMAIN}/api/health"

# Run automated proxy security & spoofing defenses test
bash deploy/test_proxy_security.sh

# Run concurrency and contention test
bash deploy/test_concurrency_and_load.sh
```
Both test scripts target `http://127.0.0.1:8790` (Gunicorn directly, without nginx) unless a URL is given; run them without argument. Through nginx they would need the Basic-auth password.
