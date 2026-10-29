"""Web Push : prévenir un navigateur qu'une réponse est prête, même si le site est fermé.

Implémentation minimale avec la seule bibliothèque `cryptography` (aucun service tiers, aucune autre dépendance) :
* RFC 8030 — envoi d'un message HTTP POST au service push du navigateur (Google, Mozilla, Apple, Microsoft) ;
* RFC 8291 + RFC 8188 — chiffrement du contenu (aes128gcm) : le service push ne lit jamais le message ;
* RFC 8292 — VAPID : le serveur s'identifie par une paire de clés P-256 générée au premier démarrage et conservée hors du dépôt (mode 600).

Sécurité : l'adresse de l'abonnement vient du navigateur du visiteur. La contacter telle quelle ouvrirait une faille SSRF (le serveur appellerait n'importe quelle
adresse interne). Elle doit donc être en HTTPS, sans identifiants ni port particulier, et appartenir à la liste fermée des services push connus (ALLOWED_HOSTS).
Les redirections ne sont pas suivies. Le contenu d'une notification ne contient ni la question ni la réponse."""
import base64
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    AVAILABLE = True
except ImportError:                                  # Web Push désactivé proprement : le service ne dépend jamais des notifications
    AVAILABLE = False

# Un nom commençant par « . » désigne tous ses sous-domaines (jamais le domaine seul).
ALLOWED_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com")
RECORD_SIZE = 4096
_B64U = re.compile(r"[A-Za-z0-9_-]+")


class PushError(Exception):
    pass


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64u(text: str) -> bytes:
    if not isinstance(text, str) or not _B64U.fullmatch(text):
        raise ValueError("base64url invalide")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def host_allowed(host: str, allowed=ALLOWED_HOSTS) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == a or (a.startswith(".") and host.endswith(a) and len(host) > len(a)) for a in allowed)


def validate_subscription(sub, allowed=ALLOWED_HOSTS) -> dict:
    """Vérifie l'abonnement envoyé par le navigateur et renvoie {endpoint, p256dh, auth} (ValueError sinon)."""
    if not AVAILABLE:
        raise ValueError("Web Push indisponible")
    if not isinstance(sub, dict) or not isinstance(sub.get("keys"), dict):
        raise ValueError("abonnement mal formé")
    endpoint = sub.get("endpoint")
    if not isinstance(endpoint, str) or not 20 <= len(endpoint) <= 1000:
        raise ValueError("adresse d'abonnement invalide")
    parts = urlsplit(endpoint)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.port not in (None, 443) or parts.fragment:
        raise ValueError("adresse d'abonnement refusée")
    if not host_allowed(parts.hostname, allowed):
        raise ValueError("service push non reconnu")
    p256dh, auth = unb64u(sub["keys"].get("p256dh")), unb64u(sub["keys"].get("auth"))
    if len(auth) != 16 or len(p256dh) != 65 or p256dh[0] != 4:
        raise ValueError("clés d'abonnement invalides")
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), p256dh)       # ValueError si le point n'est pas sur la courbe
    return {"endpoint": endpoint, "p256dh": b64u(p256dh), "auth": b64u(auth)}


def encrypt(payload: bytes, p256dh: bytes, auth: bytes) -> bytes:
    """Corps chiffré « aes128gcm » (RFC 8291) : salt(16) | taille d'enregistrement(4) | longueur d'identifiant(1) | clé publique éphémère(65) | chiffré."""
    if len(payload) > RECORD_SIZE - 17 - 2:
        raise PushError("message trop long")
    eph = ec.generate_private_key(ec.SECP256R1())
    eph_pub = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = eph.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), p256dh))
    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + p256dh + eph_pub).derive(shared)
    salt = os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    sealed = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)                 # 0x02 : dernier (et seul) enregistrement
    return salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(eph_pub)]) + eph_pub + sealed


class Vapid:
    """Paire de clés VAPID du serveur : créée au premier démarrage, lisible par le seul compte du service (mode 600), jamais dans le dépôt."""

    def __init__(self, key_path):
        path = Path(key_path)
        if path.is_file():
            self._key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        else:
            self._key = ec.generate_private_key(ec.SECP256R1())
            path.parent.mkdir(parents=True, exist_ok=True)
            pem = self._key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(pem)
        self.public_bytes = self._key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.public_b64u = b64u(self.public_bytes)

    def authorization(self, endpoint: str, subject: str, now=None) -> str:
        parts = urlsplit(endpoint)
        head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        claims = b64u(json.dumps({"aud": f"{parts.scheme}://{parts.hostname}", "exp": int((now or time.time()) + 12 * 3600), "sub": subject}, separators=(",", ":")).encode())
        r, s = decode_dss_signature(self._key.sign(f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
        return f"vapid t={head}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}, k={self.public_b64u}"


class WebPush:
    def __init__(self, vapid: Vapid, subject: str, post=None, timeout=10):
        self.vapid, self.subject, self.timeout = vapid, subject, timeout
        self._post = post                              # (url, data, headers, timeout) -> status ; les tests injectent un double

    def send(self, sub: dict, message: dict, ttl: int = 86400) -> int:
        """Envoie un message chiffré. Renvoie le code HTTP du service push (201 = accepté ; 404/410 = abonnement expiré). PushError si le service est injoignable."""
        body = encrypt(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), unb64u(sub["p256dh"]), unb64u(sub["auth"]))
        headers = {"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(ttl), "Urgency": "normal",
                   "Authorization": self.vapid.authorization(sub["endpoint"], self.subject)}
        try:
            if self._post is not None:
                return int(self._post(sub["endpoint"], body, headers, self.timeout))
            import requests
            return requests.post(sub["endpoint"], data=body, headers=headers, timeout=self.timeout, allow_redirects=False).status_code
        except PushError:
            raise
        except Exception as e:                         # réseau, DNS, expiration : le détail éventuel n'est jamais journalisé (il pourrait contenir l'adresse)
            raise PushError(type(e).__name__) from None


def message_for(state: str, url: str) -> dict:
    """Contenu générique : ni la question ni la réponse ne transitent par le service push."""
    if state == "done":
        return {"title": "Votre réponse est disponible !", "body": "Revenez découvrir la réponse à votre question.", "url": url}
    return {"title": "Votre demande est terminée", "body": "Ouvrez le suivi pour en connaître le résultat.", "url": url}
