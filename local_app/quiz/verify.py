"""Vérifie chaque question du quiz contre le corpus réellement intégré : aucun numéro, aucune date, aucun titre ni aucune citation ne doit être de mémoire.

Deux niveaux : (1) toujours, contre `corpus/metadata`, `corpus/documents` et `corpus/extracted` (versionnés, donc vérifiables en CI) ;
(2) avec `pdf=True`, contre les PDF d'origine de `corpus/raw` lus par une autre bibliothèque que celle du pipeline (PyMuPDF) : page exacte, citation, nombre de pages.
"""
from __future__ import annotations

import json
import re
import unicodedata
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "corpus"
QUESTIONS = Path(__file__).with_name("questions.json")

KINDS = {"contenu", "objet", "valeur", "date", "numero", "type", "relation", "pages"}
MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
PAGE_MARK = re.compile(r"\[\[PAGE (\d+)\]\]")


def norm(text: str) -> str:
    """Comparaison tolérante à la casse, aux accents, aux apostrophes, aux césures et aux retours à la ligne (jamais aux chiffres ni aux mots)."""
    s = unicodedata.normalize("NFKD", text or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).casefold()
    for a, b in (("’", "'"), ("‘", "'"), ("«", '"'), ("»", '"'), ("“", '"'), ("”", '"'), ("–", "-"), ("—", "-"), ("­", ""), ("\xa0", " "), (" ", " ")):
        s = s.replace(a, b)
    s = re.sub(r"-\s+", "-", s).replace("/", "-")               # « n° 04/2025 » et « 04-2025 » désignent le même numéro
    return re.sub(r"\s+", " ", s).strip()


def french_date(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.day}{'er' if d.day == 1 else ''} {MONTHS[d.month - 1]} {d.year}"


def load_questions(path: Path = QUESTIONS) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class Corpus:
    """Accès en lecture au corpus français : métadonnées, texte extrait par page, PDF d'origine."""

    def __init__(self, root: Path = CORPUS):
        self.root = root
        meta = json.loads((root / "metadata" / "documents_fr.json").read_text(encoding="utf-8"))
        self.docs = {d["document_id"]: d for d in meta}
        self._pages: dict[str, dict[int, str]] = {}

    def doc(self, document_id: str) -> dict | None:
        return self.docs.get(document_id)

    def pages(self, document_id: str) -> dict[int, str]:
        if document_id not in self._pages:
            path = self.root / "extracted" / "fr" / f"{document_id}.txt"
            parts = PAGE_MARK.split(path.read_text(encoding="utf-8"))
            self._pages[document_id] = {int(parts[i]): parts[i + 1] for i in range(1, len(parts) - 1, 2)}
        return self._pages[document_id]

    def pdf_path(self, document_id: str) -> Path | None:
        d = self.docs.get(document_id)
        p = self.root / d["raw_path"] if d and d.get("raw_path") else None
        return p if p and p.is_file() else None

    def works_matching(self, iso_date: str, phrase: str) -> set[str]:
        """Œuvres (work_id) du corpus datées de ce jour dont l'intitulé contient la phrase : sert à prouver qu'une question désigne un seul texte."""
        return {d["work_id"] for d in self.docs.values() if d.get("date") == iso_date and norm(phrase) in norm(d["title"])}


def _pdf_pages(path: Path) -> list[str]:
    import fitz  # PyMuPDF : lecture indépendante du pipeline d'extraction

    with fitz.open(path) as pdf:
        return [page.get_text() for page in pdf]


