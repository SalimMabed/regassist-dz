"""Accès depuis le réseau local : OPTION, désactivée par défaut (docs/LOCAL_DEPLOYMENT.md § Accès réseau).

Par défaut l'application n'écoute que sur 127.0.0.1. Si LOCAL_APP_LAN_IP est défini (par `.\\start_local.ps1 -Lan`), elle écoute AUSSI sur cette adresse privée,
jamais sur toutes les cartes réseau, et exige alors un code d'accès (sauf choix explicite LOCAL_APP_LAN_NO_CODE=1 : accès libre pour tout poste du réseau) :
* le code (8 caractères au minimum) est obligatoire par défaut : sans lui l'application refuse de démarrer ; il n'est jamais écrit dans les journaux ;
* une connexion réussie crée une session aléatoire de 12 h, dans un cookie HttpOnly + SameSite=Strict (le trafic reste en HTTP, sans chiffrement) ;
* 5 codes faux depuis une même adresse bloquent cette adresse 5 minutes ;
* l'en-tête Host doit être l'un des noms de cette machine (garde contre le « DNS rebinding » conservée).
Rien de ceci n'est lu par le moteur gelé.
"""
import hmac
import html
import ipaddress
import os
import secrets
import socket
import threading
import time

LAN_IP_ENV = "LOCAL_APP_LAN_IP"
CODE_ENV = "LOCAL_APP_ACCESS_CODE"
NO_CODE_ENV = "LOCAL_APP_LAN_NO_CODE"       # =1 : accès réseau SANS code (choix explicite ; sans cela, un code est obligatoire)
HOSTS_ENV = "LOCAL_APP_LAN_HOSTS"          # noms supplémentaires acceptés dans l'en-tête Host, séparés par des virgules
MIN_CODE_LEN = 8
MAX_CODE_LEN = 64
SESSION_TTL_S = 12 * 3600
MAX_FAILS = 5
LOCK_S = 300
COOKIE = "regassist_session"


def parse_lan_ip(raw: str) -> str:
    """Adresse IPv4 privée de la carte réseau locale. Refuse la boucle locale, l'adresse inconnue 0.0.0.0, les adresses publiques et locales au lien."""
    try:
        ip = ipaddress.ip_address(raw.strip())
    except ValueError:
        raise SystemExit(f"{LAN_IP_ENV} invalide : {raw!r} (adresse IPv4 attendue)")
    if ip.version != 4 or not ip.is_private or ip.is_loopback or ip.is_unspecified or ip.is_link_local or ip.is_multicast:
        raise SystemExit(f"{LAN_IP_ENV} refusée : {ip} n'est pas une adresse privée d'un réseau local (10.x, 172.16-31.x ou 192.168.x).")
    return str(ip)


def from_env() -> "LanAccess | None":
    raw = os.environ.get(LAN_IP_ENV, "").strip()
    if not raw:
        return None
    code = os.environ.get(CODE_ENV, "").strip()
    extra = [h.strip() for h in os.environ.get(HOSTS_ENV, "").split(",") if h.strip()]
    if not code and os.environ.get(NO_CODE_ENV, "") == "1":      # choix EXPLICITE de l'utilisateur : accès libre pour tout poste du réseau
        return LanAccess(parse_lan_ip(raw), None, extra)
    if len(code) < MIN_CODE_LEN:
        raise SystemExit(f"Mode réseau : un code d'accès d'au moins {MIN_CODE_LEN} caractères est obligatoire ({CODE_ENV}), "
                         f"sauf choix explicite de l'accès libre ({NO_CODE_ENV}=1).")
    if len(code) > MAX_CODE_LEN:
        raise SystemExit(f"Mode réseau : code d'accès trop long ({MAX_CODE_LEN} caractères au plus).")
    return LanAccess(parse_lan_ip(raw), code, extra)


class LanAccess:
    """`code` = None : accès libre (aucune connexion demandée) ; les autres garde-fous (adresse privée, noms d'hôte, origine) restent actifs."""

    def __init__(self, ip: str, code: "str | None", extra_hosts=(), clock=time.monotonic):
        self.ip = ip
        self.open = code is None
        self._code = (code or "").encode("utf-8")
        self._extra = tuple(extra_hosts)
        self._clock = clock
        self._sessions: dict[str, float] = {}
        self._fails: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def hosts(self, port: int) -> set[str]:
        names = {self.ip, socket.gethostname(), socket.getfqdn(), *self._extra}
        return {f"{n.lower()}:{port}" for n in names if n}

    # ----- code d'accès -----
    def locked_for(self, addr: str) -> int:
        """Secondes restantes de blocage pour cette adresse (0 = non bloquée)."""
        with self._lock:
            return self._locked_for(addr)

    def _locked_for(self, addr: str) -> int:
        now = self._clock()
        recent = [t for t in self._fails.get(addr, []) if now - t < LOCK_S]
        if recent:
            self._fails[addr] = recent
        else:
            self._fails.pop(addr, None)
        return int(recent[0] + LOCK_S - now) + 1 if len(recent) >= MAX_FAILS else 0

    def attempt(self, addr: str, code: str):
        """(session_token | None, secondes de blocage). Le code est comparé en temps constant."""
        with self._lock:
            wait = self._locked_for(addr)
            if wait:
                return None, wait
            if hmac.compare_digest(code.strip().encode("utf-8"), self._code):
                self._fails.pop(addr, None)
                now = self._clock()
                self._sessions = {t: exp for t, exp in self._sessions.items() if exp > now}
                token = secrets.token_urlsafe(32)
                self._sessions[token] = now + SESSION_TTL_S
                return token, 0
            self._fails.setdefault(addr, []).append(self._clock())
            if len(self._fails) > 1000:                       # borne mémoire : on oublie les adresses sans blocage en cours
                for a in list(self._fails):
                    if a != addr and not self._locked_for(a):
                        self._fails.pop(a, None)
            return None, self._locked_for(addr)

    def valid(self, token: str | None) -> bool:
        if self.open:
            return True
        if not token:
            return False
        with self._lock:
            exp = self._sessions.get(token)
            if exp is None:
                return False
            if exp <= self._clock():
                self._sessions.pop(token, None)
                return False
            return True


LOGIN_CSP = ("default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def login_page(message: str = "") -> str:
    note = f'<p class="login-error" role="alert">{html.escape(message)}</p>' if message else ""
    return f"""<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assistant juridique - accès</title>
<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="stylesheet" href="login.css">
</head>
<body>
<main class="login-box">
  <p class="login-brand">ASSISTANT JURIDIQUE</p>
  <p class="login-badge">PROJET ÉDUCATIF · NON OFFICIEL</p>
  <p>Cet assistant explore des textes réglementaires publics de la Banque d'Algérie. Il n'est ni affilié à la Banque d'Algérie ni approuvé par elle ; ses réponses
  n'ont pas été validées par un juriste et ne constituent pas un avis juridique.</p>
  <form method="post" action="/login" autocomplete="off">
    <label for="code">Code d'accès</label>
    <input id="code" name="code" type="password" maxlength="{MAX_CODE_LEN}" required autofocus autocomplete="off">
    {note}
    <button type="submit">Entrer</button>
  </form>
  <p class="login-hint">Le code vous a été communiqué par la personne qui met cet assistant à disposition.</p>
</main>
</body>
</html>
"""
