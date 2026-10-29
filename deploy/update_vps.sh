#!/usr/bin/env bash
# ==============================================================================
# deploy/update_vps.sh - bring an already installed server up to the latest main
# ==============================================================================
# Pulls the repository, refreshes the Python environment only if its requirements changed,
# restarts the web application (the language model is NOT reloaded) and regenerates the nginx
# site from deploy/nginx-regassist.conf, then checks the result. No model download.
#
# Usage, as root:
#   bash /opt/regassist-dz/deploy/update_vps.sh [--public | --private]
#
# Access mode: --public removes the nginx password, --private (re)enables it (the password file
# created by setup_vps.sh --private must exist). Without an option, the current mode is kept.
# The domain is read from the installed nginx site. Re-runnable at any time.
# ==============================================================================

set -Eeuo pipefail
trap 'echo "ECHEC : ligne ${LINENO}. Corrigez la cause puis relancez la meme commande." >&2' ERR

REPO="/opt/regassist-dz"
SVC_USER="regassist"
CONF="/etc/nginx/sites-available/regassist"
HTPASSWD="/etc/nginx/regassist.htpasswd"
MODE=""

step() { printf '\n== [%s] %s\n' "$1" "$2"; }
die()  { printf 'ERREUR : %s\n' "$*" >&2; trap - ERR; exit 1; }
# The clone is owned by the service user: root needs git's safe.directory exception.
g() { git -c "safe.directory=${REPO}" -C "${REPO}" "$@"; }

for arg in "$@"; do
    case "${arg}" in
        --public) MODE="public" ;;
        --private) MODE="private" ;;
        *) die "option inconnue : ${arg} (--public ou --private)." ;;
    esac
done

step 0 "Controles prealables"
[[ $EUID -eq 0 ]] || die "a lancer en root."
[[ -d "${REPO}/.git" ]] || die "depot introuvable dans ${REPO} : installez d'abord avec setup_vps.sh."
[[ -f "${CONF}" ]] || die "site nginx introuvable (${CONF}) : installez d'abord avec setup_vps.sh."
DOMAIN="$(awk '$1 == "server_name" && $2 != "_;" {gsub(";", "", $2); print $2; exit}' "${CONF}")"
[[ -n "${DOMAIN}" ]] || die "domaine introuvable dans ${CONF}."
if [[ -z "${MODE}" ]]; then
    if grep -Eq '^[[:space:]]+auth_basic ' "${CONF}"; then MODE="private"; else MODE="public"; fi
fi
if [[ "${MODE}" == "private" && ! -s "${HTPASSWD}" ]]; then
    die "mode prive demande mais ${HTPASSWD} est absent : lancez setup_vps.sh ${DOMAIN} --private."
fi
echo "OK : domaine ${DOMAIN}, acces ${MODE}."

step 1 "Mise a jour du depot"
OLD="$(g rev-parse HEAD)"
g checkout -- deploy/regassist.env                 # the domain was written into this tracked file by setup_vps.sh: restored, then written again below
g pull --ff-only
NEW="$(g rev-parse HEAD)"
sed -i "s/regassist\.example\.com/${DOMAIN}/g" "${REPO}/deploy/regassist.env"
grep -q "^REGASSIST_ALLOWED_HOSTS=.*${DOMAIN}" "${REPO}/deploy/regassist.env" || die "le domaine n'a pas ete inscrit dans deploy/regassist.env."
find "${REPO}/deploy" -name '*.sh' -exec chmod +x {} +
echo "OK : ${OLD:0:7} -> ${NEW:0:7}"
if [[ "${OLD}" != "${NEW}" ]] && g diff --name-only "${OLD}" "${NEW}" -- deploy/requirements-deploy.txt | grep -q .; then
    echo "requirements-deploy.txt a change : mise a jour de l'environnement Python."
    "${REPO}/.venv/bin/pip" install -r "${REPO}/deploy/requirements-deploy.txt"
fi
chown -R "${SVC_USER}:${SVC_USER}" "${REPO}"

step 2 "Application (le modele de langage n'est pas recharge)"
install -m 644 "${REPO}/deploy/systemd/regassist-web.service" /etc/systemd/system/regassist-web.service
systemctl daemon-reload
systemctl restart regassist-web.service

step 3 "nginx (acces ${MODE})"
BACKUP="/root/nginx-regassist.conf.$(date +%Y%m%d-%H%M%S).bak"
cp "${CONF}" "${BACKUP}"
sed "s/YOUR_DOMAIN\.COM/${DOMAIN}/g" "${REPO}/deploy/nginx-regassist.conf" > "${CONF}"
if [[ "${MODE}" == "private" ]]; then sed -i 's/^    #auth_basic/    auth_basic/' "${CONF}"; fi
if ! nginx -t; then
    cp "${BACKUP}" "${CONF}"
    die "configuration nginx invalide : ancienne configuration restauree (${BACKUP})."
fi
systemctl reload nginx

step 4 "Verifications"
app_state() {
    curl -fsS --max-time 3 http://127.0.0.1:8790/api/status 2>/dev/null \
        | python3 -c 'import sys, json; print(json.load(sys.stdin)["app"]["state"])' 2>/dev/null || echo "down"
}
wait_ready() {   # the warm-up takes about a minute ("starting" -> "ready")
    local i s
    for (( i = 0; i < 240; i += 3 )); do
        s="$(app_state)"
        [[ "${s}" == "ready" || "${s}" == "degraded" || "${s}" == "error" ]] && return 0
        sleep 3
    done
    return 1
}
wait_ready || { journalctl -u regassist-web -n 30 --no-pager || true; die "l'application n'est pas prete apres 4 minutes."; }
app="$(app_state)"
code_http="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://${DOMAIN}/" || true)"
code_noauth="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/health" || true)"
queue="$(curl -s --max-time 15 "https://${DOMAIN}/api/status" | python3 -c 'import sys, json
try:
    q = json.load(sys.stdin).get("queue", {})
    print("active (max %s)" % q.get("max") if q.get("enabled") else "ABSENTE")
except Exception:
    print("non verifiee (acces protege ?)")' 2>/dev/null || echo "non verifiee")"
greeting="$(curl -s --max-time 60 -H 'Content-Type: application/json' -d '{"question":"bonjour"}' "https://${DOMAIN}/api/queue" | python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    print("etat=%s status=%s" % (d.get("state"), (d.get("result") or {}).get("status")))
except Exception:
    print("non verifiee (acces protege ?)")' 2>/dev/null || echo "non verifiee")"
if [[ "${MODE}" == "private" ]]; then expect_noauth="401"; else expect_noauth="200"; fi
cat <<EOF

================ RESULTAT (sans secret : vous pouvez le coller dans le chat) ================
domaine              : ${DOMAIN}
acces                : ${MODE}
version              : ${NEW:0:7}
application          : ${app} (attendu ready)
HTTP -> HTTPS       : ${code_http} (attendu 301)
HTTPS sans mot de passe : ${code_noauth} (attendu ${expect_noauth})
file d'attente       : ${queue}
salutation via la file  : ${greeting} (attendu etat=done status=smalltalk)
=============================================================================================
Essayez ensuite une vraie question dans le navigateur : https://${DOMAIN}/
EOF
