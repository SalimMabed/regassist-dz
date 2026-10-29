"""Application Flask locale : API JSON + interface statique servies par le MÊME serveur, donc une seule origine (http://127.0.0.1:PORT).

Conséquences de sécurité :
* aucune requête inter-origines n'est nécessaire, donc AUCUN en-tête CORS n'est jamais émis (le navigateur refuse toute lecture depuis un autre site) ;
* l'en-tête Host doit être 127.0.0.1:PORT ou localhost:PORT (protège contre le « DNS rebinding ») et Origin, s'il est présent, doit être cette même origine ;
  en mode réseau OPTIONNEL (lan.py, désactivé par défaut) s'y ajoutent les noms de cette machine, et un code d'accès est exigé ;
* la politique CSP n'autorise que les fichiers de l'application : pas de CDN, pas de script distant, pas de connexion vers un autre hôte.
"""
import collections
import os
import re
import socket
import threading
import time

from flask import Flask, jsonify, make_response, redirect, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.serving import ThreadedWSGIServer

from . import config as C
from . import lan as L
from . import smalltalk, waitqueue, webpush
from .service import Service, ServiceError, check_environment, setup_logging, validate_payload

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'")
_PAGES = {"": "index.html", "index.html": "index.html", "app.css": "app.css", "app.js": "app.js", "favicon.svg": "favicon.svg", "login.css": "login.css",
          "game.js": "game.js", "sw.js": "sw.js"}
# Mode réseau seulement : ce qui reste accessible sans code d'accès (la page d'accès et ses ressources, la sonde de vie qui ne renvoie que « ok »).
_PUBLIC_IN_LAN = {"/login", "/login.css", "/favicon.svg", "/favicon.ico", "/api/health"}
_TICKET = re.compile(r"[A-Za-z0-9_-]{16,64}")


class RateLimiter:
    """Limiteur de requêtes en mémoire par adresse IP (fenêtre glissante avec élagage actif et capacité bornée)."""

    def __init__(self, max_requests: int = 10, window_s: int = 60, max_ips: int = 4096):
        self.max_requests = max_requests
        self.window_s = window_s
        self.max_ips = max_ips
        self.lock = threading.Lock()
        self.history: collections.OrderedDict[str, list[float]] = collections.OrderedDict()
        self._last_prune = time.time()

    def is_allowed(self, client_ip: str) -> tuple[bool, int]:
        now = time.time()
        cutoff = now - self.window_s
        with self.lock:
            # 1. Élagage périodique ou déclenché par seuil de taille
            if now - self._last_prune >= self.window_s or len(self.history) >= 256:
                expired = [ip for ip, times in self.history.items() if not times or times[-1] <= cutoff]
                for ip in expired:
                    del self.history[ip]
                self._last_prune = now

            # 2. Vérification et élagage de l'IP courante
            times = self.history.get(client_ip)
            if times:
                while times and times[0] <= cutoff:
                    times.pop(0)
                if not times:
                    del self.history[client_ip]
                    times = None

            if times and len(times) >= self.max_requests:
                retry_after = max(1, int(times[0] + self.window_s - now))
                return False, retry_after

            # 3. Insertion / mise à jour avec protection anti-saturation (LRU eviction)
            if client_ip not in self.history:
                if len(self.history) >= self.max_ips:
                    self.history.popitem(last=False)
                self.history[client_ip] = [now]
            else:
                times.append(now)
                self.history.move_to_end(client_ip)

            return True, 0

    def prune(self, now: float | None = None):
        """Élagage explicite des entrées expirées (utile pour les tests et la maintenance)."""
        now = time.time() if now is None else now
        cutoff = now - self.window_s
        with self.lock:
            expired = [ip for ip, times in self.history.items() if not times or times[-1] <= cutoff]
            for ip in expired:
                del self.history[ip]
            self._last_prune = now

    def reset(self):
        with self.lock:
            self.history.clear()
            self._last_prune = time.time()


