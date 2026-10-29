"""File d'attente PERSISTANTE : le visiteur peut fermer la page, revenir plus tard avec son lien personnel et lire la réponse.

Même interface que `waitqueue.WaitQueue` (submit / view / cancel / snapshot) et même principe de fonctionnement (une seule question traitée à la fois, par un
thread de travail qui appelle `Service.chat`, exactement comme POST /api/chat), mais les demandes vivent dans SQLite (bibliothèque standard, mode WAL) :
* elles survivent à un redémarrage du service : en attente = reprises dans l'ordre ; en cours au moment de l'arrêt = remises en file une fois, puis en erreur ;
* une page fermée ne libère plus la place (c'est le but) ; seuls la suppression explicite et le délai de conservation retirent une demande ;
* confidentialité : le lien personnel est un secret de 128 bits dont seule l'empreinte SHA-256 est stockée ; l'adresse IP n'est conservée que salée et hachée
  (limites par adresse) ; demande « inexistante » et « à un autre » sont indiscernables (view renvoie None) ;
* double envoi : la clé d'idempotence choisie par le navigateur donne toujours le même lien (dérivé par HMAC), donc aucun doublon après une coupure réseau ;
* notification : un abonnement Web Push est attaché à UNE demande, utilisé une fois (réponse prête) puis supprimé.
La question et la réponse restent sur le serveur `retention_s` secondes (7 jours par défaut) puis sont supprimées ; jamais dans les journaux."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from .service import ServiceError

BUSY_RETRY_S = 240.0
PURGE_EVERY_S = 60.0
MAX_SUBS_PER_REQUEST = 2
MAX_ROWS = 2000                                      # plafond de demandes conservées (environ 60 Mo au plus) : une avalanche d'envois ne peut pas remplir le disque
_KEY = re.compile(r"[A-Za-z0-9_-]{16,64}")
URL_FOR = "/#q=%s"                                   # lien du suivi : dans le fragment, qui n'est jamais envoyé au serveur ni dans un Referer

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    ip_hash TEXT NOT NULL,
    question TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'error')),
    created REAL NOT NULL, started REAL, finished REAL, expires REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    result TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS ix_requests_state ON requests (state, id);
CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, url TEXT NOT NULL, created REAL NOT NULL,
    UNIQUE (request_id, endpoint)
);
"""


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class PersistentQueue:
    persistent = True

    def __init__(self, run, db_path, max_size=8, per_ip=2, eta_s=150.0, retention_s=7 * 86400.0, notifier=None, push_key=None, log=None,
                 clock=time.time, sleep=time.sleep, max_rows=MAX_ROWS):
        self._run = run                                # data -> payload ; lève ServiceError
        self.max_rows = max(2, int(max_rows))
        self.max_size, self.per_ip, self.retention_s = max(1, int(max_size)), max(1, int(per_ip)), float(retention_s)
        self._notifier, self.push_key = notifier, push_key         # notifier(sub, state, url) -> code HTTP ; push_key = clé publique VAPID affichée au navigateur (ou None)
        self._log, self._clock, self._sleep = log or (lambda *a, **k: None), clock, sleep
        path = Path(db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None, timeout=10)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        self._cv = threading.Condition(threading.RLock())
        self._worker = None
        self._last_purge = 0.0
        with self._cv:
            self._secret = self._meta("secret", lambda: secrets.token_hex(32))
            self._avg = self._measured_avg() or float(eta_s)
            self._recover()
            if self._one("SELECT 1 FROM requests WHERE state='queued' LIMIT 1"):
                self._start_worker()

    # ----- petites aides SQL (verrou `_cv` tenu) -----
    def _one(self, sql, args=()):
        row = self._db.execute(sql, args).fetchone()
        return None if row is None else row[0]

    def _meta(self, key, make):
        v = self._one("SELECT v FROM meta WHERE k=?", (key,))
        if v is None:
            v = make()
            self._db.execute("INSERT INTO meta (k, v) VALUES (?, ?)", (key, v))
        return v

    def _measured_avg(self):
        v = self._one("SELECT AVG(finished - started) FROM (SELECT finished, started FROM requests WHERE state='done' AND started IS NOT NULL ORDER BY id DESC LIMIT 10)")
        return float(v) if v else None

    def _hmac(self, label, value):
        return hmac.new(bytes.fromhex(self._secret), (label + ":" + value).encode("utf-8"), hashlib.sha256).digest()

    def _ticket_for(self, key):
        return base64.urlsafe_b64encode(self._hmac("ticket", key)).rstrip(b"=").decode("ascii")[:22]          # 132 bits, indevinable sans le secret du serveur

    def _recover(self):
        """Au démarrage : une demande « en cours » a été interrompue. Remise en file la première fois, en erreur la seconde (jamais de boucle infinie)."""
        now = self._clock()
        self._db.execute("UPDATE requests SET state='error', finished=?, error=? WHERE state='running' AND attempts>=2",
                         (now, json.dumps({"http": 503, "code": "interrupted", "message": "Le traitement a été interrompu à deux reprises par un redémarrage du service. Posez de nouveau votre question."})))
        self._db.execute("UPDATE requests SET state='queued', started=NULL WHERE state='running'")

    def _start_worker(self):
        if self._worker is None:
            self._worker = threading.Thread(target=self._loop, name="persist-queue", daemon=True)
            self._worker.start()

    # ----- dépôt, consultation, suppression -----
    def submit(self, data, ip: str, key=None) -> dict:
        if key is not None and not _KEY.fullmatch(key):
            raise ServiceError(400, "invalid_request", "Clé d'envoi invalide.")
        key = key or secrets.token_urlsafe(16)
        ticket = self._ticket_for(key)
        with self._cv:
            now = self._clock()
            self._purge(now, force=True)
            existing = self._db.execute("SELECT * FROM requests WHERE token_hash=?", (_sha(ticket),)).fetchone()
            if existing is not None:                                       # même clé d'envoi : même demande (aucun doublon après une coupure réseau)
                return self._view(existing, ticket, now)
            ip_hash = _sha(self._secret + ip)
            if self._one("SELECT COUNT(*) FROM requests WHERE state IN ('queued','running')") >= self.max_size:
                raise ServiceError(429, "queue_full", "La file d'attente est pleine (%d questions). Réessayez dans quelques minutes." % self.max_size)
            if self._one("SELECT COUNT(*) FROM requests WHERE state IN ('queued','running') AND ip_hash=?", (ip_hash,)) >= self.per_ip:
                raise ServiceError(429, "queue_ip_limit", "Vous avez déjà %d question(s) en attente ou en cours. Attendez qu'une d'elles soit terminée." % self.per_ip)
            over = self._one("SELECT COUNT(*) FROM requests") - self.max_rows + 1
            if over > 0:                                                   # plein : les réponses terminées les plus anciennes cèdent la place (jamais une demande en attente)
                self._db.execute("DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE state IN ('done','error') ORDER BY id LIMIT ?)", (over,))
                if self._one("SELECT COUNT(*) FROM requests") >= self.max_rows:
                    raise ServiceError(503, "storage_full", "Le service ne peut pas conserver de nouvelle question pour le moment. Réessayez plus tard.")
            cur = self._db.execute("INSERT INTO requests (token_hash, ip_hash, question, state, created, expires) VALUES (?, ?, ?, 'queued', ?, ?)",
                                   (_sha(ticket), ip_hash, data["question"], now, now + self.retention_s))
            row = self._db.execute("SELECT * FROM requests WHERE id=?", (cur.lastrowid,)).fetchone()
            self._start_worker()
            self._cv.notify()
            view = self._view(row, ticket, now)
        self._log("queue_submit", position=view["position"], waiting=view["waiting"])
        return view

    def view(self, ticket: str):
        with self._cv:
            now = self._clock()
            self._purge(now)
            row = self._db.execute("SELECT * FROM requests WHERE token_hash=?", (_sha(ticket),)).fetchone()
            return None if row is None else self._view(row, ticket, now)

    def cancel(self, ticket: str) -> bool:
        """Supprime la demande (question et réponse comprises). Une demande en cours de traitement ne peut pas être interrompue."""
        with self._cv:
            n = self._db.execute("DELETE FROM requests WHERE token_hash=? AND state!='running'", (_sha(ticket),)).rowcount
        if n:
            self._log("queue_delete")
        return bool(n)

    def add_push(self, ticket: str, sub: dict) -> str:
        """Attache un abonnement Web Push (déjà validé) à une demande encore en attente : « ok », « unknown », « finished » ou « limit »."""
        with self._cv:
            row = self._db.execute("SELECT id, state FROM requests WHERE token_hash=?", (_sha(ticket),)).fetchone()
            if row is None:
                return "unknown"
            if row["state"] in ("done", "error"):
                return "finished"
            if self._one("SELECT COUNT(*) FROM push_subs WHERE request_id=? AND endpoint!=?", (row["id"], sub["endpoint"])) >= MAX_SUBS_PER_REQUEST:
                return "limit"
            self._db.execute("INSERT OR REPLACE INTO push_subs (request_id, endpoint, p256dh, auth, url, created) VALUES (?, ?, ?, ?, ?, ?)",
                             (row["id"], sub["endpoint"], sub["p256dh"], sub["auth"], URL_FOR % ticket, self._clock()))
            return "ok"

    def snapshot(self) -> dict:
        with self._cv:
            self._purge(self._clock())
            return {"enabled": True, "persistent": True, "max": self.max_size, "waiting": self._one("SELECT COUNT(*) FROM requests WHERE state='queued'"),
                    "running": bool(self._one("SELECT 1 FROM requests WHERE state='running' LIMIT 1")), "avg_s": int(round(self._avg)),
                    "retention_days": round(self.retention_s / 86400.0, 2), "push": {"enabled": bool(self.push_key and self._notifier), "key": self.push_key}}

    # ----- interne (verrou `_cv` tenu) -----
    def _purge(self, now, force=False):
        if not force and now - self._last_purge < PURGE_EVERY_S:
            return
        self._last_purge = now
        n = self._db.execute("DELETE FROM requests WHERE expires < ? AND state!='running'", (now,)).rowcount
        if n:
            self._log("queue_purge", removed=n)

    def _view(self, row, ticket, now) -> dict:
        state, ahead, eta = row["state"], 0, 0.0
        if state == "queued":
            run = self._db.execute("SELECT started FROM requests WHERE state='running' LIMIT 1").fetchone()
            idx = self._one("SELECT COUNT(*) FROM requests WHERE state='queued' AND id<?", (row["id"],))
            ahead = idx + (1 if run else 0)
            left = max(self._avg * 0.1, self._avg - (now - run["started"])) if run else 0.0
            eta = left + idx * self._avg + self._avg
        elif state == "running":
            eta = max(self._avg * 0.1, self._avg - (now - row["started"]))
        return {"ticket": ticket, "state": state, "ahead": ahead, "position": ahead + 1 if state == "queued" else 0,
                "waiting": self._one("SELECT COUNT(*) FROM requests WHERE state='queued'"), "eta_s": int(round(eta)),
                "result": json.loads(row["result"]) if state == "done" and row["result"] else None,
                "error": json.loads(row["error"]) if state == "error" and row["error"] else None,
                "question": row["question"], "persistent": True, "expires_in_s": max(0, int(row["expires"] - now))}

    # ----- thread de travail : un seul, donc une seule question à la fois -----
    def _loop(self):
        while True:
            with self._cv:
                while True:
                    now = self._clock()
                    self._purge(now)
                    row = self._db.execute("SELECT id, question, created FROM requests WHERE state='queued' ORDER BY id LIMIT 1").fetchone()
                    if row is not None:
                        break
                    self._cv.wait(timeout=30.0)
                self._db.execute("UPDATE requests SET state='running', started=?, attempts=attempts+1 WHERE id=?", (now, row["id"]))
            self._log("queue_start", waited_ms=round((now - row["created"]) * 1000))
            result, error = self._execute({"question": row["question"]})
            state = "done" if error is None else "error"
            with self._cv:
                fin = self._clock()
                self._db.execute("UPDATE requests SET state=?, finished=?, result=?, error=? WHERE id=?",
                                 (state, fin, json.dumps(result, ensure_ascii=False) if result is not None else None,
                                  json.dumps(error, ensure_ascii=False) if error else None, row["id"]))
                if error is None:
                    self._avg = 0.7 * self._avg + 0.3 * (fin - now)
                subs = [dict(r) for r in self._db.execute("SELECT * FROM push_subs WHERE request_id=?", (row["id"],))]
                self._db.execute("DELETE FROM push_subs WHERE request_id=?", (row["id"],))        # usage unique : supprimés dans tous les cas
            self._log("queue_end", state=state, run_ms=round((fin - now) * 1000), code=(error or {}).get("code"))
            if subs and self._notifier is not None:
                threading.Thread(target=self._notify, args=(subs, state), name="push-notify", daemon=True).start()     # n'attend jamais le service push

    def _execute(self, data):
        deadline = self._clock() + BUSY_RETRY_S
        while True:
            try:
                return self._run(data), None
            except ServiceError as e:
                if e.code == "busy" and self._clock() < deadline:
                    self._sleep(1.0)
                    continue
                return None, {"http": e.http, "code": e.code, "message": e.message}
            except Exception:
                return None, {"http": 500, "code": "internal_error", "message": "Une erreur est survenue. Réessayez dans un instant."}

    def _notify(self, subs, state):
        sent = gone = failed = 0
        for sub in subs:
            for attempt in (1, 2):
                try:
                    code = self._notifier(sub, state, sub["url"])
                except Exception:
                    code = None
                if code is not None and 200 <= code < 300:
                    sent += 1
                    break
                if code in (404, 410):                 # abonnement expiré ou révoqué : inutile de réessayer
                    gone += 1
                    break
                if attempt == 2:
                    failed += 1
                else:
                    self._sleep(3.0)
        self._log("push_done", sent=sent, gone=gone, failed=failed)


