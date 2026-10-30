"""Tests du mode réseau OPTIONNEL (local_app/lan.py) avec un FAUX agent : accès, code, sessions, blocage, hôtes, liaisons réseau. Aucun modèle n'est chargé,
aucune adresse du réseau réel n'est utilisée (la seconde liaison est testée sur 127.0.0.2).
Lancer : python local_app/tests/test_lan.py   (affiche « Tests réseau : X/Y »)."""
import json
import os
import socket
import sys
import tempfile
import threading
import traceback
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from local_app import lan as L                         # noqa: E402
from local_app import service as S                     # noqa: E402
from local_app.server import create_app, make_servers  # noqa: E402
from local_app.tests import fakes                      # noqa: E402

PORT = 8798
IP = "10.5.210.25"
CODE = "K7QM-4TXD-9PWE"
HOST = f"{IP}:{PORT}"
BASE = f"http://{HOST}"
os.environ["AGENT_LLM"] = "local"


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def build(clock=None, lan=True):
    state = {"online": True}
    svc = S.Service(agent=fakes.make_agent(state=state), llm_probe=lambda: {"online": True, "model": "qwen3-4b-instruct-2507-q4_k_m", "model_matches": True})
    svc.warm_up()
    access = L.LanAccess(IP, CODE, clock=clock or Clock()) if lan else None
    return svc, create_app(svc, PORT, access).test_client(), access


def login(c, code=CODE, **kw):
    return c.post("/login", data={"code": code}, base_url=BASE, **kw)


def test_default_mode_is_unchanged_loopback_only():
    _, c, _ = build(lan=False)
    assert c.get("/api/health", base_url=BASE).status_code == 403                 # adresse réseau refusée sans mode réseau
    assert c.get("/login", base_url=f"http://127.0.0.1:{PORT}").status_code == 404
    assert c.get("/api/status", base_url=f"http://127.0.0.1:{PORT}").status_code == 200   # aucun code en mode local


def test_everything_but_the_login_page_requires_a_session():
    _, c, _ = build()
    for path in ("/", "/index.html", "/app.js", "/app.css"):
        r = c.get(path, base_url=BASE)
        assert r.status_code == 302 and r.headers["Location"].endswith("/login"), path
    for path in ("/api/status",):
        r = c.get(path, base_url=BASE)
        assert r.status_code == 401 and r.get_json()["error"]["code"] == "auth_required"
    r = c.post("/api/chat", json={"question": "plafond"}, base_url=BASE)
    assert r.status_code == 401
    assert c.get("/api/health", base_url=BASE).status_code == 200
    assert c.get("/login.css", base_url=BASE).status_code == 200
    for icon, magic in (("/favicon.ico", b"\x00\x00\x01\x00"), ("/favicon.svg", b"<svg"), ("/apple-touch-icon.png", b"\x89PNG")):      # icônes publiques (la page d'accès les affiche) : de vraies images, rien d'autre
        r = c.get(icon, base_url=BASE)
        assert r.status_code == 200 and r.get_data().startswith(magic), icon
    r = c.get("/login", base_url=BASE)
    assert r.status_code == 200 and "Code d'accès" in r.get_data(as_text=True)
    assert 'rel="icon" href="favicon.ico"' in r.get_data(as_text=True) and 'rel="apple-touch-icon"' in r.get_data(as_text=True)
    assert "form-action 'self'" in r.headers["Content-Security-Policy"] and "script-src" not in r.headers["Content-Security-Policy"]


def test_login_page_is_self_contained_and_marked_unofficial():
    page = L.login_page("x")
    assert "<script" not in page.lower() and "style=" not in page.lower() and "onclick" not in page.lower()
    assert "http://" not in page and "https://" not in page
    assert "NON OFFICIEL" in page and "ni affilié" in page


def test_wrong_code_gives_no_session():
    _, c, _ = build()
    r = login(c, "mauvais-code")
    assert r.status_code == 401 and "incorrect" in r.get_data(as_text=True) and "Set-Cookie" not in r.headers
    assert c.get("/api/status", base_url=BASE).status_code == 401


def test_right_code_opens_a_session_with_a_strict_cookie():
    _, c, _ = build()
    r = login(c)
    assert r.status_code == 303 and r.headers["Location"].endswith("/")
    cookie = r.headers["Set-Cookie"]
    assert cookie.startswith(L.COOKIE + "=") and "HttpOnly" in cookie and "SameSite=Strict" in cookie and "Path=/" in cookie
    assert CODE not in cookie
    page = c.get("/", base_url=BASE)
    assert page.status_code == 200 and "form-action 'none'" in page.headers["Content-Security-Policy"]
    assert c.get("/api/status", base_url=BASE).status_code == 200
    r = c.post("/api/chat", json={"question": "plafond"}, base_url=BASE)
    assert r.status_code == 200 and r.get_json()["status"] == "answered"