def check_question(q: dict, corpus: Corpus, limits: dict | None = None, pdf: bool = False) -> list[str]:
    """Liste des problèmes de la question (vide = vérifiée)."""
    qid = q.get("id", "?")
    bad: list[str] = []

    def err(msg: str) -> None:
        bad.append(f"{qid} : {msg}")

    kind = q.get("kind")
    if kind not in KINDS:
        err(f"type de question inconnu ({kind})")
    for field in ("question", "choices", "answer", "explanation", "source", "check"):
        if field not in q:
            err(f"champ manquant : {field}")
    if bad:
        return bad
    choices, ans = q["choices"], q["answer"]
    if not 3 <= len(choices) <= 4:
        err("3 ou 4 réponses attendues")
    if not isinstance(ans, int) or not 0 <= ans < len(choices):
        err("index de bonne réponse invalide")
        return bad
    if len({norm(c) for c in choices}) != len(choices):
        err("deux réponses identiques")
    src, chk = q["source"], q["check"]
    doc = corpus.doc(src.get("document_id", ""))
    if doc is None:
        err(f"document source introuvable dans le corpus : {src.get('document_id')}")
        return bad
    if doc.get("language") != "fr" or doc.get("format") != "pdf":
        err("le document source doit être un PDF français du corpus")
    if not str(doc.get("document_url", "")).startswith("https://www.bank-of-algeria.dz/"):
        err("lien du document original absent ou hors du site de la Banque d'Algérie")
    page = src.get("page")
    if not isinstance(page, int) or not 1 <= page <= int(doc.get("page_count") or 0):
        err(f"page {page} hors du document ({doc.get('page_count')} pages)")
        return bad
    quote = src.get("quote", "")
    if len(norm(quote)) < 12:
        err("citation trop courte ou absente")
    title = doc["title"]
    number = str(doc.get("number") or "")

    # 1) la citation figure à la page indiquée du texte extrait
    text = corpus.pages(doc["document_id"]).get(page, "")
    if norm(quote) not in norm(text):
        err(f"la citation ne figure pas à la page {page} du texte extrait : « {quote[:70]} »")

    # 2) règles propres au type de question
    if kind == "contenu":
        ev = chk.get("evidence") or []
        if not ev:
            err("aucune preuve (evidence) indiquée pour la bonne réponse")
        for e in ev:
            if norm(e) not in norm(quote):
                err(f"la preuve « {e} » ne figure pas dans la citation")
    else:
        if kind != "pages" and not (number and norm(number) in norm(q["question"]) or kind in ("date", "numero")):
            err(f"la question ne cite pas le numéro du texte ({number})")
    if kind in ("objet", "valeur", "relation"):
        good = chk.get("title_contains", "")
        if not good or norm(good) not in norm(title):
            err("la bonne réponse n'est pas dans l'intitulé du texte")
        if norm(good) not in norm(text):
            err("la bonne réponse n'est pas dans la page de l'intitulé")
        for ex in chk.get("title_excludes") or []:
            if norm(ex) in norm(title):
                err(f"une réponse fausse figure pourtant dans l'intitulé : {ex}")
        if len(chk.get("title_excludes") or []) != len(choices) - 1:
            err("une réponse fausse n'est pas contrôlée (title_excludes)")
    if kind in ("date", "numero"):
        desig = chk.get("designation") or {}
        works = corpus.works_matching(desig.get("date", ""), desig.get("phrase", ""))
        if works != {doc["work_id"]}:
            err(f"la question ne désigne pas un seul texte : {sorted(works)}")
    if kind == "date":
        if chk.get("date") != doc.get("date"):
            err(f"date du corpus : {doc.get('date')}")
        wanted = french_date(doc["date"])
        if choices[ans] != wanted:
            err(f"la bonne réponse devrait s'écrire « {wanted} »")
        if any(c == wanted for i, c in enumerate(choices) if i != ans):
            err("une réponse fausse reprend la bonne date")
    if kind == "numero":
        if chk.get("number") != number or number not in choices[ans]:
            err(f"numéro du corpus : {number}")
        if any(number in c for i, c in enumerate(choices) if i != ans):
            err("une réponse fausse reprend le bon numéro")
    if kind == "type":
        if chk.get("document_type") != doc.get("document_type") or not title.startswith(chk.get("title_starts", "\0")):
            err(f"type du corpus : {doc.get('document_type')}")
    if kind == "pages":
        n = chk.get("page_count")
        if n != doc.get("page_count") or not choices[ans].startswith(f"{n} "):
            err(f"nombre de pages du corpus : {doc.get('page_count')}")
        if any(c.startswith(f"{n} ") for i, c in enumerate(choices) if i != ans):
            err("une réponse fausse reprend le bon nombre de pages")

    # 3) limite signalée : sa preuve est vérifiée à son tour
    lim = q.get("limit")
    if lim:
        spec = (limits or {}).get(lim)
        if not spec:
            err(f"limite inconnue : {lim}")
        else:
            other = spec["check"]
            full = " ".join(corpus.pages(other["document_id"]).values())
            if norm(other["contains"]) not in norm(full):
                err(f"la limite « {lim} » n'est pas établie par {other['document_id']}")

    # 4) contrôle indépendant dans le PDF d'origine
    if pdf:
        path = corpus.pdf_path(doc["document_id"])
        if path is None:
            err("PDF d'origine absent de corpus/raw : contrôle indépendant impossible")
        else:
            pages = _pdf_pages(path)
            if len(pages) != doc.get("page_count"):
                err(f"le PDF compte {len(pages)} pages, le corpus indique {doc.get('page_count')}")
            elif norm(quote) not in norm(pages[page - 1]):
                err(f"la citation n'est pas à la page {page} du PDF d'origine")
            if kind == "pages" and chk.get("page_count") != len(pages):
                err(f"le PDF compte {len(pages)} pages")
    return bad


def check_all(path: Path = QUESTIONS, corpus: Corpus | None = None, pdf: bool = False) -> list[str]:
    data = load_questions(path)
    corpus = corpus or Corpus()
    bad: list[str] = []
    ids = [q.get("id") for q in data["questions"]]
    if len(set(ids)) != len(ids):
        bad.append("identifiants de question en double")
    for q in data["questions"]:
        bad += check_question(q, corpus, data.get("limits"), pdf=pdf)
    return bad
