#!/usr/bin/env bash
# ==============================================================================
# deploy/setup_vps.sh - one-command setup of a fresh Ubuntu 24.04 VPS
# ==============================================================================
# Runs steps 1 to 7 of README_DEPLOY.md: packages, service user, data and models,
# Python environment, systemd services, firewall, Let's Encrypt certificate,
# nginx, then checks and one real question through the waiting queue.
#
# Usage, as root, from the clone that MUST live in /opt/regassist-dz:
#   apt-get update && apt-get install -y git
#   git clone https://github.com/SalimMabed/regassist-dz.git /opt/regassist-dz
#   bash /opt/regassist-dz/deploy/setup_vps.sh regassist.example.org [--private]
#
# Access: public by default (anyone with the link; one question is processed at a time and the
# others wait in the queue). With --private, nginx asks for HTTP Basic authentication: the
# password is generated once and written to /root/regassist-access.txt (mode 600); never paste
# it in a chat or an issue.
#
# Prerequisite: a DNS A record for the given name already points to this server.
# certbot asks for an e-mail address and the Let's Encrypt terms: answer it yourself.
# The script can be re-run after a failure: finished steps are detected and skipped.
# ==============================================================================

set -Eeuo pipefail
trap 'echo "ECHEC : ligne ${LINENO}. Corrigez la cause puis relancez la meme commande (les etapes terminees sont ignorees)." >&2' ERR

DOMAIN=""
PRIVATE=0
ACCESS_USER="${ACCESS_USER:-judge}"
REPO="/opt/regassist-dz"
DATA="/opt/regassist-data"
LLM="${DATA}/llm"
SVC_USER="regassist"
HTPASSWD="/etc/nginx/regassist.htpasswd"
CRED_FILE="/root/regassist-access.txt"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

step() { printf '\n== [%s] %s\n' "$1" "$2"; }
warn() { printf 'ATTENTION : %s\n' "$*" >&2; }
die()  { printf 'ERREUR : %s\n' "$*" >&2; trap - ERR; exit 1; }

for arg in "$@"; do
    case "${arg}" in
        --private) PRIVATE=1 ;;
        -*) die "option inconnue : ${arg} (seule --private existe)." ;;
        *) DOMAIN="${arg}" ;;
    esac
done

