# Suivi asynchrone des questions : file persistante, notification de fin, attente soignée

État : implémenté et testé en local ; **non déployé**. Le moteur gelé (`agent_fr/`) n'est pas modifié (`freeze_phase4 verify` : aucun écart).

## 1. Audit de départ

| Élément | Constat |
|---|---|
| Backend | Flask (`local_app/server.py`), un seul `Service`, un seul worker gunicorn (4 threads) devant nginx. Une question = ~150 s sur le VPS, une à la fois. |
| File existante | `local_app/waitqueue.py` : tickets, position, estimation ; **en mémoire** : un redémarrage ou une page fermée > 2 min perdait la question. |
| Stockage | Aucun. Historique seulement dans `localStorage`. |
| Notifications | Aucune. |
| Contraintes | CSP stricte (`self`), tests de contrat sur l'interface (aucune ressource externe, `fetch` vers `/api/` seulement, pas d'emoji, aucun détail technique visible), moteur gelé, application Windows à ne pas changer. |
| Dépendance Web Push | `cryptography` n'est présente qu'indirectement (pdfminer) : ajoutée **uniquement** à `deploy/requirements-deploy.txt` (la base gelée `requirements.txt` n'est pas touchée), et facultative à l'exécution. |

Ce qui n'a pas été construit, et pourquoi : une interface de rédaction de réponses. Les réponses sont produites automatiquement par le moteur ; une rédaction manuelle contredirait le produit. Les compteurs de la file sont déjà publics dans `/api/status` (sans aucune question).

## 2. Concept UX retenu : « un suivi, pas un spinner »

* Une fois la question envoyée, la zone de réponse devient une **fiche de suivi** à quatre étapes réelles : *Question envoyée, En attente de traitement, En cours de traitement, Réponse disponible*. L'étape courante est annoncée aux lecteurs d'écran (zone `role="status"`, annonce seulement quand l'état change).
* Aucune progression inventée : en attente, on affiche la **position réelle** et une attente **étiquetée « estimation »** (moyenne des dernières réponses mesurées sur le serveur, jamais une promesse) ; en cours, le temps écoulé, avec « la durée n'est pas connue à l'avance ».
* **Lien personnel** affiché et copiable ; il est dans le fragment d'adresse (`/#q=…`) : jamais envoyé au serveur, jamais dans un Referer. La page le garde aussi dans `localStorage` pour reprendre sans le lien.
* Le visiteur est prévenu **avant l'envoi** que sa question est conservée 7 jours (et dans « À propos », dont le texte par défaut « ne conserve pas » serait faux dans ce mode).
* Coupure réseau : bandeau rassurant, nouvelles tentatives espacées, reprise automatique au retour du réseau ; un nouvel essai d'envoi réutilise la même clé (aucun doublon).
* Après la lecture : date de suppression automatique et bouton « Les supprimer maintenant » (confirmation en deux temps).

## 3. Mini-jeu retenu : mémoire de paires (facultatif)

Trois pistes étudiées : **mémoire de paires**, séquence à reproduire (type Simon), réflexes. Retenu : la mémoire, parce qu'elle se joue sans son ni couleur (formes + noms accessibles « carré, disque, triangle, losange, triangle inversé, cercle »), au clavier (flèches, Début/Fin, Entrée) comme au toucher, **sans aucune pression de temps** (convient à un outil juridique sérieux), et dure environ une minute.
* Proposé par un bouton discret « Patienter en jouant (facultatif) » ; jamais lancé seul.
* Coups, temps, meilleur résultat (gardé dans ce navigateur), rejouer, « Retour au suivi » (le focus revient au bouton).
* Aucune requête réseau ; il vit dans son cadre et n'agit ni sur la question ni sur sa réponse.
* Un **quiz facultatif** sur les textes de la Banque d'Algérie complète le jeu dans le même espace (questions vérifiées dans le corpus, chacune avec sa source et le lien vers le PDF officiel) : voir `docs/QUIZ_ATTENTE.md`.
* Si la réponse arrive pendant une partie, **la partie n'est pas interrompue** : un bandeau « Votre réponse est prête » invite à la lire.
* `prefers-reduced-motion` respecté (aucune animation), cibles ≥ 44 px sur téléphone.

## 4. File persistante (`local_app/persist.py`)

* **SQLite** (bibliothèque standard, WAL, mode 600) dans `${REGASSIST_DATA_ROOT}/state/` : pas de service externe, pas de dépendance, un seul fichier. Actif en production quand `REGASSIST_DATA_ROOT` est défini ; sinon l'ancienne file en mémoire.
* États : `queued → running → done | error`. **Redémarrage** : les demandes en attente reprennent dans l'ordre ; une demande « en cours » à l'arrêt est remise en file **une fois**, puis marquée en erreur (aucune boucle infinie).
* Lien personnel = secret de 132 bits **dérivé par HMAC** de la clé d'envoi choisie par le navigateur : un nouvel essai après coupure donne le même lien (idempotence) sans stocker le lien. Seule son empreinte SHA-256 est en base ; l'adresse IP n'est conservée que salée et hachée.
* Demande « inexistante » et « d'un autre » : même réponse (404). Aucune énumération possible (132 bits).
* Conservation 7 jours (`REGASSIST_RETENTION_DAYS`), suppression sur demande, plafond de 2000 demandes (les plus anciennes réponses terminées cèdent la place, jamais une demande en attente).
* Anti-abus : 8 questions en cours ou en attente au total, 2 par adresse, 10 envois/min/adresse (nginx et application), salutations traitées sans attendre.
* Questions jamais dans les journaux ; nginx ne journalise pas `/api/queue`.

## 5. Notifications Web Push (`local_app/webpush.py`, `static/sw.js`)

* Chaîne complète sans bibliothèque tierce autre que `cryptography` : RFC 8030 (envoi), RFC 8291/8188 (chiffrement `aes128gcm`), RFC 8292 (VAPID, ES256). Clé VAPID créée au premier démarrage, hors dépôt, mode 600.
* Parcours : proposition facultative après l'envoi, explication en une phrase, **permission demandée seulement après un clic**, abonnement lié à **une** demande, utilisé **une fois** puis supprimé (ou dès un 404/410 du service push). Message : « Votre réponse est disponible ! / Revenez découvrir la réponse à votre question. » ; ni la question ni la réponse ne transitent. Le clic ouvre directement le suivi.
* **SSRF** : l'adresse d'abonnement vient du navigateur ; elle doit être en HTTPS, sans identifiants ni port, et appartenir à une liste fermée (Google FCM, Mozilla, Apple, Microsoft WNS). Redirections non suivies.
* Solutions de repli : permission refusée, permission révoquée, navigateur sans Push, service sans Push : message honnête et lien personnel ; le service ne dépend jamais des notifications ; un échec d'envoi (nouvel essai unique) n'affecte pas la réponse. Aucune notification n'est annoncée si l'infrastructure n'existe pas (la clé et l'état viennent de `/api/status`).

## 6. Tests (tous exécutés)

`test_persist.py` 18 (ordre, redémarrage simple et double, aucune donnée en clair, 404 indiscernables, idempotence, limites, suppression, expiration, abonnements, 410/échecs, SSRF, plafond, routes, service worker/CSP), `test_webpush.py` 6 (le chiffrement est **relu côté navigateur** par un déchiffrement indépendant ; contre-vérification avec la bibliothèque de référence `http_ece` quand elle est installée), `test_queue.py` 15, `test_api.py` 51, `test_ui.py` 37 dans un vrai navigateur sans fenêtre (dont 12 nouveaux : parcours complet, rechargement, lien seul sur « un autre appareil », reprise sans lien, suppression, lien inexistant ou mal formé, notifications refusées/absentes/révoquées, jeu clavier+souris, bandeau pendant une partie, mouvement réduit, téléphone 375 px, réseau coupé, double envoi). La CI exécute les nouvelles suites.

## 7. Limites restantes (à connaître)

* **Aucune notification réelle n'a été reçue** : le chiffrement et la signature sont validés contre une implémentation de référence, l'envoi est testé avec un service simulé, mais l'acheminement par Google/Mozilla/Apple jusqu'à un vrai navigateur n'a **pas** été essayé (il exige HTTPS sur le vrai domaine, donc le VPS). iOS : Web Push seulement pour un site ajouté à l'écran d'accueil (Safari 16.4+).
* Rien n'a été déployé ni testé sur le VPS (CPU sans AVX2, ~150 s par question).
* Pas de sauvegarde du fichier SQLite : sa perte ne fait perdre que les demandes en cours ou terminées.
* Une demande déposée mais jamais relue est quand même traitée (c'est le but de la persistance) : l'abus est borné par les limites ci-dessus, pas supprimé.
* Pas d'abonnement renouvelé automatiquement si le navigateur le change (événement `pushsubscriptionchange` non géré).
* Le temps d'attente affiché est une estimation fondée sur les dernières réponses ; avec 8 questions en file il peut dépasser 20 minutes.

## 8. Décisions à valider

1. **Dépendance `cryptography==49.0.0`** dans `deploy/requirements-deploy.txt` (présente ici seulement par ricochet via pdfminer ; installée en CI et sur le VPS par `requirements-deploy.txt`, donc par `update_vps.sh`). Sans elle : aucune notification, tout le reste fonctionne.
2. **Conservation des questions 7 jours sur le serveur**, changement de la promesse « l'application ne conserve pas le texte de vos questions » (le texte de l'interface s'adapte seul quand la persistance est active). Durée ajustable.
3. **Mini-jeu** : mémoire de paires (facultatif) ; supprimable sans effet sur le reste.
4. **Déploiement** sur le VPS (mise à jour par `deploy/update_vps.sh`) : non fait, à autoriser.
