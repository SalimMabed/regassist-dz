"""File d'attente FIFO pour le déploiement public : une seule question est traitée à la fois (le moteur gelé et le modèle local ne tournent pas en parallèle),
les autres attendent leur tour et connaissent leur position.

Principe : le navigateur dépose sa question (POST /api/queue) et reçoit un ticket, puis interroge l'état du ticket (GET /api/queue/<ticket>) toutes les
quelques secondes. Aucune requête HTTP ne reste ouverte pendant l'attente, donc aucun délai d'expiration du proxy n'est en jeu, et une page fermée
libère sa place : un ticket « en attente » qui n'est plus interrogé depuis `idle_s` secondes est retiré. Une question déjà en cours de traitement va
toujours à son terme et son résultat reste lisible `result_ttl_s` secondes.

Le moteur n'est pas modifié : le thread de travail appelle `Service.chat`, exactement comme POST /api/chat. Désactivée par défaut hors production
(variable REGASSIST_QUEUE_MAX ; 0 = file désactivée, l'ancien comportement « occupé » 429 est conservé)."""
import collections
import os
import secrets
import threading
import time

from .service import ServiceError

BUSY_RETRY_S = 240.0        # POST /api/chat (accès direct) peut tenir le verrou du moteur : le thread de travail réessaie au lieu d'échouer


class _Ticket:
    __slots__ = ("id", "ip", "data", "state", "created", "started", "finished", "last_seen", "result", "error")

    def __init__(self, tid, ip, data, now):
        self.id, self.ip, self.data = tid, ip, data
        self.state = "queued"                          # queued -> running -> done | error
        self.created = self.last_seen = now
        self.started = self.finished = None
        self.result = self.error = None


class WaitQueue:
    def __init__(self, run, max_size=8, per_ip=2, eta_s=150.0, result_ttl_s=900.0, idle_s=120.0, log=None, clock=time.monotonic, sleep=time.sleep):
        self._run = run                                # data -> payload ; lève ServiceError
        self.max_size, self.per_ip = max(1, int(max_size)), max(1, int(per_ip))
        self.result_ttl_s, self.idle_s = float(result_ttl_s), float(idle_s)
        self._avg = float(eta_s)                       # durée moyenne d'une question (moyenne mobile des questions réellement traitées)
        self._log, self._clock, self._sleep = log or (lambda *a, **k: None), clock, sleep
        self._cv = threading.Condition()
        self._waiting = collections.deque()
        self._tickets = {}
        self._running = None
        self._worker = None

    # ----- dépôt, consultation, annulation -----
    def submit(self, data, ip: str) -> dict:
        with self._cv:
            now = self._clock()
            self._purge(now)
            active = [t for t in self._tickets.values() if t.state in ("queued", "running")]
            if len(active) >= self.max_size:
                raise ServiceError(429, "queue_full", "La file d'attente est pleine (%d questions). Réessayez dans quelques minutes." % self.max_size)
            if sum(1 for t in active if t.ip == ip) >= self.per_ip:
                raise ServiceError(429, "queue_ip_limit", "Vous avez déjà %d question(s) en attente ou en cours. Attendez qu'une d'elles soit terminée." % self.per_ip)
            t = _Ticket(secrets.token_urlsafe(16), ip, data, now)
            self._tickets[t.id] = t
            self._waiting.append(t)
            if self._worker is None:
                self._worker = threading.Thread(target=self._loop, name="wait-queue", daemon=True)
                self._worker.start()
            self._cv.notify()
            view = self._view(t, now)
        self._log("queue_submit", position=view["position"], waiting=view["waiting"])
        return view

    def view(self, tid: str):
        """État d'un ticket (et signe de vie du navigateur), ou None s'il est inconnu, annulé ou expiré."""
        with self._cv:
            now = self._clock()
            self._purge(now)
            t = self._tickets.get(tid)
            if t is None:
                return None
            t.last_seen = now
            return self._view(t, now)

    def cancel(self, tid: str) -> bool:
        """Retire une question encore en attente. Une question déjà en cours de traitement ne peut pas être interrompue."""
        with self._cv:
            t = self._tickets.get(tid)
            if t is None or t.state != "queued":
                return False
            self._waiting.remove(t)
            del self._tickets[tid]
        self._log("queue_cancel")
        return True

    def snapshot(self) -> dict:
        with self._cv:
            self._purge(self._clock())
            return {"enabled": True, "max": self.max_size, "waiting": len(self._waiting), "running": self._running is not None, "avg_s": int(round(self._avg))}

    # ----- interne (verrou `_cv` tenu) -----
    def _purge(self, now):
        for t in [t for t in self._waiting if now - t.last_seen > self.idle_s]:        # page fermée : on libère la place
            self._waiting.remove(t)
            del self._tickets[t.id]
            self._log("queue_drop", reason="idle")
        for t in [t for t in self._tickets.values() if t.finished is not None and now - t.finished > self.result_ttl_s]:
            del self._tickets[t.id]

    def _view(self, t, now) -> dict:
        ahead, eta = 0, 0.0
        if t.state == "queued":
            idx = self._waiting.index(t)
            ahead = idx + (1 if self._running is not None else 0)
            left = max(self._avg * 0.1, self._avg - (now - self._running.started)) if self._running is not None else 0.0
            eta = left + idx * self._avg + self._avg
        elif t.state == "running":
            eta = max(self._avg * 0.1, self._avg - (now - t.started))
        return {"ticket": t.id, "state": t.state, "ahead": ahead, "position": ahead + 1 if t.state == "queued" else 0, "waiting": len(self._waiting),
                "eta_s": int(round(eta)), "result": t.result if t.state == "done" else None, "error": t.error if t.state == "error" else None}

    # ----- thread de travail : un seul, donc une seule question à la fois -----
    def _loop(self):
        while True:
            with self._cv:
                while True:
                    now = self._clock()
                    self._purge(now)
                    if self._waiting:
                        t = self._waiting.popleft()
                        break
                    self._cv.wait(timeout=5.0)
                t.state, t.started, self._running = "running", now, t
            self._log("queue_start", waited_ms=round((now - t.created) * 1000))
            result, error = self._execute(t.data)
            with self._cv:
                t.finished = self._clock()
                dur = t.finished - t.started
                t.state, t.result, t.error = ("done", result, None) if error is None else ("error", None, error)
                if error is None:
                    self._avg = 0.7 * self._avg + 0.3 * dur
                self._running = None
            self._log("queue_end", state=t.state, run_ms=round(dur * 1000), code=(error or {}).get("code"))

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


def from_env(run, mode: str, log=None):
    """File configurée par l'environnement, ou None. REGASSIST_QUEUE_MAX = nombre maximal de questions (en cours + en attente) ; 0 désactive.
    Par défaut : 8 en production (déploiement public), 0 en local (application de bureau : comportement « occupé » inchangé)."""
    def num(name, default, cast):
        try:
            return cast(os.environ.get(name, default))
        except (TypeError, ValueError):
            return cast(default)
    n = num("REGASSIST_QUEUE_MAX", "8" if mode == "production" else "0", int)
    if n <= 0:
        return None
    return WaitQueue(run, max_size=n, per_ip=num("REGASSIST_QUEUE_PER_IP", "2", int), eta_s=num("REGASSIST_QUEUE_ETA_S", "150", float), log=log)