def from_env_persistent(run, mode: str, max_size: int, log=None):
    """File persistante d'après l'environnement, ou None. Active en production quand REGASSIST_DATA_ROOT est défini (sauf REGASSIST_QUEUE_PERSIST=0),
    ou quand REGASSIST_QUEUE_DB donne explicitement un fichier. Web Push : en production si la bibliothèque `cryptography` est présente (REGASSIST_PUSH=0 le coupe)."""
    explicit = os.environ.get("REGASSIST_QUEUE_DB", "").strip()
    root = os.environ.get("REGASSIST_DATA_ROOT", "").strip()
    if os.environ.get("REGASSIST_QUEUE_PERSIST", "1").strip() == "0" or not (explicit or (mode == "production" and root)):
        return None

    def num(name, default, cast):
        try:
            return cast(os.environ.get(name, default))
        except (TypeError, ValueError):
            return cast(default)
    db = Path(explicit) if explicit else Path(root) / "state" / "requests.sqlite3"
    notifier, push_key = None, None
    if os.environ.get("REGASSIST_PUSH", "1" if mode == "production" else "0").strip() != "0":
        from . import webpush
        if webpush.AVAILABLE:
            origin = (os.environ.get("REGASSIST_ALLOWED_ORIGINS", "").split(",")[0] or "").strip()
            subject = os.environ.get("REGASSIST_PUSH_SUBJECT", "").strip() or (origin if origin.startswith("https://") else "mailto:contact@example.invalid")
            wp = webpush.WebPush(webpush.Vapid(db.parent / "vapid_private.pem"), subject)
            push_key = wp.vapid.public_b64u
            notifier = lambda sub, state, url: wp.send(sub, webpush.message_for(state, url))        # noqa: E731
    return PersistentQueue(run, db, max_size=max_size,
                           per_ip=num("REGASSIST_QUEUE_PER_IP", "2", int), eta_s=num("REGASSIST_QUEUE_ETA_S", "150", float),
                           retention_s=num("REGASSIST_RETENTION_DAYS", "7", float) * 86400.0, notifier=notifier, push_key=push_key, log=log)
