"""Génère `local_app/static/quiz-data.js` à partir de `questions.json` et du corpus, après vérification complète.

    python -m local_app.quiz.build            # vérifie puis écrit le fichier de données
    python -m local_app.quiz.build --check    # vérifie et signale si le fichier de données n'est pas à jour (CI)
    python -m local_app.quiz.build --pdf      # ajoute le contrôle indépendant dans les PDF d'origine (corpus/raw)

Les titres, numéros, dates et liens affichés viennent du corpus, jamais de `questions.json` : une seule source de vérité.
"""
from __future__ import annotations

import json
import sys
from urllib.parse import quote as urlquote

from . import verify

OUT = verify.ROOT / "local_app" / "static" / "quiz-data.js"
HEADER = "/* GÉNÉRÉ par `python -m local_app.quiz.build` depuis local_app/quiz/questions.json et le corpus : ne pas modifier à la main. */\n"


def page_link(url: str, page: int) -> str:
    safe = urlquote(url, safe=":/?#[]@!$&'()*+,;=%-._~")
    return safe if page <= 1 else f"{safe}#page={page}"


def build_payload(corpus: verify.Corpus | None = None) -> dict:
    corpus = corpus or verify.Corpus()
    data = verify.load_questions()
    limits = {k: v["text"] for k, v in data.get("limits", {}).items()}
    out = []
    for q in data["questions"]:
        doc = corpus.doc(q["source"]["document_id"])
        s = q["source"]
        out.append({
            "id": q["id"], "kind": q["kind"], "question": q["question"], "choices": q["choices"], "answer": q["answer"], "explanation": q["explanation"],
            "limit": limits.get(q.get("limit")) if q.get("limit") else None,
            "source": {"document_id": doc["document_id"], "title": doc["title"], "type": doc["document_type"], "number": doc.get("number"), "date": doc.get("date"),
                       "reference": s["reference"], "page": s["page"], "quote": s["quote"], "url": page_link(doc["document_url"], s["page"])},
        })
    return {"version": data["version"], "questions": out}


def render(payload: dict) -> str:
    return HEADER + "window.RegAssistQuizData = Object.freeze(" + json.dumps(payload, ensure_ascii=False, indent=1) + ");\n"


def main(argv: list[str]) -> int:
    pdf, check = "--pdf" in argv, "--check" in argv
    corpus = verify.Corpus()
    problems = verify.check_all(corpus=corpus, pdf=pdf)
    if problems:
        print("Quiz : questions NON vérifiées, rien n'est écrit.\n  " + "\n  ".join(problems))
        return 1
    text = render(build_payload(corpus))
    n = len(json.loads(verify.QUESTIONS.read_text(encoding="utf-8"))["questions"])
    where = "corpus + PDF d'origine" if pdf else "corpus"
    if check:
        current = OUT.read_bytes().decode("utf-8") if OUT.is_file() else ""
        if current != text:
            print(f"Quiz : {n} questions vérifiées ({where}) mais {OUT.name} n'est pas à jour : relancer python -m local_app.quiz.build")
            return 1
        print(f"Quiz : {n} questions vérifiées ({where}) ; {OUT.name} à jour.")
        return 0
    OUT.write_bytes(text.encode("utf-8"))                       # octets : pas de conversion de fin de ligne sous Windows
    print(f"Quiz : {n} questions vérifiées ({where}) ; {OUT.relative_to(verify.ROOT)} écrit.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
