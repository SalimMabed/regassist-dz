"""Tests du module Web Push (local_app/webpush.py) : chiffrement RFC 8291, signature VAPID RFC 8292, envoi, contenu des messages. Aucun accès réseau.
Le déchiffrement est refait ICI, côté navigateur, avec les primitives de `cryptography` ; si la bibliothèque de référence `http_ece` est installée (ce n'est pas une
dépendance du projet), elle sert en plus de contre-vérification d'interopérabilité. Lancer : python local_app/tests/test_webpush.py"""
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from local_app import webpush as W                     # noqa: E402

if W.AVAILABLE:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def ua_keys():
    priv = ec.generate_private_key(ec.SECP256R1())
    return priv, priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint), os.urandom(16)


def browser_decrypt(body: bytes, priv, pub: bytes, auth: bytes) -> bytes:
    """Ce que fait le navigateur à la réception (RFC 8291 §3.4), écrit indépendamment de `encrypt`."""
    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    eph, sealed = body[21:21 + idlen], body[21 + idlen:]
    assert rs == 4096 and idlen == 65
    secret = priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), eph))
    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + pub + eph).derive(secret)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    plain = AESGCM(cek).decrypt(nonce, sealed, None)
    assert plain.endswith(b"\x02"), "délimiteur de dernier enregistrement"
    return plain[:-1]


def test_encrypted_message_is_readable_by_the_browser_and_only_by_it():
    priv, pub, auth = ua_keys()
    for msg in ("Votre réponse est disponible !".encode(), b"x", ("é" * 1500).encode()):
        body = W.encrypt(msg, pub, auth)
        assert browser_decrypt(body, priv, pub, auth) == msg
        assert len(msg) < 16 or msg not in body, "le contenu ne doit pas apparaître en clair"          # un octet isolé peut figurer par hasard dans le bruit chiffré
    other, other_pub, other_auth = ua_keys()
    body = W.encrypt(b"secret", pub, auth)
    for p, pb, a in ((other, other_pub, auth), (priv, pub, other_auth)):
        try:
            browser_decrypt(body, p, pb, a)
            raise AssertionError("un autre navigateur ou une autre clé d'authentification a pu lire le message")
        except Exception as e:
            assert not isinstance(e, AssertionError) or "un autre" not in str(e)
    assert W.encrypt(b"a", pub, auth) != W.encrypt(b"a", pub, auth), "sel et clé éphémère différents à chaque envoi"
    try:
        W.encrypt(b"z" * 5000, pub, auth)
        raise AssertionError("message trop long accepté")
    except W.PushError:
        pass


def test_reference_implementation_reads_our_messages_when_installed():
    try:
        import http_ece
    except ImportError:
        print("        (http_ece absente : contre-vérification d'interopérabilité ignorée)")
        return
    priv, pub, auth = ua_keys()
    msg = "Votre réponse est disponible !".encode()
    assert http_ece.decrypt(W.encrypt(msg, pub, auth), private_key=priv, auth_secret=auth) == msg


def test_vapid_key_is_created_once_private_and_signs_valid_tokens():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "etat" / "vapid_private.pem"
        v = W.Vapid(path)
        assert path.is_file() and W.Vapid(path).public_b64u == v.public_b64u, "la clé est conservée entre deux démarrages"
        if os.name != "nt":
            assert oct(path.stat().st_mode & 0o777) == "0o600"
        assert len(v.public_bytes) == 65 and v.public_bytes[0] == 4
        header = v.authorization("https://fcm.googleapis.com/fcm/send/xyz", "https://regassist.example.org", now=1_000_000)
        jwt, k = header[len("vapid t="):].split(", k=")
        h, c, s = jwt.split(".")
        raw = W.unb64u(s)
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), W.unb64u(k))
        pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")), f"{h}.{c}".encode(), ec.ECDSA(hashes.SHA256()))
        claims = json.loads(W.unb64u(c))
        assert claims == {"aud": "https://fcm.googleapis.com", "exp": 1_000_000 + 12 * 3600, "sub": "https://regassist.example.org"}


def test_send_posts_an_encrypted_authenticated_message_and_reports_the_status():
    priv, pub, auth = ua_keys()
    seen = {}

    def post(url, data, headers, timeout):
        seen.update(url=url, data=data, headers=headers, timeout=timeout)
        return 201
    with tempfile.TemporaryDirectory() as d:
        wp = W.WebPush(W.Vapid(Path(d) / "k.pem"), "https://regassist.example.org", post=post)
        sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc123def456ghi789", "p256dh": W.b64u(pub), "auth": W.b64u(auth)}
        assert wp.send(sub, W.message_for("done", "/#q=" + "a" * 22)) == 201
        h = seen["headers"]
        assert seen["url"] == sub["endpoint"] and h["Content-Encoding"] == "aes128gcm" and h["TTL"] == "86400" and h["Authorization"].startswith("vapid t=") and seen["timeout"] == 10
        msg = json.loads(browser_decrypt(seen["data"], priv, pub, auth))
        assert msg == {"title": "Votre réponse est disponible !", "body": "Revenez découvrir la réponse à votre question.", "url": "/#q=" + "a" * 22}

        def boom(*a):
            raise ConnectionError("https://fcm.googleapis.com/fcm/send/abc123def456ghi789 injoignable")
        try:
            W.WebPush(wp.vapid, "https://x.example", post=boom).send(sub, {"title": "t"})
            raise AssertionError("panne réseau non signalée")
        except W.PushError as e:
            assert "fcm" not in str(e) and "http" not in str(e), "le détail de l'adresse ne fuit pas dans l'erreur"


def test_messages_are_generic_and_never_carry_question_or_answer_text():
    for state in ("done", "error"):
        m = W.message_for(state, "/#q=" + "b" * 22)
        assert set(m) == {"title", "body", "url"} and len(m["title"]) < 60 and len(m["body"]) < 100
    assert W.message_for("done", "/")["title"] == "Votre réponse est disponible !"


def test_service_worker_only_accepts_a_tracking_link_from_the_push_message():
    sw = (ROOT / "local_app" / "static" / "sw.js").read_text(encoding="utf-8")
    assert r"/^\/#q=[A-Za-z0-9_-]{16,64}$/" in sw, "l'adresse ouverte au clic est limitée à un lien de suivi du site"
    assert "openWindow(url)" in sw and "showNotification" in sw and "userVisibleOnly" not in sw


TESTS = [(n, f) for n, f in sorted(globals().items(), key=lambda kv: kv[1].__code__.co_firstlineno if callable(kv[1]) and hasattr(kv[1], "__code__") else 0) if n.startswith("test_")]

if __name__ == "__main__":
    if not W.AVAILABLE:
        print("Tests Web Push : bibliothèque `cryptography` absente, tests ignorés (Web Push désactivé proprement)")
        sys.exit(0)
    failed = []
    for name, fn in TESTS:
        try:
            fn()
            print("ok     ", name)
        except Exception:
            failed.append(name)
            print("ECHEC  ", name)
            traceback.print_exc()
    print(f"\nTests Web Push : {len(TESTS) - len(failed)}/{len(TESTS)}")
    sys.exit(1 if failed else 0)
