"""Tests de la banque de questions du quiz d'attente : chaque fait est vérifié contre le corpus (et contre les PDF d'origine quand ils sont présents),
le fichier de données généré est à jour, et le vérificateur détecte bien une question fausse. Aucun accès réseau, aucun modèle.
Lancer : python local_app/tests/test_quiz_data.py"""
import copy
import json
import re
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from local_app.quiz import build, verify                # noqa: E402

CORPUS = verify.Corpus()
DATA = verify.load_questions()
QUESTIONS = DATA["questions"]


def mutated(qid, edit):
    q = copy.deepcopy(next(x for x in QUESTIONS if x["id"] == qid))
    edit(q)
    return verify.check_question(q, CORPUS, DATA.get("limits"))


def test_every_question_is_verified_against_the_corpus():
    problems = verify.check_all(corpus=CORPUS)
    assert not problems, "\n".join(problems)


def test_questions_are_also_verified_in_the_original_pdfs_when_available():
    if not (verify.CORPUS / "raw").is_dir():
        print("        (corpus/raw absent : contrôle dans les PDF d'origine ignoré ; il se lance avec python -m local_app.quiz.build --pdf)")
        return
    problems = verify.check_all(corpus=CORPUS, pdf=True)
    assert not problems, "\n".join(problems)


def test_generated_data_file_is_up_to_date_and_comes_from_the_corpus_only():
    text = build.render(build.build_payload(CORPUS))
    assert build.OUT.read_bytes().decode("utf-8") == text, "quiz-data.js n'est pas à jour : python -m local_app.quiz.build"
    payload = build.build_payload(CORPUS)
    for q in payload["questions"]:
        if q["kind"] == "assistant":                       # source = texte de l'application : ni PDF, ni numéro, ni date, ni page
            s = q["source"]
            assert s["type"] == "application" and s["url"] is None and s["page"] is None and s["number"] is None and s["date"] is None and s["title"] == build.APP_TITLE, q["id"]
            continue
        doc = CORPUS.doc(q["source"]["document_id"])
        assert q["source"]["title"] == doc["title"] and q["source"]["number"] == doc.get("number") and q["source"]["date"] == doc.get("date"), q["id"]
        assert q["source"]["url"].startswith("https://www.bank-of-algeria.dz/") and " " not in q["source"]["url"], q["id"]


def test_the_bank_is_varied_and_every_question_carries_a_complete_reference():
    assert len(QUESTIONS) >= 15, "assez de questions pour que deux parties successives diffèrent"
    kinds = {q["kind"] for q in QUESTIONS}
    assert {"contenu", "objet", "date", "numero", "valeur", "assistant"} <= kinds, kinds
    assert len({q["id"] for q in QUESTIONS}) == len(QUESTIONS)
    assert len({q["source"]["document_id"] for q in QUESTIONS}) >= 12, "plusieurs textes différents"
    assert sum(q["kind"] == "assistant" for q in QUESTIONS) >= 6, "assez de questions sur l'assistant pour varier d'une série à l'autre"
    for q in build.build_payload(CORPUS)["questions"]:
        s = q["source"]
        assert q["question"].strip() and q["explanation"].strip() and 3 <= len(q["choices"]) <= 4 and 0 <= q["answer"] < len(q["choices"]), q["id"]
        if q["kind"] == "assistant":
            assert all(s[k] for k in ("title", "type", "reference", "quote")), q["id"]
            continue
        assert all(s[k] for k in ("title", "type", "reference", "page", "quote", "url")), q["id"]
        if s["page"] > 1:
            assert s["url"].endswith("#page=%d" % s["page"]), q["id"]


def test_content_questions_cite_the_article_and_every_law_question_states_its_limit():
    content = [q for q in QUESTIONS if q["kind"] == "contenu"]
    assert len(content) >= 5
    for q in content:
        assert re.match(r"Article \d+|Article 1er", q["source"]["reference"]), q["id"]
    for q in QUESTIONS:
        if q["source"]["document_id"] == "LOI-23-09.fr" and q["kind"] == "contenu":
            assert q.get("limit") == "loi-23-09-modifiee", q["id"]
    payload = {q["id"]: q for q in build.build_payload(CORPUS)["questions"]}
    assert "modifiée" in payload["loi-23-09-art-01-centimes"]["limit"]


def test_the_verifier_detects_a_wrong_quote_page_date_number_or_document():
    assert mutated("loi-23-09-art-05-delai", lambda q: q["source"].update(quote="de vingt (20) ans, à compter de la date de la décision de retrait")), "citation inventée non détectée"
    assert mutated("loi-23-09-art-05-delai", lambda q: q["source"].update(page=2)), "mauvaise page non détectée"
    assert mutated("loi-23-09-art-05-delai", lambda q: q["source"].update(page=999)), "page hors document non détectée"
    assert mutated("reg-20-01-date", lambda q: q["choices"].__setitem__(0, "16 mars 2020")), "mauvaise date non détectée"
    assert mutated("reg-20-01-date", lambda q: q["choices"].__setitem__(1, "15 mars 2020")), "fausse réponse reprenant la bonne date non détectée"
    assert mutated("reg-26-01-numero", lambda q: q["choices"].__setitem__(0, "n° 26-11")), "mauvais numéro non détecté"
    assert mutated("reg-18-02-date", lambda q: q["check"]["designation"].update(phrase="règlement")), "question désignant plusieurs textes non détectée"
    assert mutated("reg-23-01-objet", lambda q: q["check"].update(title_contains="relatif à l’affacturage")), "objet absent de l'intitulé non détecté"
    assert mutated("reg-23-01-objet", lambda q: q["check"].update(title_excludes=["bureaux de change", "x", "y"])), "fausse réponse présente dans l'intitulé non détectée"
    assert mutated("loi-23-09-pages", lambda q: q["check"].update(page_count=40)), "mauvais nombre de pages non détecté"
    assert mutated("ins-01-2000-type", lambda q: q["check"].update(document_type="règlement")), "mauvais type non détecté"
    assert mutated("loi-23-09-art-01-centimes", lambda q: q["source"].update(document_id="INCONNU.fr")), "document inexistant non détecté"
    assert mutated("loi-23-09-art-01-centimes", lambda q: q["check"].update(evidence=["cent mille parts"])), "preuve absente de la citation non détectée"
    assert mutated("loi-23-09-art-01-centimes", lambda q: q.update(limit="inexistante")), "limite inconnue non détectée"
    assert mutated("loi-23-09-art-01-centimes", lambda q: q["choices"].__setitem__(1, q["choices"][0])), "réponses identiques non détectées"
    assert mutated("loi-23-09-art-01-centimes", lambda q: q.update(answer=9)), "index invalide non détecté"
    assert not mutated("loi-23-09-art-01-centimes", lambda q: None), "la question intacte doit rester valide"


