"""Doubles de test : faux agent dont les sorties ont la forme EXACTE de `agent_fr.agent.ask` (y compris les champs internes que la couche applicative doit filtrer).
Ils ne remplacent le système gelé que dans les tests de l'API et de l'interface ; le test d'intégration utilise le vrai système."""
import time
from types import SimpleNamespace

NOT_FOUND = "Je ne trouve pas de disposition correspondante dans le corpus disponible."
DISCLAIMER = "Réponse fondée uniquement sur les textes officiels collectés ; elle ne constitue pas un avis juridique."
INTERNAL_PATH = r"D:\llm\index\vec_df4dd33e8c3b.npy"


def citation(n: int, **kw) -> dict:
    c = {"id": f"S{n}", "chunk_id": f"REG-20-03.fr::article-{9 + n}", "texte": "Règlement n° 2020-03 du 15 mars 2020",
         "titre": "Règlement n°2020-03 du 15 mars 2020 relatif au système de garantie des dépôts bancaires", "article": str(9 + n), "emplacement": f"Article {9 + n}",
         "chapitre": None, "section": None, "page": 3, "page_fin": 4,
         "document_url": "https://www.bank-of-algeria.dz/stoodroa/2021/03/reglement202003.pdf", "source_url": "https://www.bank-of-algeria.dz/stabilite-financiere-reglement/",
         "statut": "STATUT À VÉRIFIER", "relations": {"Abroge": ["Règlement n° 2004-03 du 4 mars 2004"]}, "relations_prompt": {"Abroge": ["x"]}, "extraction": "pdf_text",
         "a_verifier": False, "autres_copies": [], "score": 0.93, "extrait": "Le plafond d'indemnisation par déposant est fixé à deux millions de dinars (2.000.000 DA).",
         "via": "", "alerte": None, "date": "2020-03-15", "statut_juridique": "ACTIVE", "statut_detail": "Dernière version connue dans le corpus (vigueur non prouvée) [règle A-1, confiance MEDIUM]",
         "statut_regle": "A-1", "statut_confiance": "MEDIUM", "similarite": 0.912, "ocr_uncertain": False, "ocr_uncertain_tokens": []}
    c.update(kw)
    return c


TIMINGS = {"embed_question_ms": 6.3, "search_ms": 0.8, "rerank_ms": 444.1, "rerank_best": 2.7, "total_ms": 454.4}


