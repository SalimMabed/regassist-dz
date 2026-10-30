# Quiz pendant l'attente : « Vous nous posez une question, nous avons bien le droit de vous en poser une aussi ! »

État : implémenté et testé en local, fusionné (branche `feat/waiting-quiz` → `main`) avec l'interface refondue ; le serveur récupère son code depuis `main` (`deploy/update_vps.sh`). Le moteur gelé (`agent_fr/`), la file d'attente et le mini-jeu ne sont pas modifiés.
Le quiz est **pédagogique, non relu par un juriste** : chaque fait est vérifié automatiquement dans les textes du corpus et dans les PDF d'origine, mais personne n'a validé le choix des questions ni des réponses fausses proposées.

## 1. Ce que voit la personne

Dès l'envoi de sa question (seulement quand elle attend : file d'attente, pas en mode local immédiat), une grande fenêtre propose « 🧠 Répondre à un quiz », « 🎮 Jouer à un jeu » ou « Aucun des deux, juste attendre » (voir `docs/LOCAL_UI.md` §4). **Le choix fait, la même fenêtre s'agrandit** (environ 940 px de large, pleine hauteur sur téléphone) : le quiz ou le jeu s'y joue, et **la progression de la demande reste affichée en bas** (barre en quatre étapes, étape en cours, position dans la file ou durée écoulée). « Fermer » (ou Échap) la referme : le quiz ou le jeu retourne dans la fiche de suivi avec son état, et le bouton de la fiche le rouvre dans la fenêtre. Si la réponse arrive pendant une partie, un bandeau « Votre réponse est prête » avec « Lire la réponse » apparaît dans la fenêtre, sans interrompre le joueur. La fiche de suivi garde, à côté de « Patienter en jouant (facultatif) », un second bouton : **« Quiz sur les textes (facultatif) »**. Jamais lancé seul.

* **Présentation** : « Vous nous posez une question, nous avons bien le droit de vous en poser une aussi ! » / « En attendant notre réponse, testez vos connaissances sur les textes et la réglementation de la Banque d'Algérie. » ; boutons *Relever le défi*, *Choisir le mini-jeu*, *Retour au suivi* ; son meilleur résultat s'il en existe un.
* **5 questions très simples**, une par écran, **2 ou 3 réponses** (oui ou non, ou trois propositions), en phrases courtes, sans numéro, sans date et sans article à retenir. Barre de progression, « Question 2 sur 5 ».
* **Correction immédiate** : bonne ou mauvaise réponse dite **en toutes lettres** (« Bonne réponse », « Votre réponse : incorrecte ») et par le trait de la bordure (continu / pointillé), jamais par la couleur seule. La réponse ne peut plus être modifiée.
* **Explication courte**, puis la **source** : titre exact du texte (celui du corpus), type, numéro et date, référence (article ou intitulé) et page du PDF, **citation mot pour mot**, lien « Ouvrir le document officiel (PDF, page N) » vers le PDF de la Banque d'Algérie (avec l'ancre `#page=N`, dont la prise en compte dépend du lecteur PDF du navigateur et n'a pas été essayée ici), et, quand le texte a pu évoluer, une mention « À savoir : … ».
* **Résultat** : score (« 3 sur 5 »), message selon le palier (5 : « Impressionnant ! Vous connaissez vos textes sur le bout des doigts. » ; 4 : « Très bon résultat ! » ; 3 : « Pas mal ! Il reste quelques textes à découvrir. » ; 1-2 : « L'essentiel, c'est d'apprendre quelque chose ! » ; 0 : « On vous a peut-être posé des questions trop difficiles cette fois-ci. »), bonnes réponses, questions répondues, meilleur résultat, *Recommencer*, *Choisir le mini-jeu*, *Retour au suivi*.
* **Quitter à tout moment** : « Retour au suivi » referme le quiz sans toucher à la demande ; rouvert, il reprend là où il s'était arrêté. Si la réponse arrive pendant le quiz, le bandeau « Votre réponse est prête » invite à la lire sans interrompre la personne (comme pour le jeu).
* Mention discrète sur chaque écran : « Quiz à vocation pédagogique. Les réponses sont fondées sur les documents référencés et ne constituent pas un avis juridique. »

## 2. Architecture

| Rôle | Fichier |
|---|---|
| Données (source de vérité, modifiable à la main) | `local_app/quiz/questions.json` |
| Vérification contre le corpus | `local_app/quiz/verify.py` |
| Génération des données servies | `local_app/quiz/build.py` → `local_app/static/quiz-data.js` (ne jamais le modifier à la main) |
| Sélection, score, messages, stockage local | `local_app/static/quiz-logic.js` (pur, testable sous Node) |
| Interface | `local_app/static/quiz.js`, styles à la fin de `app.css` |
| Intégration dans l'attente | `app.js` : `toggleActivity` (un seul visible à la fois, jeu ou quiz, chacun garde son état) |

**Aucune requête** : ni le moteur de réponse, ni le serveur, ni un service externe. Les questions sont dans un fichier statique chargé avec la page ; le quiz n'appelle ni `fetch`, ni XHR, ni `sendBeacon`, n'écrit pas de HTML (`textContent` seulement). La file d'attente et le suivi ne sont pas modifiés (mêmes requêtes qu'avant, mesurées par les tests).

