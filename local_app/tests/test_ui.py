"""Tests de l'interface (Edge/Chrome sans fenêtre piloté par DevTools, voir test_ui.mjs). Démarre deux serveurs de test (faux agent) sur des ports libres,
lance Node, puis affiche « Tests UI : X/Y ». Lancer : python local_app/tests/test_ui.py"""
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(port: int, *extra) -> subprocess.Popen:
    # stderr vers DEVNULL : un tube jamais vidé se remplit (4 Ko sous Windows) et bloquerait le serveur après quelques dizaines de requêtes
    p = subprocess.Popen([sys.executable, "-m", "local_app.tests.stub_server", "--port", str(port), *extra], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    t0 = time.time()
    while time.time() - t0 < 30:
        if p.stdout.readline().strip() == "pret":
            return p
        if p.poll() is not None:
            raise RuntimeError("serveur de test arrêté : " + (p.stdout.read() or ""))
    raise RuntimeError("serveur de test non prêt")


def main() -> int:
    node = shutil.which("node") or "node"
    p1, p2, p3 = free_port(), free_port(), free_port()
    s1 = start(p1, "--delay", "0.7")
    s2 = start(p2, "--delay", "0.2", "--llm-offline")
    s3 = start(p3, "--delay", "3", "--queue", "4", "--persist", "tmp", "--push")            # file persistante + notifications annoncées (envoi simulé)
    try:
        env = dict(os.environ, UI_URL=f"http://127.0.0.1:{p1}/", UI_URL_LLM_OFF=f"http://127.0.0.1:{p2}/", UI_URL_PERSIST=f"http://127.0.0.1:{p3}/")
        r = subprocess.run([node, "--test", "--test-timeout=180000", "--test-reporter=spec", str(ROOT / "local_app" / "tests" / "test_ui.mjs")], env=env, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        out = r.stdout + r.stderr
        print(out)
        passed = int(re.search(r"ℹ pass (\d+)", out).group(1)) if re.search(r"ℹ pass (\d+)", out) else 0
        total = int(re.search(r"ℹ tests (\d+)", out).group(1)) if re.search(r"ℹ tests (\d+)", out) else 0
        print(f"Tests UI : {passed}/{total}")
        return 0 if r.returncode == 0 and total and passed == total else 1
    finally:
        for s in (s1, s2, s3):
            s.terminate()


if __name__ == "__main__":
    sys.exit(main())
