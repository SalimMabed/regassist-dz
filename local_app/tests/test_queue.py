"""Tests de la file d'attente (local_app/waitqueue.py) : ordre d'arrivée, positions, limites, abandon, erreurs, et les routes /api/queue avec un FAUX agent.
Aucun modèle n'est chargé. Lancer : python local_app/tests/test_queue.py   (affiche « Tests file d'attente : X/Y »)."""
import os
import sys
import threading
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from local_app import service as S                     # noqa: E402
from local_app import waitqueue as W                   # noqa: E402
from local_app.server import create_app               # noqa: E402
from local_app.tests import fakes                      # noqa: E402

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"
os.environ["AGENT_LLM"] = "local"


def until(cond, what, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError("délai dépassé : " + what)


class Gated:
    """`run` factice : chaque appel démarre puis attend qu'on le libère ; garde l'ordre de démarrage."""

    def __init__(self):
        self.started, self.sem = [], threading.Semaphore(0)

    def __call__(self, data):
        self.started.append(data["question"])
        assert self.sem.acquire(timeout=5), "appel jamais libéré"
        return {"answer": data["question"]}

    def release(self, n=1):
        for _ in range(n):
            self.sem.release()


def q(name):
    return {"question": name}


def test_questions_are_served_in_arrival_order_with_positions():
    g = Gated()
    wq = W.WaitQueue(g, max_size=5)
    a, b, c = (wq.submit(q(n), "1.1.1.1" if n == "a" else "2.2.2.2" if n == "b" else "3.3.3.3") for n in "abc")
    until(lambda: g.started == ["a"], "a démarre")
    assert wq.view(a["ticket"])["state"] == "running"
    vb, vc = wq.view(b["ticket"]), wq.view(c["ticket"])
    assert (vb["state"], vb["ahead"], vb["position"]) == ("queued", 1, 2), vb
    assert (vc["state"], vc["ahead"], vc["position"]) == ("queued", 2, 3), vc
    assert vc["eta_s"] > vb["eta_s"] > 0
    g.release()
    until(lambda: wq.view(a["ticket"])["state"] == "done", "a terminé")
    until(lambda: g.started == ["a", "b"], "b démarre après a")
    assert wq.view(a["ticket"])["result"] == {"answer": "a"}
    vc = wq.view(c["ticket"])
    assert (vc["ahead"], vc["position"]) == (1, 2), vc
    g.release(2)
    until(lambda: wq.view(c["ticket"])["state"] == "done", "c terminé")
    assert g.started == ["a", "b", "c"], g.started


def test_queue_refuses_when_full_and_per_address():
    g = Gated()
    wq = W.WaitQueue(g, max_size=2, per_ip=1)
    wq.submit(q("a"), "1.1.1.1")
    try:
        wq.submit(q("a2"), "1.1.1.1")
        raise AssertionError("même adresse deux fois")
    except S.ServiceError as e:
        assert (e.http, e.code) == (429, "queue_ip_limit")
    wq.submit(q("b"), "2.2.2.2")
    try:
        wq.submit(q("c"), "3.3.3.3")
        raise AssertionError("file pleine")
    except S.ServiceError as e:
        assert (e.http, e.code) == (429, "queue_full")
    g.release(2)


def test_cancel_removes_a_waiting_question_but_not_a_running_one():
    g = Gated()
    wq = W.WaitQueue(g, max_size=5)
    a, b, c = wq.submit(q("a"), "1"), wq.submit(q("b"), "2"), wq.submit(q("c"), "3")
    until(lambda: g.started == ["a"], "a démarre")
    assert wq.cancel(a["ticket"]) is False                       # déjà en cours : on ne l'interrompt pas
    assert wq.cancel(b["ticket"]) is True and wq.view(b["ticket"]) is None
    assert wq.view(c["ticket"])["position"] == 2                 # c était 3e ; après l'annulation de b, seule la question en cours est devant elle
    g.release(2)
    until(lambda: g.started == ["a", "c"], "b n'est jamais traitée")
    assert wq.cancel("inconnu") is False


def test_abandoned_waiting_ticket_is_dropped_but_the_running_one_survives():
    g, t = Gated(), [0.0]
    wq = W.WaitQueue(g, max_size=5, idle_s=100, clock=lambda: t[0])
    a, b, c = wq.submit(q("a"), "1"), wq.submit(q("b"), "2"), wq.submit(q("c"), "3")
    until(lambda: g.started == ["a"], "a démarre")
    t[0] = 60
    assert wq.view(c["ticket"])["state"] == "queued"             # c montre signe de vie à t=60
    t[0] = 150
    assert wq.view(c["ticket"])["state"] == "queued"
    assert wq.view(b["ticket"]) is None, "b n'a pas donné signe de vie depuis 150 s : retirée"
    assert wq.view(a["ticket"])["state"] == "running", "la question en cours n'est jamais retirée"
    g.release(2)
    until(lambda: g.started == ["a", "c"], "c passe après a")


def test_result_expires_after_its_ttl_and_errors_are_reported():
    t = [0.0]

    def run(data):
        if data["question"] == "boom":
            raise RuntimeError("secret interne /opt/x")
        if data["question"] == "indispo":
            raise S.ServiceError(503, "agent_unavailable", "Le service de recherche est momentanément indisponible.")
        return {"answer": "ok"}
    wq = W.WaitQueue(run, max_size=5, result_ttl_s=50, clock=lambda: t[0])
    ok, bad, down = wq.submit(q("bonne"), "1"), wq.submit(q("boom"), "2"), wq.submit(q("indispo"), "3")
    until(lambda: all(wq.view(x["ticket"])["state"] in ("done", "error") for x in (ok, bad, down)), "trois tickets terminés")
    assert wq.view(ok["ticket"])["result"] == {"answer": "ok"}
    e = wq.view(bad["ticket"])["error"]
    assert e["code"] == "internal_error" and "secret" not in e["message"] and "/opt" not in e["message"], e         # aucun détail interne exposé
    assert wq.view(down["ticket"])["error"]["code"] == "agent_unavailable"
    t[0] = 51
    assert wq.view(ok["ticket"]) is None, "résultat effacé après le délai de conservation"


def test_worker_retries_while_the_engine_is_held_by_a_direct_call():
    calls = []

    def run(data):
        calls.append(1)
        if len(calls) < 3:
            raise S.ServiceError(429, "busy", "occupé")
        return {"answer": "ok"}
    wq = W.WaitQueue(run, max_size=3, sleep=lambda s: None)
    a = wq.submit(q("a"), "1")
    until(lambda: wq.view(a["ticket"])["state"] == "done", "réessai jusqu'au succès")
    assert len(calls) == 3


def test_environment_configuration():
    keep = {k: os.environ.pop(k, None) for k in ("REGASSIST_QUEUE_MAX", "REGASSIST_QUEUE_PER_IP", "REGASSIST_QUEUE_ETA_S")}
    try:
        assert W.from_env(lambda d: d, "local") is None, "hors production : comportement « occupé » inchangé"
        assert W.from_env(lambda d: d, "production").max_size == 8
        os.environ["REGASSIST_QUEUE_MAX"] = "0"
        assert W.from_env(lambda d: d, "production") is None
        os.environ["REGASSIST_QUEUE_MAX"] = "3"
        assert W.from_env(lambda d: d, "local").max_size == 3
        os.environ["REGASSIST_QUEUE_MAX"] = "n'importe quoi"
        assert W.from_env(lambda d: d, "production").max_size == 8, "valeur invalide : défaut"
    finally:
        for k, v in keep.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


# ---------- routes ----------
def build(queue=True, delay=0.0, **qkw):
    state = {"online": True}
    agent = fakes.make_agent(delay=delay, state=state)
    svc = S.Service(agent=agent, llm_probe=lambda: {"online": True, "model": "qwen3-4b-instruct-2507-q4_k_m", "model_matches": True},
                    smalltalk_llm=lambda q, st: None)
    svc.warm_up()
    wq = W.WaitQueue(svc.chat, **qkw) if queue else None
    app = create_app(svc, PORT, wait_queue=wq)
    return svc, app.test_client(), agent, app


def submit(c, question, **kw):
    return c.post("/api/queue", json={"question": question}, base_url=BASE, **kw)


def test_api_a_question_goes_through_the_queue_and_returns_the_real_answer():
    svc, c, agent, _ = build(max_size=4)
    r = submit(c, "plafond")
    assert r.status_code == 202, r.get_data(as_text=True)
    v = r.get_json()
    assert v["state"] in ("queued", "running") and v["ticket"]
    until(lambda: c.get(f"/api/queue/{v['ticket']}", base_url=BASE).get_json()["state"] == "done", "réponse prête")
    done = c.get(f"/api/queue/{v['ticket']}", base_url=BASE).get_json()
    assert done["result"]["status"] == "answered" and done["result"]["question"] == "plafond" and done["error"] is None, done
    assert len(agent.calls) == 1 and agent.calls[0][1] is True, "le moteur est appelé comme par POST /api/chat"


def test_api_greeting_is_answered_immediately_without_waiting_in_line():
    g = Gated()
    state = {"online": True}
    svc = S.Service(agent=fakes.make_agent(state=state), llm_probe=lambda: {"online": True, "model": "qwen3-4b-instruct-2507-q4_k_m", "model_matches": True},
                    smalltalk_llm=lambda q, st: None)
    svc.warm_up()
    c = create_app(svc, PORT, wait_queue=W.WaitQueue(g, max_size=4)).test_client()
    assert submit(c, "plafond").status_code == 202
    until(lambda: g.started == ["plafond"], "une vraie question occupe le moteur")
    r = submit(c, "bonjour")
    v = r.get_json()
    assert r.status_code == 200 and v["state"] == "done" and v["ticket"] is None and v["result"]["status"] == "smalltalk", v
    g.release()


def test_api_invalid_questions_never_enter_the_queue():
    _, c, _, app = build(max_size=4)
    for body, code in (({"question": ""}, "empty_question"), ({"question": 5}, "invalid_request"), ({"question": "x", "extra": 1}, "invalid_request")):
        r = c.post("/api/queue", json=body, base_url=BASE)
        assert r.status_code == 400 and r.get_json()["error"]["code"] == code, (body, r.get_json())
    assert c.post("/api/queue", data="pas du json", content_type="text/plain", base_url=BASE).status_code == 415
    assert c.post("/api/queue", data="{", content_type="application/json", base_url=BASE).status_code == 400
    assert app.wait_queue.snapshot()["waiting"] == 0 and not app.wait_queue.snapshot()["running"]


def test_api_full_queue_returns_429_with_retry_after():
    g = Gated()
    svc = S.Service(agent=fakes.make_agent(), llm_probe=lambda: {"online": True, "model": "x", "model_matches": True}, smalltalk_llm=lambda q, st: None)
    svc.warm_up()
    c = create_app(svc, PORT, wait_queue=W.WaitQueue(g, max_size=1, per_ip=1)).test_client()
    assert submit(c, "plafond").status_code == 202
    r = submit(c, "autre question")
    assert r.status_code == 429 and r.get_json()["error"]["code"] in ("queue_full", "queue_ip_limit") and r.headers.get("Retry-After") == "30"
    g.release()


def test_api_status_announces_the_queue_and_the_default_is_off():
    _, c, _, _ = build(max_size=4)
    d = c.get("/api/status", base_url=BASE).get_json()
    assert d["queue"]["enabled"] is True and d["queue"]["max"] == 4 and d["queue"]["waiting"] == 0 and d["queue"]["running"] is False
    _, c2, _, _ = build(queue=False)
    assert c2.get("/api/status", base_url=BASE).get_json()["queue"] == {"enabled": False}
    assert submit(c2, "plafond").status_code == 404, "sans file d'attente : la route n'existe pas"


def test_api_unknown_or_malformed_ticket_is_404_and_cancel_is_safe():
    _, c, _, _ = build(max_size=4)
    for path in ("/api/queue/inconnu", "/api/queue/" + "a" * 30, "/api/queue/" + "a" * 200):
        r = c.get(path, base_url=BASE)
        assert r.status_code == 404 and r.get_json()["error"]["code"] == "ticket_unknown", (path, r.get_json())
    assert c.post("/api/queue/" + "a" * 30 + "/cancel", base_url=BASE).get_json() == {"cancelled": False}


def test_api_cancel_a_waiting_question():
    g = Gated()
    svc = S.Service(agent=fakes.make_agent(), llm_probe=lambda: {"online": True, "model": "x", "model_matches": True}, smalltalk_llm=lambda q, st: None)
    svc.warm_up()
    c = create_app(svc, PORT, wait_queue=W.WaitQueue(g, max_size=4, per_ip=3)).test_client()
    assert submit(c, "plafond").status_code == 202
    until(lambda: g.started == ["plafond"], "première question en cours")
    v = submit(c, "deuxième question").get_json()
    assert v["state"] == "queued" and v["ahead"] == 1
    assert c.post(f"/api/queue/{v['ticket']}/cancel", base_url=BASE).get_json() == {"cancelled": True}
    assert c.get(f"/api/queue/{v['ticket']}", base_url=BASE).status_code == 404
    g.release()


def test_api_direct_chat_still_answers_busy_while_the_engine_is_held():
    svc, c, _, _ = build(max_size=4)
    assert svc._lock.acquire(blocking=False)
    try:
        r = c.post("/api/chat", json={"question": "plafond"}, base_url=BASE)
        assert r.status_code == 429 and r.get_json()["error"]["code"] == "busy"
    finally:
        svc._lock.release()


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
    print(f"\nTests file d'attente : {len(TESTS) - len(failed)}/{len(TESTS)}")
    sys.exit(1 if failed else 0)
