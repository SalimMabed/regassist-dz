"""Serveur de test de l'interface : la VRAIE application (serveur, routes, interface) devant un faux agent aux scénarios scriptés (voir fakes.py).
Usage : python -m local_app.tests.stub_server --port 8793 [--delay 0.6]. N'écoute que sur 127.0.0.1 ; ne charge aucun modèle."""
import argparse
import os
import sys
import tempfile
from pathlib import Path

from .. import config as C
from ..server import LocalServer, RateLimiter, create_app
from ..service import Service, setup_logging
from ..waitqueue import WaitQueue
from . import fakes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--delay", type=float, default=0.6, help="durée simulée du traitement d'une question (secondes)")
    ap.add_argument("--llm-offline", action="store_true", help="simule llama-server éteint (sonde hors ligne)")
    ap.add_argument("--queue", type=int, default=0, help="active la file d'attente (nombre maximal de questions) comme en production")
    a = ap.parse_args()
    state = {"online": not a.llm_offline}
    setup_logging(Path(tempfile.mkdtemp(prefix="local_app_stub_")) / "api.log")
    svc = Service(agent=fakes.make_agent(delay=a.delay, state=state), llm_probe=lambda: {"online": state["online"], "model": "qwen3-4b-instruct-2507-q4_k_m", "model_matches": True},
                  smalltalk_llm=lambda q, st: None)            # jamais le vrai modèle dans les tests : textes fixes
    svc.warm_up()
    wq = WaitQueue(svc.chat, max_size=a.queue, per_ip=a.queue, eta_s=a.delay or 1.0) if a.queue > 0 else None
    srv = LocalServer(C.HOST, a.port, create_app(svc, a.port, rate_limiter=RateLimiter(max_requests=1000, window_s=60), wait_queue=wq))
    print("pret", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
