# RegAssist DZ

[![CI](https://github.com/SalimMabed/regassist-dz/actions/workflows/ci.yml/badge.svg)](https://github.com/SalimMabed/regassist-dz/actions/workflows/ci.yml)
[![Licence : Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

**Projet éducatif non officiel.** Assistant d'exploration des textes réglementaires **publics** de la Banque d'Algérie (règlements, instructions, notes). Il n'est ni affilié à la Banque d'Algérie ni approuvé par elle.

> **Statut du système : NO-GO PROVISOIRE.** Les jeux d'évaluation ont été rédigés avec l'aide d'une IA et **n'ont pas été validés par un juriste**. Les réponses peuvent être incomplètes ou erronées et ne constituent pas un avis juridique : **seul le texte officiel (PDF) fait foi**. Voir [docs/NOTE_AU_JURISTE.md](docs/NOTE_AU_JURISTE.md).

**In short (English).** RegAssist DZ is an unofficial educational project: a question-answering assistant over 1,085 public regulatory texts of the Bank of Algeria. It retrieves the relevant passages (BM25 + embeddings + reranker), then a small **local** language model writes an answer from those passages only, with the article, the page and a link to the official PDF. Nothing leaves the machine: no remote API, no model trained on these texts. **Status: provisional NO-GO**: in a blind test it gave 52.4 % correct answers and 14.3 % hallucinations (automatic scoring, not validated by a lawyer), so it is not a legal service and only the official PDF is authoritative. Code and documentation are under the Apache License 2.0; the corpus remains the property of its publisher (see [Licences](#licences)).

## En bref

* Il pose une question en français et retrouve les passages pertinents dans 1 085 documents officiels (recherche hybride lexicale + sémantique, puis reranker).
* Un petit modèle de langage **local** rédige une réponse à partir de ces seuls passages, avec l'article, la page et le lien vers le PDF officiel. S'il ne trouve rien, il le dit au lieu d'inventer.
* Il signale quand un texte a été modifié, remplacé ou abrogé, ou quand son statut est à vérifier.
* **Tout est local** : aucun service distant, aucune clé d'API, aucun modèle entraîné ou affiné sur ces textes.
* **Interface « la réponse d'abord »** : la réponse dans une grande carte, les sources dans une colonne séparée et plus discrète, des questions d'exemple, un tiroir d'historique ; elle s'adapte aux téléphones.
* **Une réponse prend du temps sur un processeur seul** (environ 2,5 minutes mesurées sur le serveur de démonstration, une seule question à la fois). L'interface montre donc un **suivi réel** de la demande : file d'attente, lien personnel pour revenir plus tard, notification facultative quand la réponse est prête. Pendant l'attente, un **quiz** et un **jeu de mémoire** facultatifs sont proposés ; chaque fait du quiz est vérifié dans le corpus ou dans le texte de l'application.

```
question ──▶ application locale (Flask, 127.0.0.1:8790)
                │
                ▼
   recherche hybride (BM25 + embeddings e5-small + fusion RRF)
                │  logique juridique et temporelle (versions, abrogations)
                ▼
   reranker (mmarco, ONNX) ──▶ passages retenus
                │
                ▼
   LLM local (Qwen3-4B Q4_K_M, llama.cpp, CPU) ──▶ réponse + sources citées
```

## Résultats mesurés

| Mesure | Valeur | Remarque |
|---|---|---|
| La bonne source est dans les 5 premiers résultats (Recall@5), 136 questions historiques | 0,765 avec l'ancienne recherche, **0,890** en phase 2, **0,868** pour le système gelé (phase 4) | la mesure de la phase 4 n'est pas strictement comparable à celle de la phase 2 (corpus remappé) |
| Test à l'aveugle TEST v1, passé une seule fois (42 questions à réponse attendue sur 52) | **52,4 %** de réponses correctes, **14,3 %** d'hallucinations (6/42) | notation **automatique** ; le seuil de NO-GO est > 10 % d'hallucinations : d'où le **NO-GO provisoire** |

Ces questions ont été écrites avec l'aide d'une IA et notées automatiquement : elles ne remplacent pas une validation juridique humaine. Un second test indépendant (TEST v2) devra être rédigé par un juriste. Détails : [docs/PHASE_4_FROZEN.md](docs/PHASE_4_FROZEN.md), [docs/RETRIEVAL_PHASE3.md](docs/RETRIEVAL_PHASE3.md) et [docs/RETRIEVAL_PHASE4.md](docs/RETRIEVAL_PHASE4.md).

## Démarrage rapide

**Sur la machine d'origine** (Windows 10, Python 3.14, modèles dans `D:\llm`) :

```powershell
pip install -r requirements.txt
.\start_local.ps1          # puis http://127.0.0.1:8790
.\stop_local.ps1           # arrêt
```

**Pour que des collègues l'utilisent depuis leur navigateur** (option, désactivée par défaut) : `.\start_local.ps1 -Lan` ouvre l'accès sur le réseau local avec un code d'accès (affiché une seule fois). L'application tourne sur votre machine ; les autres ne font qu'afficher la page. À n'activer qu'avec l'accord de la sécurité informatique si la machine appartient à une organisation. Garde-fous et limites : [docs/LOCAL_DEPLOYMENT.md](docs/LOCAL_DEPLOYMENT.md) § 15. Pour que le service reste allumé et redémarre seul après un plantage : `.\autostart.ps1 -Install -Lan -NoCode` (§ 17).

**Sur une autre machine** : le dépôt contient le corpus et les données de gel ; les modèles sont téléchargés et vérifiés par un script.

```powershell
git config --global core.longpaths true
git clone https://github.com/SalimMabed/regassist-dz.git ; cd regassist-dz
pip install -r requirements.txt
.\replication\setup_machine.ps1        # modèles (~3 Go), vecteurs, instantané ; empreintes SHA-256 vérifiées
.\start_local.ps1
```

Prérequis, vérifications et limites : [docs/REPLICATION.md](docs/REPLICATION.md). Déploiement local, ports, journaux, diagnostic : [docs/LOCAL_DEPLOYMENT.md](docs/LOCAL_DEPLOYMENT.md).

**Sur un serveur Linux** (Ubuntu 24.04, nginx, gunicorn, systemd) : `deploy/setup_vps.sh <domaine> [--private]` installe tout, `deploy/update_vps.sh` met à jour. Avec `--private`, nginx exige un identifiant et un mot de passe. Une instance de démonstration est hébergée sur `https://regassist.salimmabed.com` en mode privé, conformément au NO-GO : pas d'accès public, les identifiants ne figurent pas dans ce dépôt. Guide complet : [deploy/README_DEPLOY.md](deploy/README_DEPLOY.md).

## Contenu du dépôt

| Élément | Rôle |
|---|---|
| `corpus/` | **corpus officiel** : PDF et pages HTML sources, textes extraits, chunks, métadonnées, rapports |
| `state/` | état de collecte (pages, candidats, cache d'extraction) |
| `boa_pipeline/` | collecte, extraction (OCR), segmentation et relations juridiques entre textes |
| `agent_fr/` | agent : recherche, statut juridique, réponse ; évaluation (`eval/`), jeux et résultats figés, outils du gel |
| `local_app/` | application (API Flask + interface web), file d'attente persistante, notifications, quiz (`quiz/`) et leurs tests |
| `llm_local/` | démarrage du LLM local (llama.cpp) et mesures |
| `replication/` | script d'installation d'une autre machine, vecteurs d'embeddings et instantané du corpus |
| `deploy/` | déploiement Linux : nginx, gunicorn, systemd, scripts d'installation et de mise à jour |
| `.github/workflows/ci.yml` | intégration continue : tests du système, de l'API, de la file, du quiz et de l'interface |
| `tests/` | tests du système |
| `docs/` | documentation |
| `PHASE_4_FROZEN` | marqueur du gel ; le manifeste d'empreintes est `agent_fr/eval/human/PHASE_4_FROZEN.manifest.json` |
| `start_local.ps1`, `stop_local.ps1` | démarrage et arrêt de l'application locale (`-Lan` : accès réseau avec code) |
| `lan_firewall.ps1` | règle étroite du pare-feu Windows pour l'accès réseau (facultatif) |
| `autostart.ps1`, `keep_running.ps1` | tâche planifiée et superviseur qui gardent le service allumé et le relancent s'il tombe |
| `LICENSE`, `NOTICE` | licence Apache-2.0 du code et de la documentation, et ce qu'elle ne couvre pas |

**Hors dépôt** : les modèles (trop gros pour Git, téléchargés par `replication/setup_machine.ps1`), les caches et les journaux d'exécution.

## Le gel `PHASE_4_FROZEN`

Le moteur, les embeddings, le reranker, les poids de fusion, le chunking et les jeux de test sont **figés** pour qu'un juriste valide un système qui ne bouge pas. Aucune amélioration n'est faite tant qu'il n'a pas répondu. La commande suivante doit toujours répondre « aucun écart » :

```powershell
python -m agent_fr.eval.human.freeze_phase4 verify
```

L'application (`local_app/`) n'est qu'une couche d'accès : elle appelle le moteur gelé tel quel.

## Tests

```powershell
python local_app/tests/test_api.py          # API, avec un faux agent (sans modèle)
python local_app/tests/test_queue.py        # file d'attente en mémoire
python local_app/tests/test_persist.py      # suivi persistant : file stockée, lien personnel, suppression, conservation
python local_app/tests/test_webpush.py      # notifications Web Push : chiffrement et envoi simulé
python local_app/tests/test_quiz_data.py    # quiz : chaque question vérifiée dans le corpus, les PDF d'origine ou le texte de l'application
node --test local_app/tests/test_quiz.mjs   # quiz : sélection, score, stockage local (Node >= 22)
python local_app/tests/test_grounding.py    # garde-fous : saisie normalisée, définition non soutenue par les textes retirée
python local_app/tests/test_smalltalk.py    # messages de courtoisie (« Bonjour », « Merci », « Qui es-tu ? »)
python local_app/tests/test_lan.py          # accès réseau optionnel : code d'accès, sessions, blocage, liaisons
python local_app/tests/test_ui.py           # interface dans Edge/Chrome sans fenêtre (Node >= 22)
python local_app/tests/test_integration.py  # chaîne réelle de bout en bout (application démarrée)
python tests/test_phase5_freeze.py          # tests du système : un script par thème (tests/test_*.py : agent, pipeline, statut juridique, OCR, gel…)
```

Tous ces tests, sauf l'intégration (qui exige l'application démarrée), tournent dans GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) à chaque `push` sur `main` ou sur une branche `feat/**`, et pour chaque pull request vers `main`.

## Documentation

| Sujet | Document |
|---|---|
| Vue d'ensemble, architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AGENT.md](docs/AGENT.md), [docs/RAG.md](docs/RAG.md) |
| Recherche (phases 2 à 4) | [docs/RETRIEVAL_PHASE2.md](docs/RETRIEVAL_PHASE2.md), [docs/RETRIEVAL_PHASE3.md](docs/RETRIEVAL_PHASE3.md), [docs/RETRIEVAL_PHASE4.md](docs/RETRIEVAL_PHASE4.md) |
| Gel et statut | [docs/PHASE_4_FROZEN.md](docs/PHASE_4_FROZEN.md) |
| Relecture par un juriste | [docs/NOTE_AU_JURISTE.md](docs/NOTE_AU_JURISTE.md), [docs/HUMAN_REVIEW.md](docs/HUMAN_REVIEW.md), [docs/HUMAN_REVIEW_QUICKSTART.md](docs/HUMAN_REVIEW_QUICKSTART.md), [docs/CAS_CRITIQUES_A_EXAMINER.md](docs/CAS_CRITIQUES_A_EXAMINER.md) |
| Application locale | [docs/LOCAL_DEPLOYMENT.md](docs/LOCAL_DEPLOYMENT.md), [docs/LOCAL_UI.md](docs/LOCAL_UI.md) |
| Suivi des questions, file d'attente, notifications | [docs/SUIVI_ASYNCHRONE.md](docs/SUIVI_ASYNCHRONE.md) |
| Quiz d'attente (questions, vérification, ajout) | [docs/QUIZ_ATTENTE.md](docs/QUIZ_ATTENTE.md) |
| Déploiement sur un serveur Linux | [deploy/README_DEPLOY.md](deploy/README_DEPLOY.md) |
| Réponses fausses observées en usage (pour le juriste) | [docs/CAS_OBSERVES_EN_USAGE.md](docs/CAS_OBSERVES_EN_USAGE.md) |
| Gouvernance, confidentialité, licences | [docs/GOVERNANCE.md](docs/GOVERNANCE.md) |
| Tâches ouvertes (issues GitHub T1 à T12) | [docs/TASKS.md](docs/TASKS.md) |
| Autre machine | [docs/REPLICATION.md](docs/REPLICATION.md) |
| Mise à jour du corpus | [docs/UPDATE.md](docs/UPDATE.md) |
| LLM local | [llm_local/README.md](llm_local/README.md) |

## Limites connues

* Pas de validation juridique humaine : le statut reste NO-GO provisoire.
* Une seule question à la fois ; pas de mémoire de conversation.
* Sans carte graphique, une réponse prend environ 2,5 minutes sur le serveur de démonstration : d'où la file d'attente et le suivi de la demande.
* La recherche peut manquer un passage (par exemple un montant) pour les questions très larges, et une question qui touche plusieurs régimes n'est pas détectée comme ambiguë.
* Les réponses du LLM local sont plafonnées en longueur et peuvent être tronquées.
* Le statut juridique affiché peut être inexact (par exemple une abrogation implicite non détectée) : toujours vérifier sur le texte officiel.
* Arabe : l'OCR des scans doit encore être amélioré (les valeurs numériques incertaines sont signalées, jamais corrigées en silence).
* Le quiz d'attente n'a pas été relu par un juriste ; il ne couvre que quelques textes et des questions sur l'assistant lui-même.
* Interface testée sous Edge et Chrome dans un navigateur sans fenêtre ; les téléphones réels et les autres navigateurs n'ont pas été testés.

## Sécurité et confidentialité

* **Application locale : zéro journalisation des requêtes sur disque.** Le texte des questions n'est jamais consigné sur le disque par défaut. Les journaux techniques (`access.log` et `api.log`) n'enregistrent que la méthode, le chemin, le code HTTP, les durées et la longueur de la question.
* **Serveur avec suivi persistant (`deploy/`) : la question et sa réponse sont conservées 7 jours** dans une base locale du serveur (durée réglable), pour que la personne puisse revenir les lire avec son lien personnel, puis supprimées ; elles ne vont jamais dans les journaux. L'interface le dit avant l'envoi et dans « À propos », et permet de supprimer sa demande à tout moment.
* **Zéro télémétrie tierce** : l'application n'embarque aucun traceur, CDN, police distante ou script externe (politique CSP stricte `default-src 'none'; connect-src 'self'`). Seule exception, **facultative et à l'initiative de l'utilisateur** : la notification Web Push, pour laquelle le serveur contacte le service de notification du navigateur ; le message (un texte fixe et le lien de suivi) est chiffré pour le navigateur.
* **Inférence locale intégrale** : l'ensemble du traitement (embeddings e5-small, reclassement mmarco et génération locale par le modèle Qwen3-4B) s'exécute sur le processeur de la machine sans qu'aucune donnée ne sorte vers un tiers.
* **Écoute restreinte** : par défaut, le serveur n'écoute que sur la boucle locale (`127.0.0.1`). L'accès réseau (`-Lan`) est une option explicite protégée par un code d'accès temporaire et une limitation de débit par IP. Sur un serveur Linux, nginx fait office de point d'entrée (HTTPS, limitation de débit, contrôle Host/Origin, accès privé par identifiant avec `--private`).

Pour les détails complets sur la gouvernance, la confidentialité et les licences, voir [docs/GOVERNANCE.md](docs/GOVERNANCE.md).

## Équipe et contributions

Ce projet est développé dans le cadre de la compétition Thirduni (Cohorte 1) par :

* **Salim Mabed** : Collecte et structuration des 1 085 documents de la Banque d'Algérie (OCR arabe, segmentation, liens d'amendement), conception et développement du moteur gelé de recherche hybride, du reranker et du service LLM local (`agent_fr/`, `boa_pipeline/`, `llm_local/`), mise en place de la première application locale Flask et exécution des benchmarks de la Phase 4.
* **Chouari Mohammed Anes** : Modernisation de l'espace de travail et de l'interface de vérification des sources (`local_app/`), implémentation de l'adaptateur de sécurité de production (filtrage Host/Origin, limitation de débit native par IP avec en-têtes `Retry-After`), architecture et outillage de déploiement Linux WSGI / Gunicorn / Nginx / systemd (`deploy/`), résolveur de clés de vecteurs pour la réplication multiplateforme (`deploy/ensure_vectors.py`), pipeline d'intégration continue GitHub Actions (`.github/workflows/ci.yml`), et mesures de latence et d'empreinte mémoire RSS.

Code et documentation produits avec l'assistance d'une IA (Claude). Ce projet n'est pas un conseil juridique.

## Licences

Le projet sépare strictement le code, le corpus réglementaire et les composants tiers (détail : [docs/GOVERNANCE.md](docs/GOVERNANCE.md) § 4).

### 1. Code et documentation du projet : Apache License 2.0

Le code (Python, JavaScript, HTML, CSS, scripts PowerShell et shell) et la documentation écrits pour ce projet sont publiés sous **licence Apache 2.0** : voir [LICENSE](LICENSE) et [NOTICE](NOTICE). Vous pouvez les utiliser, les modifier et les redistribuer, y compris à titre commercial, à condition de conserver la licence et les mentions de copyright. **Ils sont fournis « en l'état », sans aucune garantie** : le système est en NO-GO provisoire et ne doit pas servir de conseil juridique.

### 2. Corpus réglementaire officiel : non couvert par cette licence

Les textes réglementaires (règlements, instructions, notes) et documents PDF/HTML présents dans `corpus/` proviennent de publications **publiques** accessibles sur le site officiel de la **Banque d'Algérie** ([bank-of-algeria.dz](https://www.bank-of-algeria.dz)). Il en va de même des données qui en sont dérivées (`state/`, textes extraits, chunks, vecteurs d'embeddings et instantané de `replication/`).
* Ce projet éducatif non officiel n'est ni affilié à la Banque d'Algérie ni mandaté par elle.
* Les textes officiels demeurent la propriété de leurs auteurs institutionnels et sont inclus ici à des fins de recherche, d'analyse comparative et de reproductibilité académique. **La licence Apache 2.0 ne leur est pas appliquée** et ne vaut pas autorisation de réutilisation ; les conditions de réutilisation fixées par la Banque d'Algérie restent à vérifier (tâche T6, [issue #6](https://github.com/SalimMabed/regassist-dz/issues/6)).
* Seule la version officielle publiée au *Journal Officiel de la République Algérienne Démocratique et Populaire* ou par la Banque d'Algérie fait foi.

### 3. Modèles tiers et composants externes (sous leur propre licence)
* **Qwen3-4B-Instruct-2507** (Alibaba Cloud / Qwen team) : distribué sous licence **Apache-2.0**.
* **multilingual-e5-small** (Microsoft) : distribué sous licence **MIT**.
* **mmarco-mMiniLMv2-L12-H384** (cross-encoder) : distribué sous licence **Apache-2.0**.
* **llama.cpp** (Georgi Gerganov & contributeurs) : distribué sous licence **MIT**.
* **PyMuPDF** : sous licence **AGPL-3.0** (ou licence commerciale). Il n'est ni distribué ni nécessaire pour faire fonctionner l'application : il ne sert qu'aux outils de construction du corpus et au contrôle facultatif du quiz dans les PDF d'origine. Si vous redistribuez ces outils avec PyMuPDF, sa licence s'applique à l'ensemble.
* Les autres paquets Python (`requirements.txt`, `deploy/requirements-deploy.txt`) restent soumis à leurs propres licences.
