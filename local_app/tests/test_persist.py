"""Tests de la file PERSISTANTE (local_app/persist.py) et des routes de suivi/notification, avec un FAUX agent et un FAUX service push : aucun modèle,
aucun accès réseau. Lancer : python local_app/tests/test_persist.py   (affiche « Tests suivi persistant : X/Y »)."""
import base64
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from local_app import persist as P                     # noqa: E402
from local_app import service as S                     # noqa: E402
from local_app import webpush as WP                    # noqa: E402
from local_app.server import create_app               # noqa: E402
from local_app.tests import fakes                      # noqa: E402

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"
os.environ["AGENT_LLM"] = "local"
TMP = Path(tempfile.mkdtemp(prefix="persist_tests_"))


def until(cond, what, timeout=6.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError("délai dépassé : " + what)


class Gated:
    def __init__(self):
        self.started, self.sem = [], threading.Semaphore(0)

    def __call__(self, data):
        self.started.append(data["question"])
        assert self.sem.acquire(timeout=8), "appel jamais libéré"
        return {"answer": data["question"], "status": "answered"}

    def release(self, n=1):
        for _ in range(n):
            self.sem.release()


_n = [0]


def dbfile():
    _n[0] += 1
    return TMP / f"q{_n[0]}.sqlite3"


def q(name):
    return {"question": name}


def new_sub(host="fcm.googleapis.com", path="/fcm/send/abc123def456ghi789"):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    pub = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": f"https://{host}{path}", "keys": {"p256dh": WP.b64u(pub), "auth": WP.b64u(os.urandom(16))}}


class Notifier:
    def __init__(self, codes=(201,)):
        self.calls, self.codes = [], list(codes)

    def __call__(self, sub, state, url):
        self.calls.append((sub["endpoint"], state, url))
        c = self.codes.pop(0) if len(self.codes) > 1 else self.codes[0]
        if isinstance(c, Exception):
            raise c
        return c


def test_requests_are_served_in_order_and_survive_in_the_view():
    g = Gated()
    pq = P.PersistentQueue(g, dbfile(), max_size=5, per_ip=3)
    a, b, c = pq.submit(q("a"), "1.1.1.1"), pq.submit(q("b"), "1.1.1.1"), pq.submit(q("c"), "1.1.1.1")
    until(lambda: g.started == ["a"], "a démarre")
    assert pq.view(a["ticket"])["state"] == "running"
    vb, vc = pq.view(b["ticket"]), pq.view(c["ticket"])
    assert (vb["ahead"], vb["position"], vc["ahead"], vc["position"]) == (1, 2, 2, 3) and vc["eta_s"] > vb["eta_s"] > 0
    assert vb["question"] == "b" and vb["persistent"] is True and vb["expires_in_s"] > 6 * 86400
    g.release(3)
    until(lambda: pq.view(c["ticket"])["state"] == "done", "tout terminé")
    assert g.started == ["a", "b", "c"] and pq.view(a["ticket"])["result"]["answer"] == "a"


def test_restart_resumes_waiting_requests_and_never_loops_on_a_crashing_one():
    g = Gated()
    src = dbfile()
    pq = P.PersistentQueue(g, src, max_size=5, per_ip=5)
    a, b = pq.submit(q("a"), "1"), pq.submit(q("b"), "2")
    until(lambda: g.started == ["a"], "a en cours")
    copy1 = dbfile()
    with sqlite3.connect(copy1) as dst:
        pq._db.backup(dst)                                       # « crash » : l'état du disque à cet instant (a en cours, b en attente)
    g2 = Gated()
    pq2 = P.PersistentQueue(g2, copy1, max_size=5, per_ip=5)     # redémarrage
    until(lambda: g2.started == ["a"], "a est reprise au redémarrage")
    assert pq2.view(a["ticket"])["state"] == "running" and pq2.view(b["ticket"])["position"] == 2
    copy2 = dbfile()
    with sqlite3.connect(copy2) as dst:
        pq2._db.backup(dst)                                      # second « crash » pendant la même demande
    pq3 = P.PersistentQueue(Gated(), copy2, max_size=5, per_ip=5)
    va = pq3.view(a["ticket"])
    assert va["state"] == "error" and va["error"]["code"] == "interrupted", va                   # jamais de boucle infinie
    until(lambda: pq3.view(b["ticket"])["state"] == "running", "b passe ensuite")
    g.release(2)
    g2.release(2)


def test_ticket_and_address_are_never_stored_in_clear():
    pq = P.PersistentQueue(lambda d: {"answer": "ok", "status": "answered"}, dbfile(), max_size=5)
    v = pq.submit(q("une question sensible"), "203.0.113.77")
    until(lambda: pq.view(v["ticket"])["state"] == "done", "terminé")
    rows = "\n".join(json.dumps([tuple(r) for r in pq._db.execute(f"SELECT * FROM {t}")], default=str) for t in ("requests", "meta", "push_subs"))
    assert v["ticket"] not in rows and "203.0.113.77" not in rows, "lien ou adresse IP en clair dans la base"
    assert len(v["ticket"]) >= 22 and pq._db.execute("SELECT token_hash FROM requests").fetchone()[0] == P._sha(v["ticket"])


def test_unknown_ticket_and_other_visitors_requests_are_indistinguishable():
    pq = P.PersistentQueue(lambda d: {"answer": "ok"}, dbfile(), max_size=5)
    mine = pq.submit(q("a"), "1")
    for t in ("x" * 22, mine["ticket"][:-1] + ("A" if mine["ticket"][-1] != "A" else "B"), "", "../../etc/passwd"):
        assert pq.view(t) is None and pq.cancel(t) is False and pq.add_push(t, {"endpoint": "e", "p256dh": "p", "auth": "a"}) == "unknown"


def test_same_idempotency_key_gives_the_same_request_without_duplicate():
    g = Gated()
    pq = P.PersistentQueue(g, dbfile(), max_size=5, per_ip=2)
    k = "k" * 22
    a1 = pq.submit(q("a"), "1", key=k)
    a2 = pq.submit(q("a"), "9.9.9.9", key=k)                    # nouvelle tentative après une coupure, même depuis une autre adresse
    assert a1["ticket"] == a2["ticket"] and pq._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1
    assert pq.submit(q("b"), "1", key="j" * 22)["ticket"] != a1["ticket"]
    try:
        pq.submit(q("c"), "1", key="trop court")
        raise AssertionError("clé invalide acceptée")
    except S.ServiceError as e:
        assert e.http == 400
    g.release(3)


def test_limits_total_and_per_address():
    g = Gated()
    pq = P.PersistentQueue(g, dbfile(), max_size=2, per_ip=1)
    pq.submit(q("a"), "1")
    for ip, code in (("1", "queue_ip_limit"),):
        try:
            pq.submit(q("a2"), ip)
            raise AssertionError("même adresse deux fois")
        except S.ServiceError as e:
            assert (e.http, e.code) == (429, code)
    pq.submit(q("b"), "2")
    try:
        pq.submit(q("c"), "3")
        raise AssertionError("file pleine")
    except S.ServiceError as e:
        assert e.code == "queue_full"
    g.release(2)


def test_delete_removes_waiting_and_finished_requests_but_not_a_running_one():
    g = Gated()
    pq = P.PersistentQueue(g, dbfile(), max_size=5, per_ip=5)
    a, b = pq.submit(q("a"), "1"), pq.submit(q("b"), "1")
    until(lambda: g.started == ["a"], "a en cours")
    assert pq.cancel(a["ticket"]) is False and pq.cancel(b["ticket"]) is True and pq.view(b["ticket"]) is None
    g.release()
    until(lambda: pq.view(a["ticket"])["state"] == "done", "a terminée")
    assert pq.cancel(a["ticket"]) is True and pq.view(a["ticket"]) is None, "la réponse terminée peut être supprimée par le visiteur"


def test_retention_deletes_requests_and_their_subscriptions():
    t = [1000.0]
    pq = P.PersistentQueue(lambda d: {"answer": "ok"}, dbfile(), max_size=5, retention_s=100, clock=lambda: t[0], notifier=Notifier(), push_key="k")
    v = pq.submit(q("a"), "1")
    until(lambda: pq.view(v["ticket"])["state"] == "done", "terminé")
    w = pq.submit(q("b"), "1")
    until(lambda: pq.view(w["ticket"])["state"] == "done", "b terminé")
    t[0] = 1050
    assert pq.view(v["ticket"]) is not None
    t[0] = 1101
    assert pq.view(v["ticket"]) is None and pq.view(w["ticket"]) is None, "supprimées après le délai de conservation"
    assert pq._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 0


def test_push_subscription_is_used_once_then_deleted_and_never_blocks_the_answer():
    g, n = Gated(), Notifier((201,))
    pq = P.PersistentQueue(g, dbfile(), max_size=5, per_ip=5, notifier=n, push_key="clé")
    v = pq.submit(q("a"), "1")
    until(lambda: g.started == ["a"], "a en cours")
    sub = WP.validate_subscription(new_sub())
    assert pq.add_push(v["ticket"], sub) == "ok"
    assert pq.add_push(v["ticket"], WP.validate_subscription(new_sub(path="/fcm/send/autre1234567890"))) == "ok"
    assert pq.add_push(v["ticket"], WP.validate_subscription(new_sub(path="/fcm/send/encore1234567890"))) == "limit"
    g.release()
    until(lambda: len(n.calls) == 2, "deux notifications envoyées")
    assert all(c[1] == "done" and c[2] == "/#q=" + v["ticket"] for c in n.calls)
    until(lambda: pq._db.execute("SELECT COUNT(*) FROM push_subs").fetchone()[0] == 0, "abonnements supprimés après usage")
    assert pq.add_push(v["ticket"], sub) == "finished"


def test_expired_subscription_is_dropped_and_a_failing_push_service_does_not_change_the_result():
    for codes, expected_calls, expected_sleeps in (((410,), 1, []), ((RuntimeError("réseau coupé"),), 2, [3.0]), ((500,), 2, [3.0]), ((503, 201), 2, [3.0])):
        n, slept, g = Notifier(codes), [], Gated()
        pq = P.PersistentQueue(g, dbfile(), max_size=5, notifier=n, push_key="k", sleep=lambda s: slept.append(s))
        v = pq.submit(q("a"), "1")
        until(lambda: g.started == ["a"], "en cours")
        assert pq.add_push(v["ticket"], WP.validate_subscription(new_sub())) == "ok"
        g.release()
        until(lambda: pq.view(v["ticket"])["state"] == "done", "terminé")
        until(lambda: len(n.calls) == expected_calls and not pq._db.execute("SELECT COUNT(*) FROM push_subs").fetchone()[0], "tentatives %s" % (codes,))
        time.sleep(0.05)
        assert len(n.calls) == expected_calls and slept == expected_sleeps, (codes, n.calls, slept)          # 410 : aucune relance ; échec : une seule relance
        assert pq.view(v["ticket"])["result"]["answer"] == "a", "la réponse reste lisible quoi qu'il arrive à la notification"


def test_storage_is_capped_oldest_finished_answers_make_room_and_pending_ones_are_never_dropped():
    g = Gated()
    pq = P.PersistentQueue(g, dbfile(), max_size=50, per_ip=50, max_rows=4)
    done = []
    for i in range(3):
        v = pq.submit(q("fini%d" % i), "ip%d" % i)
        g.release()
        until(lambda: pq.view(v["ticket"])["state"] == "done", "fini %d" % i)
        done.append(v["ticket"])
    waiting = pq.submit(q("en attente"), "ipw")                                   # 4 lignes : plein
    until(lambda: g.started[-1] == "en attente", "en cours")
    newer = pq.submit(q("suivante"), "ipx")                                       # la plus ancienne réponse terminée cède la place
    assert pq.view(done[0]) is None and pq.view(done[1]) is not None and pq.view(newer["ticket"]) is not None
    assert pq.view(waiting["ticket"]) is not None, "une demande en cours n'est jamais supprimée pour faire de la place"
    full = P.PersistentQueue(Gated(), dbfile(), max_size=50, per_ip=50, max_rows=2)
    full.submit(q("a"), "1")
    full.submit(q("b"), "2")
    try:
        full.submit(q("c"), "3")
        raise AssertionError("base pleine de demandes non terminées : refus attendu")
    except S.ServiceError as e:
        assert (e.http, e.code) == (503, "storage_full")
    g.release(3)


def test_error_results_are_stored_with_the_stable_code():
    def run(d):
        raise S.ServiceError(503, "agent_unavailable", "Le service de recherche est momentanément indisponible.")
    pq = P.PersistentQueue(run, dbfile(), max_size=5)
    v = pq.submit(q("a"), "1")
    until(lambda: pq.view(v["ticket"])["state"] == "error", "erreur enregistrée")
    assert pq.view(v["ticket"])["error"]["code"] == "agent_unavailable"


def test_subscription_validation_blocks_server_side_request_forgery():
    good = new_sub()
    assert WP.validate_subscription(good)["endpoint"] == good["endpoint"]
    bad_endpoints = ["http://fcm.googleapis.com/fcm/send/abc123def456ghi789", "https://127.0.0.1/fcm/send/abc123def456ghi789", "https://localhost/x/abc123def456ghi789",
                     "https://169.254.169.254/latest/meta-data/abc123def456", "https://fcm.googleapis.com.evil.example/fcm/send/abc123def456",
                     "https://evil.example/push.apple.com/abc123def456ghi789", "https://user:pw@fcm.googleapis.com/fcm/send/abc123def456", "https://fcm.googleapis.com:8443/fcm/send/abc123def456",
                     "https://push.apple.com/abc123def456ghi789", "https://notify.windows.com/abc123def456ghi789", "ftp://fcm.googleapis.com/abc123def456ghi789", "https://[::1]/abc123def456ghi789"]
    for ep in bad_endpoints:
        s = new_sub()
        s["endpoint"] = ep
        try:
            WP.validate_subscription(s)
            raise AssertionError("adresse acceptée : " + ep)
        except ValueError:
            pass
    for host in ("updates.push.services.mozilla.com", "web.push.apple.com", "wns2-par02p.notify.windows.com", "fcm.googleapis.com"):
        assert WP.validate_subscription(new_sub(host=host))["endpoint"].startswith("https://" + host)
    for mutate in (lambda s: s["keys"].update(p256dh="AAAA"), lambda s: s["keys"].update(auth="AAAA"), lambda s: s.pop("keys"), lambda s: s["keys"].update(p256dh=WP.b64u(b"\x04" + b"\x01" * 64))):
        s = new_sub()
        mutate(s)
        try:
            WP.validate_subscription(s)
            raise AssertionError("clés invalides acceptées")
        except ValueError:
            pass


# ---------- routes ----------
def build(**kw):
    n = Notifier((201,))
    svc = S.Service(agent=fakes.make_agent(), llm_probe=lambda: {"online": True, "model": "x", "model_matches": True}, smalltalk_llm=lambda q, st: None)
    svc.warm_up()
    pq = P.PersistentQueue(kw.pop("run", svc.chat), dbfile(), max_size=kw.pop("max_size", 5), per_ip=kw.pop("per_ip", 3), notifier=n, push_key="CLE-PUBLIQUE", **kw)
    app = create_app(svc, PORT, wait_queue=pq)
    return svc, app.test_client(), pq, n


def submit(c, question, key=None, **kw):
    h = {"Idempotency-Key": key} if key else {}
    return c.post("/api/queue", json={"question": question}, headers=h, base_url=BASE, **kw)


def test_api_full_flow_leave_and_come_back_with_the_personal_link():
    svc, c, pq, _ = build()
    r = submit(c, "plafond", key="a" * 22)
    assert r.status_code == 202, r.get_data(as_text=True)
    t = r.get_json()["ticket"]
    until(lambda: c.get(f"/api/queue/{t}", base_url=BASE).get_json()["state"] == "done", "réponse prête")
    again = submit(c, "plafond", key="a" * 22)                                    # le navigateur n'a pas reçu la première réponse HTTP : même clé, même demande
    assert again.get_json()["ticket"] == t and pq._db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1
    d = c.get(f"/api/queue/{t}", base_url=BASE).get_json()
    assert d["result"]["status"] == "answered" and d["question"] == "plafond" and d["persistent"] is True
    st = c.get("/api/status", base_url=BASE).get_json()["queue"]
    assert st["persistent"] is True and st["retention_days"] == 7 and st["push"] == {"enabled": True, "key": "CLE-PUBLIQUE"}
    assert c.post(f"/api/queue/{t}/cancel", base_url=BASE).get_json() == {"cancelled": True}
    assert c.get(f"/api/queue/{t}", base_url=BASE).status_code == 404


def test_api_push_route_stores_a_valid_subscription_and_rejects_the_rest():
    g = Gated()
    svc, c, pq, n = build(run=g)
    t = submit(c, "plafond").get_json()["ticket"]
    until(lambda: g.started == ["plafond"], "en cours")
    url = f"/api/queue/{t}/push"
    ok = c.post(url, json={"subscription": new_sub()}, base_url=BASE)
    assert ok.status_code == 201 and ok.get_json() == {"subscribed": True}
    evil = new_sub()
    evil["endpoint"] = "https://127.0.0.1:9000/internal/abc123def456ghi789"
    for body, code in (({"subscription": evil}, "invalid_subscription"), ({"subscription": "x"}, "invalid_subscription"), ({}, "invalid_request"), ({"subscription": new_sub(), "x": 1}, "invalid_request")):
        r = c.post(url, json=body, base_url=BASE)
        assert r.status_code == 400 and r.get_json()["error"]["code"] == code, (body, r.get_json())
    assert c.post(f"/api/queue/{'z' * 22}/push", json={"subscription": new_sub()}, base_url=BASE).status_code == 404
    assert c.post(url, data="x", content_type="text/plain", base_url=BASE).status_code == 415
    g.release()
    until(lambda: c.get(f"/api/queue/{t}", base_url=BASE).get_json()["state"] == "done", "terminé")
    late = c.post(url, json={"subscription": new_sub()}, base_url=BASE)
    assert late.status_code == 409 and late.get_json()["error"]["code"] == "already_finished"
    until(lambda: len(n.calls) == 1, "une notification pour l'abonnement valide")


def test_api_push_route_does_not_exist_without_push_or_persistence():
    svc = S.Service(agent=fakes.make_agent(), llm_probe=lambda: {"online": True, "model": "x", "model_matches": True}, smalltalk_llm=lambda q, st: None)
    svc.warm_up()
    c = create_app(svc, PORT, wait_queue=P.PersistentQueue(svc.chat, dbfile(), max_size=3)).test_client()          # persistante mais sans notifier
    assert c.post("/api/queue/" + "a" * 22 + "/push", json={"subscription": new_sub()}, base_url=BASE).status_code == 404
    from local_app.waitqueue import WaitQueue
    c2 = create_app(svc, PORT, wait_queue=WaitQueue(svc.chat, max_size=3)).test_client()
    assert c2.post("/api/queue/" + "a" * 22 + "/push", json={"subscription": new_sub()}, base_url=BASE).status_code == 404
    assert c2.get("/api/status", base_url=BASE).get_json()["queue"].get("persistent") is None


def test_api_one_visitor_cannot_read_or_delete_another_visitors_request():
    svc, c, pq, _ = build()
    t = submit(c, "question confidentielle").get_json()["ticket"]
    until(lambda: pq.view(t)["state"] == "done", "terminé")
    for other in ("0" * 22, t[::-1], t[:10] + "_" * 12):
        assert c.get(f"/api/queue/{other}", base_url=BASE).status_code == 404
        assert c.post(f"/api/queue/{other}/cancel", base_url=BASE).get_json() == {"cancelled": False}
    body = c.get("/api/status", base_url=BASE).get_data(as_text=True)
    assert "question confidentielle" not in body and t not in body, "le statut public ne révèle ni question ni lien"


def test_api_service_worker_and_game_are_served_with_a_strict_policy():
    _, c, _, _ = build()
    for path in ("/sw.js", "/game.js"):
        r = c.get(path, base_url=BASE)
        assert r.status_code == 200 and "javascript" in r.headers["Content-Type"], path
        csp = r.headers["Content-Security-Policy"]
        assert "worker-src 'self'" in csp and "default-src 'none'" in csp and "unsafe" not in csp and "http" not in csp
        assert r.headers["Cache-Control"] == "no-cache"
    sw = c.get("/sw.js", base_url=BASE).get_data(as_text=True)
    assert "fetch(" not in sw and "importScripts" not in sw, "le service worker n'accède à aucun réseau"
    assert "question" not in sw.lower().replace("votre question", ""), "le service worker ne manipule jamais le texte d'une question"


TESTS = [(n, f) for n, f in sorted(globals().items(), key=lambda kv: kv[1].__code__.co_firstlineno if callable(kv[1]) and hasattr(kv[1], "__code__") else 0) if n.startswith("test_")]

if __name__ == "__main__":
    failed = []
    for name, fn in TESTS:
        try:
            fn()
            print("ok     ", name)
        except Exception:
            failed.append(name)
            print("ECHEC  ", name)
            traceback.print_exc()
    shutil.rmtree(TMP, ignore_errors=True)
    print(f"\nTests suivi persistant : {len(TESTS) - len(failed)}/{len(TESTS)}")
    sys.exit(1 if failed else 0)