def test_five_wrong_codes_lock_the_address_for_five_minutes():
    clock = Clock()
    _, c, _ = build(clock)
    for _ in range(L.MAX_FAILS - 1):
        assert login(c, "faux-faux-faux").status_code == 401
    r = login(c, "faux-faux-faux")                                              # la cinquième erreur déclenche le blocage
    assert r.status_code == 429
    assert login(c).status_code == 429                                           # même le bon code est refusé pendant le blocage
    clock.t += L.LOCK_S - 1
    assert login(c).status_code == 429
    clock.t += 2
    assert login(c).status_code == 303                                           # le blocage a expiré


def test_lock_is_per_address():
    _, c, _ = build()
    for _ in range(L.MAX_FAILS):
        login(c, "faux-faux-faux", environ_overrides={"REMOTE_ADDR": "10.5.210.50"})
    assert login(c, environ_overrides={"REMOTE_ADDR": "10.5.210.50"}).status_code == 429
    assert login(c, environ_overrides={"REMOTE_ADDR": "10.5.210.51"}).status_code == 303


def test_forged_and_expired_sessions_are_refused():
    clock = Clock()
    _, c, lan = build(clock)
    c.set_cookie(L.COOKIE, "inventé-par-l-attaquant", domain=IP)
    assert c.get("/api/status", base_url=BASE).status_code == 401
    c2 = build(clock)[1]
    login(c2)
    assert c2.get("/api/status", base_url=BASE).status_code == 200
    clock.t += L.SESSION_TTL_S + 1
    assert c2.get("/api/status", base_url=BASE).status_code == 401