def extract_client_ip(req, mode: str) -> str:
    """Résout l'adresse IP cliente pour le rate limiting.
    Ne fait confiance aux en-têtes X-Real-IP et X-Forwarded-For QUE si le pair direct du socket
    est la boucle locale (127.0.0.1 ou ::1) ET que l'application s'exécute en mode production.
    Dans tous les autres cas (mode local, mode LAN, ou connexion directe sans proxy), l'adresse
    du pair direct (req.remote_addr) est strictement utilisée."""
    peer = (req.remote_addr or "").strip()
    if not peer:
        peer = "127.0.0.1"

    if mode == "production" and peer in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        forwarded = (req.headers.get("X-Real-IP") or "").strip()
        if not forwarded:
            xff = req.headers.get("X-Forwarded-For", "")
            if xff:
                forwarded = xff.split(",")[-1].strip()
        if forwarded:
            clean = forwarded[:64]
            if clean:
                return clean
    return peer


def create_app(service: Service, port: int | None = None, lan: "L.LanAccess | None" = None,
               deploy_mode: str | None = None, allowed_hosts: str | None = None,
               allowed_origins: str | None = None, rate_limiter: RateLimiter | None = None, wait_queue: "waitqueue.WaitQueue | None" = None) -> Flask:
    """`lan` = None (défaut) : application locale, 127.0.0.1 seulement. `lan` fourni : accès réseau avec code d'accès (voir lan.py).
    `wait_queue` : file d'attente des questions (voir waitqueue.py) ; sinon construite d'après REGASSIST_QUEUE_MAX (active par défaut en production seulement)."""
    port = port or C.port()
    mode = (deploy_mode or os.environ.get("REGASSIST_DEPLOY_MODE", "local")).strip().lower()
    if mode == "production":
        raw_hosts = allowed_hosts if allowed_hosts is not None else os.environ.get("REGASSIST_ALLOWED_HOSTS", "")
        raw_origins = allowed_origins if allowed_origins is not None else os.environ.get("REGASSIST_ALLOWED_ORIGINS", "")
        hosts = {h.strip().lower() for h in raw_hosts.split(",") if h.strip() and h.strip() != "*"}
        origins = {o.strip() for o in raw_origins.split(",") if o.strip() and o.strip() != "*"}
    else:
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if lan is not None:
            hosts |= lan.hosts(port)
        origins = {f"http://{h}" for h in hosts}
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = C.MAX_BODY_BYTES
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    default_limit = "10" if mode == "production" else "120"
    limiter = rate_limiter or RateLimiter(
        max_requests=int(os.environ.get("REGASSIST_RATE_LIMIT", default_limit)),
        window_s=int(os.environ.get("REGASSIST_RATE_WINDOW", "60")),
    )
    app.rate_limiter = limiter
    app.deploy_mode = mode
    app.wait_queue = wait_queue if wait_queue is not None else waitqueue.from_env(service.chat, mode, log=service.log)

    def err(http: int, code: str, message: str):
        r = jsonify({"error": {"code": code, "message": message}})
        r.status_code = http
        return r

    @app.before_request
    def guard():
        req_host = request.host.lower()
        if mode == "production":
            host_no_port = req_host.split(":")[0]
            if req_host not in hosts and host_no_port not in hosts:
                return err(403, "forbidden_host", "Accès refusé : hôte non autorisé.")
            origin = request.headers.get("Origin")
            if origin is not None and origin not in origins:
                return err(403, "forbidden_origin", "Accès refusé : origine non autorisée.")
        else:
            if req_host not in hosts:
                if lan is not None:
                    return err(403, "forbidden_host", "Accès refusé : utilisez l'adresse qui vous a été communiquée.")
                return err(403, "forbidden_host", "Accès refusé : cette application n'est accessible que via http://127.0.0.1:%d." % port)
            origin = request.headers.get("Origin")
            if origin is not None and origin not in origins:
                return err(403, "forbidden_origin", "Accès refusé : origine non autorisée.")
        if request.path.startswith("/api/") and request.headers.get("Sec-Fetch-Site", "same-origin") in ("cross-site", "same-site"):
            return err(403, "forbidden_origin", "Accès refusé : origine non autorisée.")
        if lan is not None and request.path not in _PUBLIC_IN_LAN and not lan.valid(request.cookies.get(L.COOKIE)):
            if request.path.startswith("/api/"):
                return err(401, "auth_required", "Session expirée ou absente : rechargez la page et saisissez le code d'accès.")
            return redirect("/login", code=302)
        return None

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if lan is None:
            return err(404, "not_found", "Ressource introuvable.")
        if lan.open:                                         # accès libre choisi explicitement : pas de page de connexion
            return redirect("/", code=302)
        if request.method == "GET":
            r = make_response(L.login_page())
        else:
            addr = request.remote_addr or "?"
            token, wait = lan.attempt(addr, request.form.get("code", ""))
            if token:
                service.log("login_ok", addr=addr)
                r = redirect("/", code=303)
                r.set_cookie(L.COOKIE, token, max_age=L.SESSION_TTL_S, httponly=True, samesite="Strict", path="/")
                return r
            service.log("login_failed", addr=addr, locked_s=wait or None)
            if wait:
                r = make_response(L.login_page("Trop d'essais. Réessayez dans %d minute(s)." % max(1, -(-wait // 60))), 429)
            else:
                r = make_response(L.login_page("Code d'accès incorrect."), 401)
        r.headers["Content-Type"] = "text/html; charset=utf-8"
        return r

    @app.after_request
    def headers(resp):
        resp.headers["Content-Security-Policy"] = L.LOGIN_CSP if request.path == "/login" else CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        resp.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") or request.path == "/login" else "no-cache"
        return resp

    @app.errorhandler(ServiceError)
    def service_error(e):
        resp = err(e.http, e.code, e.message)
        if e.http == 429:
            resp.headers["Retry-After"] = "30"
        return resp

    @app.errorhandler(HTTPException)
    def http_error(e):
        messages = {404: "Ressource introuvable.", 405: "Méthode non autorisée.", 413: "Requête trop volumineuse.", 415: "Type de contenu non pris en charge : JSON attendu.", 429: "Trop de requêtes."}
        code = e.code or 500
        resp = err(code, {404: "not_found", 405: "method_not_allowed", 413: "payload_too_large", 415: "unsupported_media_type", 429: "busy"}.get(code, "http_error"),
                   messages.get(code, "Requête non valide."))
        if code == 429:
            resp.headers["Retry-After"] = "30"
        return resp

    @app.errorhandler(Exception)
    def unexpected(e):
        service.log("unhandled_error", error_type=type(e).__name__)
        return err(500, "internal_error", "Une erreur est survenue. Réessayez dans un instant.")

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @app.get("/api/status")
    def status():
        out = service.status()
        out["queue"] = app.wait_queue.snapshot() if app.wait_queue is not None else {"enabled": False}
        return jsonify(out)

    @app.post("/api/chat")
    def chat():
        client_ip = extract_client_ip(request, mode)
        allowed, retry_after = app.rate_limiter.is_allowed(client_ip)
        if not allowed:
            resp = err(429, "rate_limited", f"Trop de requêtes. Veuillez patienter {retry_after} seconde(s).")
            resp.headers["Retry-After"] = str(retry_after)
            return resp

        if request.mimetype != "application/json":
            return err(415, "unsupported_media_type", "Type de contenu non pris en charge : JSON attendu.")
        data = request.get_json(silent=True)
        if data is None:
            return err(400, "invalid_json", "Le corps de la requête n'est pas un JSON valide.")
        return jsonify(service.chat(data))

    # ----- file d'attente (déploiement public ; voir waitqueue.py) -----
    @app.post("/api/queue")
    def queue_submit():
        if app.wait_queue is None:
            return err(404, "not_found", "Ressource introuvable.")
        client_ip = extract_client_ip(request, mode)
        allowed, retry_after = app.rate_limiter.is_allowed(client_ip)
        if not allowed:
            resp = err(429, "rate_limited", f"Trop de requêtes. Veuillez patienter {retry_after} seconde(s).")
            resp.headers["Retry-After"] = str(retry_after)
            return resp
        if request.mimetype != "application/json":
            return err(415, "unsupported_media_type", "Type de contenu non pris en charge : JSON attendu.")
        data = request.get_json(silent=True)
        if data is None:
            return err(400, "invalid_json", "Le corps de la requête n'est pas un JSON valide.")
        q = validate_payload(data)                                                   # refus immédiat d'une question invalide : elle n'entre jamais dans la file
        if smalltalk.classify(q) is not None:                                        # salutation : réponse immédiate, sans attendre derrière les vraies questions
            return jsonify({"ticket": None, "state": "done", "ahead": 0, "position": 0, "waiting": app.wait_queue.snapshot()["waiting"], "eta_s": 0,
                            "result": service.chat(data), "error": None})
        if service.warming():
            raise ServiceError(503, "warming_up", "Le service démarre. Réessayez dans quelques secondes.")
        kw = {"key": request.headers.get("Idempotency-Key")} if getattr(app.wait_queue, "persistent", False) else {}      # la clé d'envoi évite les doublons après une coupure réseau
        return jsonify(app.wait_queue.submit(data, client_ip, **kw)), 202

    @app.get("/api/queue/<ticket>")
    def queue_view(ticket):
        view = app.wait_queue.view(ticket) if app.wait_queue is not None and _TICKET.fullmatch(ticket) else None
        if view is None:
            return err(404, "ticket_unknown", "Cette question n'est plus dans la file (délai dépassé ou annulation). Posez-la de nouveau.")
        return jsonify(view)

    @app.post("/api/queue/<ticket>/push")
    def queue_push(ticket):
        """Abonnement Web Push du navigateur, attaché à cette demande (file persistante et notifications activées seulement)."""
        q = app.wait_queue
        push = (q.snapshot().get("push") or {}) if q is not None and getattr(q, "persistent", False) else {}
        if not push.get("enabled"):
            return err(404, "not_found", "Ressource introuvable.")
        client_ip = extract_client_ip(request, mode)
        allowed, retry_after = app.rate_limiter.is_allowed(client_ip)
        if not allowed:
            resp = err(429, "rate_limited", f"Trop de requêtes. Veuillez patienter {retry_after} seconde(s).")
            resp.headers["Retry-After"] = str(retry_after)
            return resp
        if request.mimetype != "application/json":
            return err(415, "unsupported_media_type", "Type de contenu non pris en charge : JSON attendu.")
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) != {"subscription"}:
            return err(400, "invalid_request", "Corps JSON attendu : {\"subscription\": {...}}.")
        try:
            sub = webpush.validate_subscription(data["subscription"])
        except (ValueError, TypeError):
            return err(400, "invalid_subscription", "Abonnement aux notifications non reconnu.")
        if not _TICKET.fullmatch(ticket):
            return err(404, "ticket_unknown", "Cette question n'est plus dans la file (délai dépassé ou annulation). Posez-la de nouveau.")
        res = q.add_push(ticket, sub)
        if res == "unknown":
            return err(404, "ticket_unknown", "Cette question n'est plus dans la file (délai dépassé ou annulation). Posez-la de nouveau.")
        if res == "finished":
            return err(409, "already_finished", "La réponse est déjà prête : ouvrez le suivi pour la lire.")
        if res == "limit":
            return err(429, "push_limit", "Trop d'appareils déjà abonnés pour cette question.")
        return jsonify({"subscribed": True}), 201

    @app.post("/api/queue/<ticket>/cancel")
    def queue_cancel(ticket):
        ok = app.wait_queue is not None and bool(_TICKET.fullmatch(ticket)) and app.wait_queue.cancel(ticket)
        return jsonify({"cancelled": ok})

    @app.get("/favicon.ico")
    def favicon_ico():
        return "", 204

    @app.get("/", defaults={"name": ""})
    @app.get("/<path:name>")
    def static_files(name):
        if name not in _PAGES:
            return err(404, "not_found", "Ressource introuvable.")
        return send_from_directory(C.STATIC_DIR, _PAGES[name], max_age=0)

    return app


class LocalServer(ThreadedWSGIServer):
    """Serveur WSGI multi-fil lié à 127.0.0.1, sans partage de port (sous Windows, SO_REUSEADDR laisserait un autre programme se lier au même port)."""
    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_servers(app: Flask, port: int, lan_ip: str | None = None) -> list:
    """Serveur de la boucle locale (toujours) + serveur de l'adresse réseau privée (mode réseau seulement). Jamais 0.0.0.0 : les autres cartes
    (VMware, Hyper-V…) ne sont pas exposées. Si la seconde liaison échoue, la première est refermée et l'erreur remonte."""
    servers = []
    try:
        for host in (C.HOST, lan_ip):
            if host:
                servers.append(LocalServer(host, port, app))
    except (OSError, SystemExit):                      # werkzeug appelle sys.exit(1) quand l'adresse est déjà occupée : on le convertit en OSError
        for s in servers:
            s.server_close()
        raise OSError(f"liaison impossible sur {host}:{port}") from None
    return servers


def port_in_use(port: int, host: str | None = None) -> bool:
    try:
        with socket.create_connection((host or C.HOST, port), timeout=0.5):
            return True
    except OSError:
        return False