**Vie privée** : dans ce navigateur seulement (`localStorage`, facultatif) : `regassist.quiz.best.v1` (meilleur score) et `regassist.quiz.seen.v1` (identifiants des questions déjà vues, pour varier les séries). Aucune réponse individuelle n'est conservée, rien n'est envoyé au serveur.

**Sélection d'une série** : 5 questions, au plus 2 du même texte et au plus 3 questions « article » et 2 questions sur l'assistant (plafonds assouplis seulement si la banque ne suffit pas), au moins une question sur le contenu d'un article et, dès que la série compte 4 questions ou plus, au moins une question sur l'assistant, les questions jamais vues d'abord, ordre des réponses mélangé. En pratique (300 tirages simulés) : 3 questions sur les textes et 2 sur l'assistant, toujours. Si la banque est plus petite, seules les questions disponibles sont proposées ; si elle est vide, le quiz le dit.

## 3. Inventaire du corpus et questions retenues

Corpus français : 757 documents (instructions 361, règlements 223, notes 156, lignes directrices 8, lois 4, ordonnances 3, autres 2). Candidats sûrs : 655 textes dont le numéro **et** la date sont lus dans l'en-tête du document, extraction texte (sans OCR) de qualité « ok ». Les 20 documents à OCR et les 73 documents « à revoir » ne sont pas utilisés. Tous les documents ont le même émetteur (la Banque d'Algérie) : pas de question « quelle autorité ? » (elle n'aurait aucun intérêt).

**42 questions vérifiées, dont 22 servies.** Chaque question a un niveau (`level`) : `facile` (servie) ou `difficile` (vérifiée dans le corpus et les PDF comme les autres, mais **jamais servie** : dates, numéros, nombre de pages, objet d'un règlement, relations entre textes). Pourquoi : les premières questions demandaient de retenir des numéros, des dates et des articles ; elles ont été jugées beaucoup trop difficiles. Les 22 questions servies : 10 sur les textes (monnaie nationale, nombre de centimes d'un dinar, billets et pièces, dinar numérique, qui émet la monnaie, faux billets interdits, à qui appartient le capital de la Banque d'Algérie, où est son siège, qui la dirige, qui préside le Comité national des paiements) et 12 sur l'assistant. `python -m local_app.quiz.build` n'écrit dans `quiz-data.js` que les questions faciles.

**12 questions « assistant »** (`kind` = `assistant`) : ce que l'application affirme d'elle-même (qui rédige les réponses, sur quoi l'IA s'appuie, si elle a été entraînée sur ces textes, si ses réponses ont été validées par un juriste, si elle remplace un juriste, si elle peut se tromper, si elle constitue un avis juridique, ce qu'elle garantit d'un texte, sur quelles données elle est construite, ce qui fait foi, si elle est approuvée par la Banque d'Algérie). Leur source n'est pas un PDF mais le texte de l'application (`index.html`) : chacune cite mot pour mot une phrase du panneau « À propos » ou du bandeau, affichée comme texte de l'application. Ce ne sont **pas** des questions de culture générale : voir §7.

Choix délibérés :
* Les questions de contenu viennent de textes récents (2023 et 2026). L'ordonnance n° 03-11 de 2003, que le corpus indique comme remplacée par la loi n° 23-09 (sans que ce soit établi sans ambiguïté), n'est pas utilisée pour des questions de contenu.
* Aucune question ne porte sur l'état de vigueur d'un texte, sur un montant susceptible d'avoir changé, ni sur une interprétation juridique.
* Les questions sur la loi n° 23-09 portent la mention « Texte de la loi tel que publié en 2023 : un règlement de 2026 la cite comme « modifiée ». Vérifiez la version en vigueur avant de vous y fier. » Cette mention est elle-même vérifiée (la citation « modifiée, portant loi monétaire et bancaire » figure bien dans le règlement n° 26-01).

## 4. Vérification : comment on s'assure qu'aucun fait n'est inventé

`python -m local_app.quiz.build` refuse d'écrire les données si une seule question échoue. Pour chaque question :

1. le document existe dans le corpus (français, PDF, lien sur `bank-of-algeria.dz`), la page indiquée existe ;
2. la **citation** est retrouvée à cette page dans le texte extrait (`corpus/extracted`) ; avec `--pdf`, elle est retrouvée aussi à la même page du **PDF d'origine** lu par une autre bibliothèque (PyMuPDF) que celle du pipeline, et le nombre de pages du PDF est contrôlé ;
3. selon le type : preuve de la bonne réponse contenue dans la citation (contenu) ; bonne réponse présente dans l'intitulé et dans la page d'en-tête, **fausses réponses absentes de l'intitulé** (objet, valeur, relation) ; date du corpus et écriture française de la date, aucune fausse réponse ne la reprend (date) ; numéro du corpus (numéro) ; type du corpus (type) ; nombre de pages (pages) ;
4. pour date et numéro, la question **désigne un seul texte** (même jour et même objet : une seule œuvre dans tout le corpus) ;
5. la mention « À savoir » est elle-même prouvée par un autre texte du corpus ;
6. pour une question « assistant » : la citation doit figurer **mot pour mot** (casse, accents et apostrophes tolérés) dans le texte de l'application tel qu'un lecteur le voit (`verify.app_text()`, sans scripts ni balises), la preuve de la bonne réponse doit figurer dans la citation, et une telle question n'a ni page, ni PDF, ni lien. Si le texte de l'application change, la vérification échoue et la question doit être revue.

Les titres, numéros, dates et liens affichés sont recopiés du corpus par `build.py` : `questions.json` n'en contient pas. La première exécution a d'ailleurs détecté une imprécision de ma part (« 4 novembre 2018 » alors que l'en-tête imprime « 04 NOVEMBRE 2018 ») : corrigée avant tout usage.

**Ce que la vérification ne prouve pas** : que le choix de la question est pertinent, que le sens de la bonne réponse correspond bien à la phrase citée (cette correspondance, comme pour les autres questions, a été vérifiée à la relecture, pas par la machine), que les réponses fausses sont bien fausses dans le sens courant du droit (elles sont contrôlées contre l'intitulé, pas contre un juriste), que le texte est toujours en vigueur. Lisez toujours la question dans le PDF avant de l'ajouter.

## 5. Ajouter ou modifier une question

1. Choisir un document dans `corpus/metadata/documents_fr.json` (idéalement : numéro et date « en-tête du document », `extraction_method` = `pdf_text`, qualité `ok`) et lire le passage dans `corpus/extracted/fr/<document_id>.txt` (repère `[[PAGE n]]`).
2. Ajouter un objet à `local_app/quiz/questions.json` :
   * `id` unique, `level` (`facile` pour être servie, `difficile` sinon), `kind` (`contenu`, `objet`, `valeur`, `date`, `numero`, `type`, `relation`, `pages`, `assistant`), `question`, `choices` (3 ou 4, la bonne en position `answer`, l'ordre est mélangé à l'affichage), `explanation` ;
   * `source` : `document_id`, `reference` (« Article 5 », « Intitulé du texte »…), `page`, `quote` (mot pour mot ; casse, accents, apostrophes, retours à la ligne et césures sont tolérés, pas les mots ni les chiffres) ;
   * `check` selon le type : `evidence` (contenu : extraits de la citation qui justifient la bonne réponse) ; `title_contains` + `title_excludes` (une entrée par fausse réponse) pour objet, valeur et relation ; `date` + `designation` {date, phrase} pour date ; `number` + `designation` pour numéro ; `document_type` + `title_starts` pour type ; `page_count` pour pages ;
   * `limit` (facultatif) : clé d'une mention déclarée dans `limits`, avec la preuve (`document_id` + `contains`).
3. `python -m local_app.quiz.build --pdf` : vérifie, puis régénère `quiz-data.js` (sans `--pdf` si `corpus/raw` est absent : la CI ne contrôle que le texte extrait).
4. Lancer `python local_app/tests/test_quiz_data.py`, `node --test local_app/tests/test_quiz.mjs` et `python local_app/tests/test_ui.py`.
5. Ne jamais éditer `quiz-data.js` à la main : le test de cohérence échouerait.

## 6. Tests (tous exécutés)

* `test_quiz_data.py` (10) : **seules les questions faciles sont servies et elles sont écrites en mots courants** (2 ou 3 réponses, question de 100 caractères au plus, aucun numéro, article ni date dans la question, ni date, ni numéro, ni page à retenir), toutes les questions vérifiées dans le corpus, dans les PDF d'origine quand ils sont présents, fichier de données à jour, banque variée avec références complètes, questions « article » citant l'article, **détection d'une question fausse** (citation inventée, page fausse, date fausse, numéro faux, document inexistant, réponse fausse présente dans l'intitulé, désignation ambiguë, mauvais nombre de pages…), absence d'emoji, de mot technique ou de secret, scripts servis par l'application et chargés avant `app.js`.
* `test_quiz.mjs` (11, Node seul) : sélection (60 tirages : 5 questions, textes distincts, types plafonnés, une question d'article et une question sur l'assistant), mélange des réponses (la bonne réponse suit), déterminisme, questions non vues d'abord, banque réduite ou vide, score, messages de chaque palier, meilleur résultat (jamais écrasé par un moins bon, stockage absent ou corrompu toléré), absence de tout code réseau ou d'injection de HTML.
* `test_ui.mjs`, dans un vrai navigateur sans fenêtre (7 tests du quiz ; 63 au total avec l'interface refondue et la fenêtre de jeu) : proposition à côté du jeu et jamais lancé seul, présentation, passage au jeu et retour au suivi ; les 5 questions (correction, explication, source avec lien officiel, réponse non modifiable, score 3 sur 5, recommencer, meilleur résultat conservé après rechargement) ; **aucune requête, aucun appel au moteur de réponse, aucun dépôt de question pendant le quiz**, aucune réponse conservée ; clavier (Entrée), annonces pour lecteur d'écran, groupe de réponses nommé par la question, correction distinguée sans la couleur ; reprise après « Retour au suivi » et mouvement réduit ; réponse prête pendant le quiz ; téléphone 375 px (pas de défilement horizontal, cibles ≥ 44 px).
* Fenêtre de choix et de jeu (11 tests d'interface) : textes exacts et emoji, titre en grand, deux cartes côte à côte et lien « Aucun des deux » en bas, fenêtre modale (focus gardé, Tab qui boucle), **le choix agrandit la fenêtre (largeur mesurée avant et après), le quiz ou le jeu s'y joue, la progression de la demande reste collée au bas de la fenêtre et se met à jour, « Fermer » ou Échap rend la main et le quiz ou le jeu retrouve son état dans la fiche, le bouton de la fiche le rouvre**, bandeau « réponse prête » dans la fenêtre sans interrompre la partie, une seule proposition par question, fermeture à l'arrivée de la réponse, absence à la reprise par lien et sans file d'attente, **questions très simples** (2 ou 3 réponses, phrases courtes, aucun numéro), téléphone (390 et 320 px : cartes empilées, scène de jeu entièrement visible, progression visible en bas, cibles ≥ 44 px, aucun débordement), mouvement réduit (aucune animation). Les tests qui ont besoin que la réponse n'arrive pas pendant qu'ils jouent utilisent une question volontairement lente (mot-clé LENTE du faux serveur de test).
* Régression : API 52/52, suivi persistant 18/18, file d'attente 15/15, Web Push 6/6, réseau local 16/16, garde-fous 8/8, courtoisie 17/17, gel du moteur « aucun écart ».

## 7. Limites et décisions à valider

* **Aucun juriste n'a relu** les questions ni les réponses fausses proposées (voir §4). La même réserve que pour l'ensemble du projet s'applique.
* **Pas de culture générale** (IA, droit en général) : une question sans texte du corpus ni phrase de l'application à citer ne peut pas être prouvée par cette chaîne, donc elle n'a pas été ajoutée. Les 12 questions « assistant » sont la limite de ce qui est vérifiable ici ; élargir à de la culture générale demanderait une source de référence choisie et relue par un humain.
* **Deux textes seulement** pour les 10 questions servies sur les textes (la loi n° 23-09 et le règlement n° 26-01) : les autres textes de la banque (16 au total) ne servent qu'aux questions difficiles, non servies. C'est volontairement étroit plutôt qu'inventé ; le §5 permet de l'élargir sans toucher au code.
* L'ancre `#page=N` des liens dépend du lecteur PDF du navigateur : je n'ai pas vérifié son comportement dans Chrome, Edge, Firefox ni sur téléphone ; si elle est ignorée, le PDF s'ouvre à la première page et la page à consulter reste indiquée à côté du lien.
* Le quiz n'apparaît que pendant l'attente d'une réponse (file d'attente). Dans le mode local immédiat (pas d'attente), il n'est pas proposé.
* Les titres affichés sont ceux du corpus : certains comportent une mention de publication (« JO n°… »).
* Le serveur récupère son code depuis `main` : une question ajoutée ici n'est en ligne qu'après fusion puis `deploy/update_vps.sh`.
* À valider : le choix des questions et de leurs réponses fausses (idéalement par un juriste).