def test_only_this_machine_names_are_accepted_as_host():
    _, c, _ = build()
    names = {HOST, f"{IP}:{PORT}".upper(), f"{socket.gethostname().lower()}:{PORT}", f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
    for h in names:
        assert c.get("/api/health", base_url=f"http://{h}").status_code == 200, h
    for h in (f"evil.example:{PORT}", f"{IP}:{PORT + 1}", "10.5.210.26:%d" % PORT, f"evil.example.{socket.gethostname().lower()}:{PORT}"):
        r = c.get("/api/health", base_url=f"http://{h}")
        assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden_host", h


def test_cross_site_login_post_is_refused():
    _, c, _ = build()
    r = login(c, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden_origin"
    r = login(c, headers={"Origin": BASE})
    assert r.status_code == 303                                                  # l'origine de l'application elle-même passe


def test_access_code_is_never_logged():
    d = Path(tempfile.mkdtemp(prefix="lan_log_"))
    S.setup_logging(d / "api.log")
    try:
        _, c, _ = build()
        login(c, "essai-faux-1234")
        login(c)
        for h in list(S.LOG.handlers):
            h.flush()
        txt = (d / "api.log").read_text(encoding="utf-8")
        assert "login_failed" in txt and "login_ok" in txt
        assert CODE not in txt and "essai-faux-1234" not in txt
    finally:
        for h in list(S.LOG.handlers):
            S.LOG.removeHandler(h)
            h.close()


def test_configuration_is_validated_before_anything_listens():
    for bad in ("127.0.0.1", "0.0.0.0", "8.8.8.8", "169.254.10.1", "::1", "abc", "224.0.0.1", "", "10.5.210"):
        try:
            L.parse_lan_ip(bad)
        except SystemExit:
            continue
        raise AssertionError(f"adresse acceptée à tort : {bad!r}")
    for ok in ("10.5.210.25", "192.168.1.5", "172.20.0.3"):
        assert L.parse_lan_ip(ok) == ok
    saved = {k: os.environ.get(k) for k in (L.LAN_IP_ENV, L.CODE_ENV)}
    try:
        os.environ.pop(L.LAN_IP_ENV, None)
        os.environ[L.CODE_ENV] = CODE
        assert L.from_env() is None                                              # pas d'adresse = pas de mode réseau, quel que soit le code
        os.environ[L.LAN_IP_ENV] = IP
        for code in ("", "court", "x" * (L.MAX_CODE_LEN + 1)):
            os.environ[L.CODE_ENV] = code
            try:
                L.from_env()
            except SystemExit:
                continue
            raise AssertionError(f"code accepté à tort : {code!r}")
        os.environ[L.CODE_ENV] = CODE
        assert L.from_env().ip == IP
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_open_mode_needs_no_code_but_keeps_the_other_guards():
    state = {"online": True}
    svc = S.Service(agent=fakes.make_agent(state=state), llm_probe=lambda: {"online": True, "model": "m", "model_matches": True})
    svc.warm_up()
    c = create_app(svc, PORT, L.LanAccess(IP, None)).test_client()
    assert c.get("/", base_url=BASE).status_code == 200                          # aucune connexion demandée
    assert c.get("/api/status", base_url=BASE).status_code == 200
    r = c.post("/api/chat", json={"question": "plafond"}, base_url=BASE)
    assert r.status_code == 200 and r.get_json()["status"] == "answered"
    r = c.get("/login", base_url=BASE)
    assert r.status_code == 302 and r.headers["Location"].endswith("/")          # plus de page de code
    assert c.post("/login", data={"code": "x"}, base_url=BASE).status_code == 302
    r = c.get("/api/health", base_url=f"http://evil.example:{PORT}")             # l'en-tête Host reste contrôlé
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "forbidden_host"
    r = c.post("/api/chat", json={"question": "plafond"}, base_url=BASE, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403                                                  # l'origine reste contrôlée
    r = c.post("/api/chat", json={"question": "plafond"}, base_url=BASE, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


def test_open_mode_must_be_chosen_explicitly():
    saved = {k: os.environ.get(k) for k in (L.LAN_IP_ENV, L.CODE_ENV, L.NO_CODE_ENV)}
    try:
        os.environ[L.LAN_IP_ENV] = IP
        os.environ[L.CODE_ENV] = ""
        os.environ.pop(L.NO_CODE_ENV, None)
        try:
            L.from_env()
        except SystemExit:
            pass
        else:
            raise AssertionError("l'accès libre ne doit jamais être le défaut")
        os.environ[L.NO_CODE_ENV] = "0"
        try:
            L.from_env()
        except SystemExit:
            pass
        else:
            raise AssertionError("seule la valeur 1 active l'accès libre")
        os.environ[L.NO_CODE_ENV] = "1"
        lan = L.from_env()
        assert lan is not None and lan.open and lan.ip == IP
        os.environ[L.CODE_ENV] = CODE                                            # un code fourni l'emporte : jamais d'accès libre par accident
        assert not L.from_env().open
        os.environ[L.LAN_IP_ENV] = "8.8.8.8"                                     # l'adresse reste validée en accès libre
        os.environ[L.CODE_ENV] = ""
        try:
            L.from_env()
        except SystemExit:
            pass
        else:
            raise AssertionError("adresse publique acceptée")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(url, headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=5) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def test_two_listeners_only_loopback_and_the_given_address():
    port = _free_port()
    state = {"online": True}
    svc = S.Service(agent=fakes.make_agent(state=state), llm_probe=lambda: {"online": True, "model": "m", "model_matches": True})
    svc.warm_up()
    lan = L.LanAccess("127.0.0.2", CODE)                                         # 127.0.0.2 joue le rôle de la carte réseau (aucune adresse réelle utilisée)
    servers = make_servers(create_app(svc, port, lan), port, "127.0.0.2")
    threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
    for t in threads:
        t.start()
    try:
        assert sorted(s.server_address[0] for s in servers) == ["127.0.0.1", "127.0.0.2"]
        assert all(s.server_address[0] != "0.0.0.0" for s in servers)
        assert _get(f"http://127.0.0.1:{port}/api/health")[0] == 200
        assert _get(f"http://127.0.0.2:{port}/api/health")[0] == 200
        code, body = _get(f"http://127.0.0.2:{port}/api/status")
        assert code == 401 and json.loads(body)["error"]["code"] == "auth_required"
        assert _get(f"http://127.0.0.2:{port}/api/health", {"Host": f"evil.example:{port}"})[0] == 403
        with socket.socket() as s:                                               # aucune écoute sur une autre adresse de la machine
            s.settimeout(0.5)
            assert s.connect_ex(("127.0.0.3", port)) != 0
    finally:
        for s in servers:
            s.shutdown()
            s.server_close()


def test_failed_second_bind_releases_the_first():
    port = _free_port()
    blocker = socket.socket()
    blocker.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", socket.SO_REUSEADDR), 1)
    blocker.bind(("127.0.0.2", port))
    blocker.listen(1)
    try:
        svc = S.Service(agent=fakes.make_agent(state={"online": True}), llm_probe=lambda: {"online": True, "model": "m", "model_matches": True})
        try:
            make_servers(create_app(svc, port, L.LanAccess("127.0.0.2", CODE)), port, "127.0.0.2")
        except OSError:
            pass
        else:
            raise AssertionError("la liaison aurait dû échouer")
        with socket.socket() as s:                                               # le port de la boucle locale a bien été libéré
            s.bind(("127.0.0.1", port))
    finally:
        blocker.close()


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
    print(f"\nTests réseau : {len(TESTS) - len(failed)}/{len(TESTS)}")
    sys.exit(1 if failed else 0)