# ---- 0. Preconditions -------------------------------------------------------
step 0 "Controles prealables"
[[ $EUID -eq 0 ]] || die "a lancer en root (sudo -i)."
[[ -n "${DOMAIN}" ]] || die "usage : bash deploy/setup_vps.sh <nom-de-domaine> [--private]"
[[ "${DOMAIN}" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "nom de domaine invalide : '${DOMAIN}'."
[[ "${REPO_ROOT}" == "${REPO}" ]] || die "le depot doit etre clone dans ${REPO} (les unites systemd utilisent ce chemin) ; il est dans ${REPO_ROOT}."

# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}-${VERSION_ID:-}" == "ubuntu-24.04" ]] || warn "systeme ${PRETTY_NAME:-inconnu} : le guide cible Ubuntu 24.04 LTS."

if grep -qw avx2 /proc/cpuinfo; then
    has_avx2="oui"
else
    has_avx2="NON"
    warn "processeur sans AVX2 ($(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo)) : le reranker ONNX et llama.cpp fonctionnent en general sans AVX2 mais plus lentement, et les rangs peuvent differer legerement. Le temps de reponse est mesure en fin d'installation."
fi
mem_kb="$(awk '/^MemTotal/ {print $2}' /proc/meminfo)"
(( mem_kb >= 6000000 )) || die "memoire insuffisante ($((mem_kb / 1024)) Mo) : 8 Go recommandes."
(( mem_kb >= 7000000 )) || warn "memoire juste ($((mem_kb / 1024)) Mo) : 8 Go recommandes."
avail_gb="$(df -BG --output=avail /opt | tail -n 1 | tr -dc '0-9')"
(( avail_gb >= 12 )) || die "espace disque insuffisant (${avail_gb} Go libres sur /opt) : 12 Go necessaires."

resolved="$(getent ahostsv4 "${DOMAIN}" | awk 'NR==1 {print $1}')"
[[ -n "${resolved}" ]] || die "${DOMAIN} ne se resout pas : creez l'enregistrement DNS A vers l'adresse IP de ce serveur, attendez sa propagation, relancez."
hostname -I | tr ' ' '\n' | grep -qx "${resolved}" || warn "${DOMAIN} -> ${resolved}, qui n'est pas une adresse de ce serveur (NAT ?) : le certificat echouera si ce n'est pas son adresse publique."
echo "OK : AVX2 ${has_avx2}, $((mem_kb / 1024)) Mo de memoire, ${avail_gb} Go libres, ${DOMAIN} -> ${resolved}"

# ---- 1. Packages and service user -------------------------------------------
step 1 "Paquets, utilisateur de service, droits d'execution"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip nginx curl libgomp1 git certbot apache2-utils ufw openssl ca-certificates fail2ban
id "${SVC_USER}" >/dev/null 2>&1 || useradd -r -s /bin/false "${SVC_USER}"
mkdir -p "${LLM}" /var/log/regassist
# Git keeps these scripts as 100644 when they were committed from Windows; systemd needs them executable.
find "${REPO}/deploy" -name '*.sh' -exec chmod +x {} +

# ---- 2. Python environment (before the data step: ensure_vectors needs numpy) ---------------------------------------------------
step 2 "Environnement Python"
if [[ ! -x "${REPO}/.venv/bin/gunicorn" ]]; then
    python3 -m venv "${REPO}/.venv"
    "${REPO}/.venv/bin/pip" install --upgrade pip
    "${REPO}/.venv/bin/pip" install -r "${REPO}/deploy/requirements-deploy.txt"
fi

# ---- 3. Models, index and corpus snapshot -----------------------------------
step 3 "Donnees et modeles (environ 3 Go, verifies par SHA-256)"
bash "${REPO}/deploy/populate_data_linux.sh" "${LLM}"
for f in "${LLM}/models/qwen3-4b-instruct-2507-q4_k_m.gguf" \
         "${LLM}/llama.cpp/b11411/llama-server" \
         "${LLM}/models/embeddings/multilingual-e5-small/onnx/model.onnx" \
         "${LLM}/models/rerankers/mmarco-mMiniLMv2-L12-H384/onnx/model_quint8_avx2.onnx"; do
    [[ -s "${f}" ]] || die "fichier manquant apres l'initialisation des donnees : ${f}"
done
chown -R "${SVC_USER}:${SVC_USER}" "${REPO}" "${DATA}" /var/log/regassist

# ---- 4. Domain in the application's allowed hosts, then services -------------
step 4 "Services systemd (LLM puis application)"
sed -i "s/regassist\.example\.com/${DOMAIN}/g" "${REPO}/deploy/regassist.env"
grep -q "^REGASSIST_ALLOWED_HOSTS=.*${DOMAIN}" "${REPO}/deploy/regassist.env" || die "le domaine n'a pas ete inscrit dans deploy/regassist.env."
install -m 644 "${REPO}/deploy/systemd/regassist-llm.service" /etc/systemd/system/regassist-llm.service
install -m 644 "${REPO}/deploy/systemd/regassist-web.service" /etc/systemd/system/regassist-web.service
systemctl daemon-reload
systemctl enable regassist-llm.service regassist-web.service
systemctl restart regassist-llm.service regassist-web.service

wait_http() {   # wait_http <url> <seconds>
    local url="$1" max="$2" i
    for (( i = 0; i < max; i += 3 )); do
        curl -fsS -o /dev/null --max-time 3 "${url}" 2>/dev/null && return 0
        sleep 3
    done
    return 1
}
wait_http "http://127.0.0.1:8187/health" 300 || { journalctl -u regassist-llm -n 30 --no-pager || true; die "le LLM ne repond pas sur 127.0.0.1:8187."; }
wait_http "http://127.0.0.1:8790/api/health" 300 || { journalctl -u regassist-web -n 30 --no-pager || true; die "l'application ne repond pas sur 127.0.0.1:8790."; }
echo "OK : LLM et application repondent en local."

# ---- 5. Firewall, certificate, private access, nginx -------------------------
step 5 "Pare-feu, certificat Let's Encrypt, nginx"
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}')"
SSH_PORT="${SSH_PORT:-22}"
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
echo "OK : pare-feu actif (SSH ${SSH_PORT}, 80, 443)."
systemctl enable --now fail2ban >/dev/null     # default jail: bans addresses that repeatedly fail SSH logins
echo "OK : fail2ban actif (blocage des adresses qui multiplient les essais SSH)."

rm -f /etc/nginx/sites-enabled/default      # the stock site also claims port 80 as default_server
systemctl stop nginx
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    echo "certbot va demander une adresse e-mail et l'acceptation des conditions de Let's Encrypt."
    certbot certonly --standalone -d "${DOMAIN}"
fi

NEW_PASS=0
if (( PRIVATE )) && [[ ! -s "${HTPASSWD}" ]]; then
    PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
    printf '%s:%s\n' "${ACCESS_USER}" "$(printf '%s' "${PASS}" | openssl passwd -apr1 -stdin)" > "${HTPASSWD}"
    chown root:www-data "${HTPASSWD}"
    chmod 640 "${HTPASSWD}"
    ( umask 077; printf 'identifiant : %s\nmot de passe : %s\nadresse : https://%s/\n' "${ACCESS_USER}" "${PASS}" "${DOMAIN}" > "${CRED_FILE}" )
    NEW_PASS=1
fi

sed "s/YOUR_DOMAIN\.COM/${DOMAIN}/g" "${REPO}/deploy/nginx-regassist.conf" > /etc/nginx/sites-available/regassist
if (( PRIVATE )); then sed -i 's/^    #auth_basic/    auth_basic/' /etc/nginx/sites-available/regassist; fi
ln -sf /etc/nginx/sites-available/regassist /etc/nginx/sites-enabled/regassist
nginx -t
systemctl enable nginx
systemctl start nginx

# ---- 6. Checks and one real question through the waiting queue --------------
step 6 "Verifications"
code_http="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://${DOMAIN}/" || true)"
code_noauth="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/health" || true)"
code_auth="n/a"; auth_env=""
if (( PRIVATE )) && [[ -r "${CRED_FILE}" ]]; then
    PASS="$(awk -F' : ' '/^mot de passe/ {print $2}' "${CRED_FILE}")"
    ACCESS_USER="$(awk -F' : ' '/^identifiant/ {print $2}' "${CRED_FILE}")"
    auth_env="${ACCESS_USER}:${PASS}"
    code_auth="$(printf 'user = "%s"\n' "${auth_env}" | curl -s -K - -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/health" || true)"