def answered(question: str, **kw) -> dict:
    s1, s2 = citation(1), citation(2, extrait="Autre passage examiné, non cité.")
    out = {"mode": "llm", "model": "qwen3-4b-instruct-2507-q4_k_m (local, CPU)", "provider": "local", "latency_s": 20.1, "llm_timings": {"prompt_n": 900.0},
           "found": True, "answer": "Le plafond d'indemnisation par déposant est fixé à deux millions de dinars algériens (2.000.000 DA) [S1].", "citations": [s1],
           "sources": [s1, s2], "all_retrieved": ["S1", "S2"], "all_retrieved_chunks": [s1["chunk_id"], s2["chunk_id"]],
           "notes": ["Correspondance partielle : vérifiez que ces passages répondent bien à votre question."], "disclaimer": DISCLAIMER, "reason": "ok",
           "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    out.update(kw)
    return out


def scripted_ask(question: str, use_llm: bool = False, k: int = 6, *, delay: float = 0.0, state=None) -> dict:
    """Scénarios déclenchés par un mot-clé de la question (majuscules)."""
    if delay:
        time.sleep(delay)
    q = question.upper()
    if "LENTE" in q and delay:                               # question volontairement lente : laisse aux tests de la fenêtre de jeu le temps de jouer sans que la réponse arrive
        time.sleep(delay * 4)
    if "PLANTAGE" in q:
        raise FileNotFoundError(f"vecteurs absents ({INTERNAL_PATH})")
    if "BUG" in q:
        raise ValueError(r"detail interne secret C:\Users\x\secret.txt")
    if "REFMODELE" in q:
        s = citation(1)
        return {"mode": "llm", "model": "qwen3-4b-instruct-2507-q4_k_m (local, CPU)", "provider": "local", "latency_s": 9.0, "found": False, "answer": NOT_FOUND, "citations": [],
                "sources": [s], "notes": [], "disclaimer": DISCLAIMER, "reason": "refus_modele", "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    if "REFUS" in q:
        return {"mode": "extractif", "found": False, "answer": NOT_FOUND, "citations": [], "notes": [], "disclaimer": DISCLAIMER, "reason": "aucun_passage_pertinent",
                "retriever": "hybrid_rerank", "timings": {"embed_question_ms": 5.0, "search_ms": 1.0, "rerank_ms": 300.0, "rerank_best": -4.2, "total_ms": 320.0}}
    if "AMBIGU" in q:
        return {"mode": "extractif", "found": False, "clarify": True, "answer": "Votre question est trop générale. Précisez le sujet, le texte (numéro) ou la période. Textes possibles : Règlement n° 2020-03.",
                "citations": [], "notes": [], "disclaimer": DISCLAIMER, "reason": "question_ambigue", "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    if "LLMOFF" in q:                                       # llama-server éteint : l'agent retombe sur la réponse extractive avec sa note interne
        s = citation(1)
        return {"mode": "extractif", "found": True, "answer": "J'ai trouvé 1 passage(s) pertinent(s) dans le corpus.", "citations": [s],
                "notes": ["LLM local demandé mais llama-server ne répond pas sur http://127.0.0.1:8187 : lancez llm_local\\start_server.ps1 (réponse extractive affichée)."],
                "disclaimer": DISCLAIMER, "reason": "ok", "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    if "ILLISIBLE" in q:                                    # llama-server en ligne, mais sa sortie n'a pas pu être lue (ex. coupée au plafond de 600 jetons)
        s = citation(1)
        return {"mode": "extractif", "found": True, "answer": "J'ai trouvé 1 passage(s) pertinent(s) dans le corpus.", "citations": [s],
                "notes": ["Correspondance partielle : vérifiez que ces passages répondent bien à votre question.", "Réponse du modèle illisible : réponse extractive affichée."],
                "disclaimer": DISCLAIMER, "reason": "ok", "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    if "TITRE" in q:                                        # intitulé qui ne commence pas par la référence du texte
        s = citation(1, texte="Note n° 03-92 du 4 août 1992", titre="Recueil des dispositions relatives aux opérations de change")
        return {"mode": "extractif", "found": True, "answer": "J'ai trouvé 1 passage(s).", "citations": [s], "notes": ["Réponse du modèle illisible : réponse extractive affichée."],
                "disclaimer": DISCLAIMER, "reason": "ok", "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    if "GROUPES" in q:                                      # génération impossible ; 3 passages dont 2 du même texte, le 3e d'un texte abrogé
        s1, s2 = citation(1), citation(2)
        s3 = citation(3, chunk_id="INS-05-25.fr::article-6", texte="Instruction n° 05-2025 du 17 juillet 2025", titre="Instruction n°05-2025 du 17 juillet 2025 relative au droit de change pour voyage à l’étranger.",
                      article="6", emplacement="Article 6", page=2, date="2025-07-17", statut_juridique="ABROGATED", statut_detail="Abrogé d'après Instruction n° 07-2026 du 13 juillet 2026 [règle A-2, confiance HIGH]",
                      document_url="https://www.bank-of-algeria.dz/stoodroa/2025/07/instruction052025.pdf", relations={"Abrogé par": ["Instruction n° 07-2026 du 13 juillet 2026"]},
                      alerte="Ce texte a été abrogé par Instruction n° 07-2026 du 13 juillet 2026 : la version citée n'est peut-être plus à jour.")
        return {"mode": "extractif", "found": True, "answer": "J'ai trouvé 3 passage(s).", "citations": [s1, s2, s3], "notes": ["Réponse du modèle illisible : réponse extractive affichée."],
                "disclaimer": DISCLAIMER, "reason": "ok", "retriever": "hybrid_rerank", "timings": dict(TIMINGS)}
    if "REPLI" in q:
        out = answered(question, retriever="legacy", timings={"total_ms": 12.0})
        out["notes"] = ["Moteur de recherche de repli (lexical) utilisé : FileNotFoundError: vecteurs absents (" + INTERNAL_PATH + ")"]
        return out
    if "CODES" in q:                                         # l'IA recopie des codes internes de statut dans son texte
        return answered(question, answer="Ce texte a pour statut juridique ACTIVE, l'ancien texte est REPLACED et un autre est UNKNOWN [S1].",
                        notes=["[S1] Statut de vigueur non déterminé (aucune relation ni période dans le corpus) : ne pas présenter comme applicable [règle U-ISOL, confiance LOW].",
                               "Version remplacée par un texte plus récent, écartée du contexte du LLM : Instruction n° 05-2025 du 17 juillet 2025, Article 9.",
                               "[S2] OCR_UNCERTAIN : valeur numérique de ce passage arabe non corroborée par le texte français (2000.000)."])
    if "ALLOCATION TOURISTIQUE" in q:                       # cas réel du 18/10/2026 : textes qui parlent d'autre chose (rapatriement d'une dépouille) ; le terme demandé n'y figure pas
        s1 = citation(1, texte="Règlement n° 91-06 du 16 mai 1991", extrait="En cas de décès à l'étranger du malade ou d'un national résidant se trouvant à l'étranger à l'occasion d'un voyage "
                      "touristique ou d'affaires, une allocation en devises pour le rapatriement de la dépouille mortelle est délivrée au membre de la famille du défunt.",
                      titre="Règlement n°91-06 du 16 mai 1991 fixant les conditions d’attribution d’allocations en devises à l’occasion d’hospitalisation et/ou de décès de nationaux à l’étranger.")
        return answered(question, answer="L'allocation touristique est une allocation en devises attribuée aux nationaux résidents en voyage touristique ou d'affaires à l'étranger [S1].",
                        citations=[s1], sources=[s1])
    if "XSS" in q:
        bad = citation(1, extrait='<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> Texte du corpus', texte="<b>Règlement</b> piégé")
        return answered(question, citations=[bad], sources=[bad], answer="Réponse <i>balisée</i> [S1].")
    return answered(question)


def make_agent(delay: float = 0.0, state=None, fallback=None) -> SimpleNamespace:
    chunks = [{"chunk_id": citation(i)["chunk_id"], "document_type": "règlement"} for i in (1, 2)]
    idx = SimpleNamespace(chunks=chunks, docs={"d1": {}, "d2": {}})
    ns = SimpleNamespace(calls=[], _FALLBACK_REASON=fallback)
    ns.get_index = lambda force=False: idx
    ns.retriever_name = lambda: "auto"
    ns.search = lambda i, q, k: SimpleNamespace(timings=dict(TIMINGS))

    def ask(question, use_llm=False, k=6):
        ns.calls.append((question, use_llm, k))
        return scripted_ask(question, use_llm, k, delay=delay, state=state)
    ns.ask = ask
    return ns