def test_the_assistant_questions_are_proved_by_the_real_text_of_the_application():
    """Une question sur l'assistant n'est valable que si sa citation figure mot pour mot dans le texte de l'application (index.html), et elle ne l'est plus si ce texte change."""
    assert not mutated("assistant-formation", lambda q: None), "la question intacte doit rester valide"
    assert mutated("assistant-formation", lambda q: q["source"].update(quote="Cette intelligence artificielle a été entraînée sur ces textes par la Banque d’Algérie")), "citation inventée non détectée"
    assert mutated("assistant-formation", lambda q: q["check"].update(evidence=["entièrement entraînée"])), "preuve absente de la citation non détectée"
    assert mutated("assistant-formation", lambda q: q["check"].update(evidence=[])), "absence de preuve non détectée"
    assert mutated("assistant-formation", lambda q: q["source"].update(kind="document")), "source mal formée non détectée"
    assert mutated("assistant-formation", lambda q: q["source"].update(document_id="LOI-23-09.fr")), "identifiant de source mal formé non détecté"
    assert mutated("assistant-formation", lambda q: q["source"].update(reference="")), "référence absente non détectée"
    assert mutated("assistant-formation", lambda q: q.update(limit="loi-23-09-modifiee")), "limite sans objet non détectée"
    assert mutated("assistant-formation", lambda q: q["choices"].__setitem__(1, q["choices"][0])), "réponses identiques non détectées"
    assert mutated("loi-23-09-art-01-centimes", lambda q: q["source"].update(kind="app")), "source « app » sur une question du corpus non détectée"
    q = next(x for x in QUESTIONS if x["id"] == "assistant-formation")
    original = verify.app_text
    try:
        verify.app_text = lambda: original().replace("n'a pas été entraînée ni spécialisée sur ces textes", "a été entraînée sur ces textes")   # le texte de l'application a changé
        assert verify.check_question(q, CORPUS, DATA.get("limits")), "la question devrait être rejetée quand le texte de l'application ne dit plus la même chose"
    finally:
        verify.app_text = original
    assert "<" not in verify.app_text() and "intelligence artificielle" in verify.app_text(), "le texte de l'application est bien extrait, sans balises"


def test_quiz_texts_have_no_emoji_technical_wording_or_secret_words():
    text = (ROOT / "local_app" / "static" / "quiz-data.js").read_text(encoding="utf-8")
    assert not re.search("[\U0001F000-\U0001FAFF☀-➿️]", text), "emoji dans le quiz"
    assert not re.search(r"llama|qwen|rerank|hybrid|PHASE_4|NO-GO|127\.0\.0\.1|OCR_UNCERTAIN|chunk|\bLLM\b|api[_-]?key|secret|token", json.dumps(DATA, ensure_ascii=False), re.I)


def test_quiz_scripts_are_wired_and_follow_the_interface_contract():
    from local_app import server
    static = ROOT / "local_app" / "static"
    for name in ("quiz-data.js", "quiz-logic.js", "quiz.js"):
        assert server._PAGES.get(name) == name, f"{name} doit être servi par l'application (et par elle seule)"
        assert (static / name).is_file()
    html = (static / "index.html").read_text(encoding="utf-8")
    order = [html.index(f'src="{n}"') for n in ("quiz-data.js", "quiz-logic.js", "quiz.js", "app.js")]
    assert order == sorted(order), "données, logique et interface du quiz se chargent avant app.js"
    assert not re.search(r"""(?:src|href)\s*=\s*["'](?:https?:)?//""", html)
    for name in ("quiz-logic.js", "quiz.js"):
        js = (static / name).read_text(encoding="utf-8")
        assert not re.search("[\U0001F000-\U0001FAFF☀-➿️]", js), f"emoji dans {name}"
        assert not re.search(r"sk-[A-Za-z0-9_-]{8,}|ANTHROPIC|api[_-]?key|secret|token", js, re.I), f"clé ou secret dans {name}"
        literals = re.findall(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"", js)
        visible = " ".join(literals)
        assert not re.search(r"llama|qwen|rerank|hybrid|PHASE_4|NO-GO|127\.0\.0\.1|OCR_UNCERTAIN|chunk|Traçabilité|\bLLM\b|\bport\b|\bms\b", visible, re.I), f"détail technique visible dans {name}"
        assert "RegAssistQuizLogic" in js or "RegAssistQuiz" in js


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
    print(f"\nTests banque du quiz : {len(TESTS) - len(failed)}/{len(TESTS)}")
    sys.exit(1 if failed else 0)