fi
t0="$(date +%s)"
smoke="$(RA_AUTH="${auth_env}" python3 - "https://${DOMAIN}" <<'PY' 2>&1
import base64, json, os, sys, time, urllib.request
base = sys.argv[1]
hdr = {"Content-Type": "application/json"}
if os.environ.get("RA_AUTH"):
    hdr["Authorization"] = "Basic " + base64.b64encode(os.environ["RA_AUTH"].encode()).decode()
def call(path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=hdr)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)
q = call("/api/status").get("queue", {})
t0 = time.time()
v = call("/api/queue", {"question": "Quel est le plafond d'indemnisation par déposant ?"})
while v["state"] in ("queued", "running") and time.time() - t0 < 290:
    time.sleep(2)
    v = call("/api/queue/" + v["ticket"])
d = v.get("result") or {}
print("file=%s etat=%s status=%s sources=%d citations=%d generation_ms=%s" % ("active" if q.get("enabled") else "ABSENTE", v["state"], d.get("status"), len(d.get("sources", [])), len(d.get("citations", [])), d.get("durations_ms", {}).get("generation")))
PY
)" || smoke="echec"
smoke="${smoke} duree_totale_s=$(( $(date +%s) - t0 ))"

cpu_model="$(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo)"
root_rota="$(lsblk -dno ROTA "$(df --output=source / | tail -n 1)" 2>/dev/null || echo '?')"
if (( PRIVATE )); then
    mode_txt="prive (mot de passe nginx)"; expect_noauth="401"
else
    mode_txt="public (sans mot de passe), file d'attente"; expect_noauth="200"
fi
cat <<EOF

================ RESULTAT (sans secret : vous pouvez le coller dans le chat) ================
systeme              : ${PRETTY_NAME:-?}
processeur           : ${cpu_model} ($(nproc) coeurs, AVX2 ${has_avx2})
memoire              : $((mem_kb / 1024)) Mo
disque racine        : ${avail_gb} Go libres au depart, rotatif=${root_rota} (0 = SSD)
domaine              : ${DOMAIN} -> ${resolved}
acces                : ${mode_txt}
HTTP -> HTTPS        : ${code_http} (attendu 301)
HTTPS sans mot de passe : ${code_noauth} (attendu ${expect_noauth})
HTTPS avec mot de passe : ${code_auth} (attendu 200 si prive, n/a sinon)
question reelle      : ${smoke}
=============================================================================================
EOF
if (( PRIVATE )); then
    if (( NEW_PASS )); then
        echo "Identifiants d'acces crees. Pour les lire (ne les collez jamais dans un chat) : cat ${CRED_FILE}"
    else
        echo "Identifiants d'acces deja existants : ${CRED_FILE} (supprimez ${HTPASSWD} puis relancez pour en generer de nouveaux)."
    fi
    echo "Ce service expose un assistant juridique NON valide (NO-GO provisoire) : ne diffusez l'acces qu'aux evaluateurs."
else
    echo "Adresse publique : https://${DOMAIN}/ - une seule question est traitee a la fois, les autres attendent dans la file."
    echo "Ce service expose un assistant juridique NON valide (NO-GO provisoire) : le bandeau de l'interface le rappelle."
fi
