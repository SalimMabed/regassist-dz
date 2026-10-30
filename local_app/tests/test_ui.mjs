// Tests de l'interface dans un VRAI navigateur (Edge/Chrome sans fenêtre), pilotés par le protocole DevTools : aucune dépendance npm (voir cdp.mjs).
// Variables : UI_URL (serveur de test normal), UI_URL_LLM_OFF (serveur dont le LLM est « éteint »), BROWSER_PATH (facultatif).
// Lancement habituel : python local_app/tests/test_ui.py  (démarre les serveurs de test, lance ce fichier, affiche « Tests UI : X/Y »).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBrowser } from './cdp.mjs';

const URL_MAIN = process.env.UI_URL;
const URL_OFF = process.env.UI_URL_LLM_OFF;
const ORIGIN = new URL(URL_MAIN).origin;

let B;
before(async () => { B = await startBrowser(); });
after(() => B && B.close());
const ev = (e) => B.ev(e), waitFor = (...a) => B.waitFor(...a), nav = (u) => B.nav(u), send = (...a) => B.send(...a), fresh = (u = URL_MAIN) => B.fresh(u);
const text = (s) => B.text(s), count = (s) => B.count(s), exists = (s) => B.exists(s), ask = (q) => B.ask(q);
const TECH = /qwen|llama|rerank|hybrid|retriev|PHASE_4|NO-GO|FROZEN|127\.0\.0\.1|OCR_UNCERTAIN|chunk|règle [A-Z]|\bLLM\b|\bms\b|modèle local|moteur|Traçabilité|\bACTIVE\b|\bREPLACED\b|\bMODIFIED\b|\bABROGATED\b|\bHISTORICAL\b|\bUNKNOWN\b/i;
async function assertNoTechnicalDetail(where) {
  const t = await ev('document.body.innerText'); const m = TECH.exec(t);
  assert.equal(m, null, 'détail technique visible (' + where + ') : ' + (m && m[0]) + ' … ' + (m ? t.slice(Math.max(0, m.index - 70), m.index + 90) : ''));
}
const requests = { get length() { return B.requests.length; }, filter: (f) => B.requests.filter(f) };

test("isolement : le navigateur de test n'a aucun accès Internet (donc l'interface fonctionne hors ligne)", async () => {
  const r = await send('Page.navigate', { url: 'https://example.com/' });
  assert.match(r.errorText || '', /ERR_NAME_NOT_RESOLVED/, "l'Internet doit être inaccessible pour ce navigateur : " + JSON.stringify(r));
  B.requests.length = 0;                    // cette sonde est une requête du TEST, pas de l'application : on repart d'un relevé vide
});

test('chargement : mention « projet éducatif non officiel », données publiques, aucun détail technique', async () => {
  await fresh();
  assert.equal(await ev('document.title'), 'Assistant juridique - projet éducatif non officiel');
  assert.match(await text('.brand-title'), /ASSISTANT JURIDIQUE/);
  assert.equal((await text('.badge-edu')).trim(), 'PROJET ÉDUCATIF · NON OFFICIEL');
  const notice = await text('#notice');
  for (const x of ['Projet éducatif non officiel', "n'est ni affilié à la Banque d'Algérie ni approuvé par elle", 'textes publics', 'intelligence artificielle', 'pas été validées par un juriste',
    'ne constituent pas un avis juridique', 'Seul le texte officiel (PDF) fait foi']) assert.ok(notice.includes(x), x + ' absent du bandeau : ' + notice);
  const footer = await text('.footer');
  for (const x of ['Projet éducatif non officiel', "Données publiques de la Banque d'Algérie", 'Réponses rédigées par une IA', 'Ne constitue pas un avis juridique']) assert.ok(footer.includes(x), x + ' absent du pied de page : ' + footer);
  assert.equal(await exists('#chip-local, #footer .led, #status-panel, #btn-status'), false, "plus d'indicateur ni de panneau technique");
  await assertNoTechnicalDetail('chargement');
  assert.equal(await ev(`document.getElementById('btn-send').disabled`), true);
  assert.equal(await count('.placeholder'), 2);
  assert.equal(await count('.chip'), 3, "3 puces de questions d'exemple");
});

test("« À propos » : projet éducatif non officiel, données publiques, IA non entraînée sur ces textes, limites et vie privée", async () => {
  await fresh();
  assert.equal(await ev(`document.getElementById('about-panel').hidden`), true);
  await ev(`document.getElementById('btn-about').click()`);
  await waitFor(`!document.getElementById('about-panel').hidden`, 'ouverture du panneau');
  assert.equal(await ev(`document.getElementById('btn-about').getAttribute('aria-expanded')`), 'true');
  const t = await text('#about-panel');
  for (const x of ['projet éducatif non officiel', "n'est affilié ni à la Banque d'Algérie ni à aucune autorité", 'données publiques', "n'a pas été entraînée ni spécialisée sur ces textes",
    'ne remplace ni un professionnel du droit ni le texte officiel', 'ne conserve pas le texte de vos questions', "n'ont pas été validées par un juriste"]) assert.ok(t.includes(x), x + ' absent : ' + t);
  await assertNoTechnicalDetail('à propos');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(`document.getElementById('about-panel').hidden`, 'fermeture du panneau');
});

test('envoi d\'une question : affichage du traitement, de la réponse et des sources citées, sans détail technique', async () => {
  await fresh();
  await ev(`document.querySelectorAll('.chip')[0].click()`);
  assert.equal(await ev(`document.getElementById('question').value`), "Quel est le plafond d'indemnisation par déposant ?");
  await ev(`document.getElementById('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))`);
  await waitFor(`document.getElementById('answer').getAttribute('aria-busy') === 'true' && document.querySelector('#answer .loading')`, 'affichage du traitement en cours');
  assert.match(await text('#answer .loading'), /Recherche dans les textes puis rédaction de la réponse/);
  assert.equal(await ev(`document.getElementById('btn-send').disabled`), true, 'envoi désactivé pendant le traitement');
  assert.equal(await ev(`document.querySelectorAll('.chip')[0].disabled`), true, 'puces désactivées pendant le traitement');
  await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
  assert.match(await text('#question-echo .q-text'), /plafond d'indemnisation/);
  assert.match(await text('#answer .ans-text'), /2\.000\.000 DA/);
  assert.equal(await count('#answer .cite'), 2, 'citation [S1] cliquable dans le texte et dans la liste des sources citées');
  assert.equal(await count('#sources .source'), 2);
  assert.equal(await count('#sources .source.cited'), 1);
  assert.match(await text('#src-S1 .src-cited'), /Cité dans la réponse/);
  assert.equal(await exists('#src-S2 .src-cited'), false);
  assert.match(await text('#answer .tags .tag-warn'), /1 avertissement\(s\)/);
  assert.match(await text('#answer .callout-after'), /Correspondance partielle/);
  assert.equal(await exists('#answer .timings'), false, 'plus de durées affichées');
  assert.equal(await exists('#answer .timing-badge'), false, 'aucun badge technique de timing');
  assert.match(await text('#answer .ans-label'), /Réponse rédigée par une intelligence artificielle uniquement à partir des sources listées avec elle\. Elle peut contenir des erreurs : vérifiez chaque citation dans le texte officiel \(PDF\)/);
  await assertNoTechnicalDetail('réponse');
  assert.match(await text('#answer .disclaimer'), /ne constitue pas un avis juridique/);
  assert.equal(await ev(`document.getElementById('question').value`), '');
  assert.equal(await ev(`document.getElementById('answer').hasAttribute('aria-busy')`), false);
  assert.equal(await ev(`document.querySelectorAll('.chip')[0].disabled`), false, 'puces réactivées');
});

test('affichage d\'une source : référence, type, date, article, page, statuts, extrait, liens officiels', async () => {
  await fresh();
  await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
  assert.equal((await text('#src-S1 .src-ref')), 'Règlement n° 2020-03 du 15 mars 2020');
  const meta = await ev(`Object.fromEntries([...document.querySelectorAll('#src-S1 .src-meta dt')].map(d => [d.textContent, d.nextElementSibling.textContent]))`);
  assert.deepEqual(meta, { 'Type de texte': 'Règlement', Date: '15 mars 2020', Article: 'Article 10', Page: 'p. 3–4 du PDF' });
  const tags = await text('#src-S1 .tags');
  assert.ok(tags.includes('Statut juridique : Dernière version connue') && tags.includes('Statut du texte : STATUT À VÉRIFIER'), tags);
  assert.ok(!/en vigueur/i.test(await text('#src-S1')), "l'interface ne doit jamais écrire « en vigueur »");
  assert.match(await text('#src-S1 .excerpt'), /plafond d'indemnisation par déposant est fixé à deux millions/);
  assert.match(await text('#src-S1'), /Abroge : Règlement n° 2004-03 du 4 mars 2004/);
  const link = await ev(`(() => { const a = document.querySelector('#src-S1 .src-links a'); return { t: a.textContent, h: a.href, target: a.target, rel: a.rel }; })()`);
  assert.deepEqual(link, { t: 'PDF officiel', h: 'https://www.bank-of-algeria.dz/stoodroa/2021/03/reglement202003.pdf', target: '_blank', rel: 'noopener noreferrer' });
  assert.equal(await exists('#src-S1 .src-trace'), false); assert.ok(!/REG-20-03|chunk/.test(await text('#sources')), 'identifiant interne affiché');
  const shown = await text('#sources');
  assert.ok(!/score|similarit/i.test(shown), 'aucun score interne affiché');
  await ev(`document.querySelector('#answer .cite').click()`);
  assert.equal(await ev(`document.getElementById('src-S1').classList.contains('flash')`), true, 'le clic sur [S1] met la source en évidence');
});

test('refus : présenté comme une absence de réponse, jamais comme une réponse', async () => {
  await fresh();
  await ask('REFUS capitale de la France'); await waitFor(`document.querySelector('#answer .callout-info')`, 'refus');
  assert.match(await text('#answer .callout-info'), /Aucune réponse établie/);
  assert.match(await text('#answer .callout-info'), /Je ne trouve pas de disposition correspondante/);
  assert.match(await text('#answer'), /Cela ne prouve pas qu'aucune disposition n'existe/);
  assert.equal(await exists('#answer .ans-text'), false);
  assert.equal(await count('#sources .source'), 0);
  assert.match(await text('#sources'), /Aucune source retenue/);
});

test('refus du modèle : les passages examinés restent visibles mais ne sont pas présentés comme sources de la réponse', async () => {
  await fresh();
  await ask('REFMODELE'); await waitFor(`document.querySelector('#answer .callout-info')`, 'refus du modèle');
  assert.equal((await text('#answer .callout-info h3')).trim(), 'Je ne peux pas répondre directement, mais voici quelques textes qui pourraient vous aider à trouver la réponse :');
  assert.equal(await count('#answer .text-item'), 1);
  assert.match(await text('#answer'), /Pourquoi pas de réponse directe[\s\S]*Je ne trouve pas de disposition correspondante[\s\S]*Des passages ont été examinés, mais aucune réponse sourcée n'a pu en être tirée/);
  assert.match(await text('#sources .pane-sub'), /examiné\(s\) : aucun n'a permis d'établir une réponse/);
  assert.equal(await count('#sources .source'), 1); assert.equal(await count('#sources .source.cited'), 0);
});

test('question ambiguë : demande de précision visible', async () => {
  await fresh();
  await ask('AMBIGU règlement'); await waitFor(`document.querySelector('#answer .callout-info')`, 'précision');
  assert.match(await text('#answer .callout-info'), /Précision nécessaire/);
  assert.match(await text('#answer .callout-info'), /trop générale/);
  assert.equal(await exists('#answer .ans-text'), false);
});

test('erreurs : message clair sans pile d\'erreur ni détail interne, l\'envoi reste possible ensuite', async () => {
  await fresh();
  await ask('BUG'); await waitFor(`document.querySelector('#answer .callout-error')`, 'erreur interne');
  const t = await text('#answer');
  assert.match(t, /La question n'a pas pu être traitée/); assert.match(t, /Une erreur est survenue\. Réessayez dans un instant/);
  assert.ok(!/Traceback|ValueError|secret|\.py|C:\\/.test(t), 'détail interne affiché : ' + t);
  assert.equal(await count('.history .hist-item'), 0, 'une erreur n\'entre pas dans l\'historique');
  await ask('PLANTAGE'); await waitFor(`document.querySelector('#answer .callout-error')?.textContent.includes('service de recherche')`, 'service de recherche indisponible');
  assert.ok(!/vec_|D:\\|FileNotFound/.test(await text('#answer')));
  await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'reprise après erreur');
});

test('service de rédaction indisponible : message simple, textes affichés sans réponse rédigée, aucun détail technique', async () => {
  await fresh(URL_OFF);
  assert.match(await text('#composer-msg'), /Le service de rédaction des réponses est momentanément indisponible\. Les textes pertinents seront affichés sans réponse rédigée\./);
  await ask('LLMOFF plafond'); await waitFor(`document.querySelector('#answer .callout-warn')`, 'service indisponible');
  assert.match(await text('#answer .callout-warn'), /Le service de rédaction des réponses est momentanément indisponible\./);
  assert.equal(await exists('#answer .ans-text'), false);
  assert.match(await text('#sources .pane-sub'), /Aucune réponse n'a été rédigée/);
  assert.equal(await count('#sources .source'), 1);
  await assertNoTechnicalDetail('service indisponible');
});

test('échec de génération (serveur en ligne) : un seul message clair, passages affichés, jamais présenté comme une réponse', async () => {
  await fresh();
  await ask('ILLISIBLE plafond'); await waitFor(`document.querySelector('#answer .callout-warn')`, 'échec de génération');
  const t = await text('#answer');
  const msg = "La réponse n'a pas pu être rédigée correctement (question trop large ou réponse trop longue)";
  assert.equal(t.split(msg).length - 1, 1, 'message affiché ' + (t.split(msg).length - 1) + ' fois : ' + t);
  assert.equal((await text('#answer .callout-info h3')).trim(), 'Je ne peux pas répondre directement, mais voici quelques textes qui pourraient vous aider à trouver la réponse :');
  assert.match(await text('#answer .callout-warn'), /Pourquoi pas de réponse directe/);
  assert.equal(await count('#answer .text-item'), 1);
  assert.match(t, /essayez une question plus précise/);
  assert.match(t, /Correspondance partielle/);                       // les autres notes du système restent visibles
  assert.ok(!/indisponible|illisible|extractive/.test(t), 'message inadapté ou interne : ' + t);
  await assertNoTechnicalDetail('échec de génération');
  assert.equal(await exists('#answer .ans-text'), false);
  assert.match(await text('#sources .pane-sub'), /Aucune réponse n'a été rédigée/);
  assert.equal(await count('#sources .source'), 1);
});

test('pas de réponse directe : « Je ne peux pas répondre directement, mais voici quelques textes… » avec la description de chaque texte', async () => {
  await fresh();
  await ask('GROUPES'); await waitFor(`document.querySelector('#answer .text-item')`, 'liste des textes');
  assert.equal((await text('#answer .callout-info h3')).trim(), 'Je ne peux pas répondre directement, mais voici quelques textes qui pourraient vous aider à trouver la réponse :');
  assert.match(await text('#answer .callout-info'), /ne constituent pas une réponse et ne contiennent pas nécessairement l'information recherchée/);
  assert.equal(await exists('#answer .ans-text'), false, 'aucun texte de réponse ne doit être affiché');
  assert.equal(await count('#answer .text-item'), 2, '3 passages de 2 textes : regroupés par texte');
  // texte 1 : description tirée des métadonnées
  const t1 = await ev(`(() => { const li = document.querySelectorAll('#answer .text-item')[0];
    return { ref: li.querySelector('.text-ref').textContent, bold: li.querySelector('.text-ref strong').textContent, hasSeparateTitle: !!li.querySelector('.text-title'),
      meta: Object.fromEntries([...li.querySelectorAll('.src-meta dt')].map(d => [d.textContent, d.nextElementSibling.textContent])),
      passages: [...li.querySelectorAll('.src-meta .cite')].map(b => b.textContent), tags: li.querySelector('.tags').textContent,
      link: li.querySelector('.src-links a').href, rel: li.querySelector('.rel').textContent }; })()`);
  assert.equal(t1.bold, 'Règlement n°2020-03 du 15 mars 2020', 'la référence est mise en gras au début de l\'intitulé');
  assert.equal(t1.ref, 'Règlement n°2020-03 du 15 mars 2020 relatif au système de garantie des dépôts bancaires', 'référence et intitulé sur UNE ligne, sans répétition');
  assert.equal(t1.hasSeparateTitle, false);
  assert.deepEqual(t1.meta['Type de texte'], 'Règlement'); assert.equal(t1.meta['Date'], '15 mars 2020');
  assert.deepEqual(t1.passages, ['Article 10 (S1)', 'Article 11 (S2)']);
  assert.ok(t1.tags.includes('Statut juridique : Dernière version connue') && !/en vigueur/i.test(t1.tags), t1.tags);
  assert.equal(t1.link, 'https://www.bank-of-algeria.dz/stoodroa/2021/03/reglement202003.pdf');
  assert.equal(t1.rel, 'Abroge : Règlement n° 2004-03 du 4 mars 2004');
  // texte 2 : texte abrogé, signalé comme tel
  const t2 = await ev(`(() => { const li = document.querySelectorAll('#answer .text-item')[1];
    return { ref: li.querySelector('.text-ref').textContent, tags: li.querySelector('.tags').textContent, alert: li.querySelector('.src-alert').textContent, rel: li.querySelector('.rel').textContent }; })()`);
  assert.equal(t2.ref, 'Instruction n°05-2025 du 17 juillet 2025 relative au droit de change pour voyage à l’étranger.');
  assert.ok(t2.tags.includes("Statut juridique : Abrogé d'après les textes"), t2.tags);
  assert.match(t2.alert, /Ce texte a été abrogé par Instruction n° 07-2026/); assert.match(t2.rel, /Abrogé par : Instruction n° 07-2026 du 13 juillet 2026/);
  // un passage cliquable renvoie à la carte détaillée dans le volet Sources ; les 3 passages y restent disponibles
  assert.equal(await count('#sources .source'), 3);
  await ev(`document.querySelectorAll('#answer .text-item')[1].querySelector('.cite').click()`);
  assert.equal(await ev(`document.getElementById('src-S3').classList.contains('flash')`), true);
  // la cause reste visible, une seule fois ; rien d'interne
  const all = await text('#answer');
  assert.match(all, /Pourquoi pas de réponse directe/);
  assert.equal(all.split("La réponse n'a pas pu être rédigée correctement").length - 1, 1);
  assert.ok(!/score|similarit|chunk|illisible|extractive|llama-server/i.test(all), 'donnée interne affichée : ' + all);
  await assertNoTechnicalDetail('textes proposés');
});

test("codes internes de statut recopiés par l'IA : affichés en langage courant, notes sans jargon", async () => {
  await fresh();
  await ask('CODES plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
  assert.match(await text('#answer .ans-text'), /statut juridique dernière version connue, l'ancien texte est remplacé \(version antérieure\) et un autre est vigueur non déterminée/);
  const notes = await text('#answer .callout-after');
  assert.match(notes, /écartée de l'analyse/); assert.match(notes, /À vérifier : valeur numérique de ce passage arabe/); assert.match(notes, /\(2000\.000\)/);   // la valeur douteuse reste visible telle quelle
  assert.ok(!/règle U-ISOL|LLM|OCR_UNCERTAIN/.test(notes), 'jargon interne dans les avertissements : ' + notes);
  await assertNoTechnicalDetail('codes internes');
});

test('pas de réponse directe : intitulé distinct de la référence affiché sur une seconde ligne', async () => {
  await fresh();
  await ask('TITRE'); await waitFor(`document.querySelector('#answer .text-item')`, 'liste des textes');
  assert.equal(await text('#answer .text-ref strong'), 'Note n° 03-92 du 4 août 1992');
  assert.equal(await text('#answer .text-ref'), 'Note n° 03-92 du 4 août 1992');
  assert.equal(await text('#answer .text-title'), 'Recueil des dispositions relatives aux opérations de change');
});

test('courtoisie : « Bonjour » reçoit un accueil, pas un refus ; aucune source, aucun détail technique', async () => {
  await fresh();
  await ask('Bonjour'); await waitFor(`document.querySelector('#answer .ans-text')`, 'accueil');
  const a = await text('#answer');
  assert.match(a, /^Bonjour !/);
  assert.ok(a.includes('assistant éducatif non officiel') && a.includes("Quel est le plafond d'indemnisation par déposant"), a);
  assert.ok(!/Aucune réponse établie|Je ne trouve pas de disposition|Cela ne prouve pas/.test(a), 'présenté comme un refus : ' + a);
  assert.equal(await exists('#answer .callout'), false, 'pas de cadre de refus ni d\'avertissement');
  assert.equal(await count('#sources .source'), 0);
  assert.match(await text('#sources'), /Aucune source : ce message n'est pas une question sur un texte réglementaire/);
  await assertNoTechnicalDetail('courtoisie');
  await ask('Merci'); await waitFor(`document.querySelector('#answer .ans-text') && document.querySelector('#answer .ans-text').innerText.startsWith('Avec plaisir')`, 'remerciement');
  assert.equal(await count('#history-list .hist-item'), 2);                      // chaque message reste dans l'historique du navigateur
});

test('définition non soutenue par les textes : la réponse fausse est retirée, le terme et la raison sont dits clairement', async () => {
  await fresh();
  await ask('C’est quoi l’allocation touristique ?'); await waitFor(`document.querySelector('#answer .callout-info')`, 'refus de définition');
  const a = await text('#answer');
  assert.match(a, /Aucune réponse établie/);
  assert.match(a, /« allocation touristique » n'apparaît dans aucun des textes retrouvés/);
  assert.ok(!/rapatriement|dépouille|50\.000|allocation en devises/.test(a), 'texte de la fausse réponse encore visible : ' + a);
  assert.equal(await exists('#answer .ans-text'), false);
  assert.equal(await count('#sources .source'), 0);
  assert.equal(await count('#answer .text-item'), 0, 'aucune liste de textes « qui pourraient vous aider » : ils parlaient d\'autre chose');
  await assertNoTechnicalDetail('définition non soutenue');
});

test('pas de réponse directe : aucune liste quand aucun texte n\'a été retrouvé (refus de la recherche)', async () => {
  await fresh();
  await ask('REFUS capitale de la France'); await waitFor(`document.querySelector('#answer .callout-info')`, 'refus');
  assert.equal(await count('#answer .text-item'), 0);
  assert.ok(!(await text('#answer')).includes('voici quelques textes'));
  assert.match(await text('#answer .callout-info'), /Aucune réponse établie/);
});

test('sécurité : le texte du corpus et de la réponse n\'est jamais interprété comme du HTML ou du script', async () => {
  await fresh();
  await ask('XSS'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
  assert.equal(await ev('window.__xss'), undefined);
  assert.equal(await count('#sources img, #sources script, #answer i, #answer script'), 0);
  assert.match(await text('#src-S1 .excerpt'), /<img src=x onerror="window\.__xss=1"><script>window\.__xss=2<\/script> Texte du corpus/);
  assert.equal(await text('#src-S1 .src-ref'), '<b>Règlement</b> piégé');
  assert.match(await text('#answer .ans-text'), /Réponse <i>balisée<\/i>/);
});

test('historique : conservé après rechargement, réponse restituée au clic', async () => {
  await fresh();
  await ask('Première question sur le plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse 1');
  await ask('REFUS deuxième question'); await waitFor(`document.querySelector('#answer .callout-info')`, 'réponse 2');
  assert.equal(await count('#history-list .hist-item'), 2);
  assert.equal(await count('#history-list .conv-head'), 1);
  await nav(URL_MAIN);
  await waitFor(`document.querySelectorAll('#history-list .hist-item').length === 2`, 'historique après rechargement');
  await ev(`[...document.querySelectorAll('.hist-item')].find(b => b.textContent.startsWith('Première')).click()`);
  await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse restituée');
  assert.match(await text('#question-echo .q-text'), /Première question sur le plafond/);
  assert.match(await text('#question-echo .q-saved'), /Réponse enregistrée le .* \(historique de ce navigateur\) : elle n'est pas recalculée/);
  assert.equal(await ev(`document.querySelector('.hist-item[aria-current="true"]').textContent`), 'Première question sur le plafond');
  assert.equal(await count('#sources .source'), 2);
});

test('nouvelle conversation : espace de travail vidé, nouvelle série dans l\'historique', async () => {
  await ev(`document.getElementById('btn-new').click()`);
  await waitFor(`document.getElementById('question-echo').hidden`, 'écran vide');
  assert.equal(await count('#sources .source'), 0); assert.equal(await count('.placeholder'), 2);
  await ask('Troisième question'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse 3');
  assert.equal(await count('#history-list .conv-head'), 2);
  assert.equal(await count('#history-list .hist-item'), 3);
});

test('effacer l\'historique : confirmation en deux temps, puis liste et stockage vides', async () => {
  await ev(`document.getElementById('btn-clear').click()`);
  assert.equal((await text('#btn-clear')).trim(), "Confirmer l'effacement");
  assert.equal(await count('#history-list .hist-item'), 3, 'rien n\'est effacé au premier clic');
  await ev(`document.getElementById('btn-clear').click()`);
  await waitFor(`document.querySelector('.history-empty')`, 'historique vide');
  assert.equal(await ev(`localStorage.getItem('regassist.history.v1')`), null);
});

test('limite de longueur : compteur, blocage de l\'envoi au-delà de 500 caractères', async () => {
  await fresh();
  await ev(`(() => { const t = document.getElementById('question'); t.value = 'a'.repeat(501); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal((await text('#counter')).trim(), '501 / 500');
  assert.equal(await ev(`document.getElementById('counter').classList.contains('over')`), true);
  assert.equal(await ev(`document.getElementById('btn-send').disabled`), true);
  await ev(`(() => { const t = document.getElementById('question'); t.value = 'a'.repeat(500); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await ev(`document.getElementById('btn-send').disabled`), false);
});

test('service injoignable : message simple, envoi bloqué', async () => {
  await fresh();
  await ev(`window.fetch = () => Promise.reject(new TypeError('Failed to fetch')); window.dispatchEvent(new Event('focus'))`);
  await waitFor(`document.getElementById('composer-msg').textContent.includes('injoignable')`, 'message de service injoignable');
  assert.match(await text('#composer-msg'), /Le service est momentanément injoignable\. Réessayez dans un instant\./);
  assert.equal(await ev(`document.getElementById('btn-send').disabled`), true);
});

test('affichage étroit (téléphone) : pas de défilement horizontal, volets empilés', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  try {
    await fresh();
    await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
    const m = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, cols: getComputedStyle(document.querySelector('.panes')).gridTemplateColumns.trim().split(/\\s+/).length })`);
    assert.ok(m.sw <= m.iw + 1, `défilement horizontal : ${m.sw} > ${m.iw}`);
    assert.equal(m.cols, 1);
  } finally { await send('Emulation.clearDeviceMetricsOverride'); }
});

/* ---------- suivi persistant, notifications, mini-jeu (serveur de test avec file persistante, UI_URL_PERSIST) ---------- */
const URL_PERSIST = process.env.UI_URL_PERSIST;
const reopen = async (url) => { await nav('about:blank'); await nav(url); };           // vraie réouverture : une navigation vers la même adresse + fragment ne rechargerait pas la page
const askTracked = async (q = 'plafond') => { await ask(q); await waitFor(`!!document.querySelector('.track')`, 'fiche de suivi'); };
const answered = (what = 'réponse affichée') => waitFor(`!!document.querySelector('#answer .ans-text')`, what, 40000);
const historyTicket = () => ev(`JSON.parse(localStorage.getItem('regassist.history.v1')).convs.flatMap((c) => c.entries).map((e) => e.ticket).filter(Boolean).pop()`);
const status = (path, init = '') => ev(`fetch(${JSON.stringify(path)}${init ? ', ' + init : ''}).then((r) => r.status)`);

test('suivi persistant : conservation annoncée avant l\'envoi, fiche de suivi, lien personnel, puis réponse', async () => {
  await fresh(URL_PERSIST);
  assert.match(await ev(`document.getElementById('persist-note').innerText`), /conservées sur le serveur 7 jours/);
  await ev(`document.getElementById('btn-about').click()`);
  const about = await ev(`document.getElementById('about-panel').innerText`);
  assert.match(about, /conservées sur le serveur pendant 7 jours/);
  assert.ok(!about.includes('ne conserve pas le texte de vos questions'), 'la phrase par défaut serait fausse ici : elle ne doit plus être visible');
  await ev(`document.getElementById('btn-about-close').click()`);
  await askTracked();
  assert.equal(await count('.track-step'), 4);
  assert.equal(await count('.track-step[aria-current="step"]'), 1);
  assert.match(await ev('location.hash'), /^#q=[A-Za-z0-9_-]{22}$/, 'le lien personnel est dans le fragment, jamais envoyé au serveur');
  assert.equal(await ev(`document.querySelector('.track-link input').value.endsWith(location.hash)`), true);
  assert.match(await text('.track'), /Vous pouvez fermer cette page/);
  assert.equal(await ev(`!!localStorage.getItem('regassist.active.v1')`), true);
  await assertNoTechnicalDetail('suivi');
  await answered();
  assert.equal(await ev('location.hash'), '');
  assert.equal(await ev(`localStorage.getItem('regassist.active.v1')`), null, 'plus rien à reprendre une fois la réponse lue');
  assert.match(await text('.server-note'), /restent sur le serveur jusqu'au/);
});

test('retour sur le site : rechargement en plein traitement, puis lien ouvert sans aucune donnée locale', async () => {
  await fresh(URL_PERSIST);
  await askTracked();
  const link = URL_PERSIST + (await ev('location.hash'));
  await reopen(link);                                                               // la page est fermée puis rouverte avec le lien : le suivi reprend
  await answered('réponse retrouvée après rechargement');
  assert.match(await text('#answer'), /Réponse retrouvée avec votre lien personnel/);
  assert.equal(await count('.hist-item'), 1);
  const ticket = await historyTicket();
  await ev('localStorage.clear()');                                                 // autre appareil : seul le lien est connu
  await reopen(URL_PERSIST + '#q=' + ticket);
  await answered('réponse lue avec le seul lien');
  assert.match(await text('#question-echo'), /plafond/);
  await ev('localStorage.clear()'); await nav('about:blank'); await nav(URL_PERSIST);
  const again = await ev(`document.getElementById('answer').innerText`);
  assert.match(again, /Posez une question/, 'sans lien ni suivi en cours, rien d\'une autre personne n\'est affiché');
});

test('reprise sans le lien : la question en cours est retrouvée par le navigateur', async () => {
  await fresh(URL_PERSIST);
  await askTracked();
  await reopen(URL_PERSIST);                                                        // adresse nue : le suivi est repris depuis le stockage local
  await waitFor(`!!document.querySelector('.track') || !!document.querySelector('#answer .ans-text')`, 'suivi repris');
  await answered();
});

test('suppression : la question disparaît du serveur et le lien cesse de fonctionner', async () => {
  await fresh(URL_PERSIST);
  await ask('plafond'); await answered();
  const ticket = await historyTicket();
  assert.equal(await status('/api/queue/' + ticket), 200);
  await ev(`document.querySelector('.server-note .btn').click()`);
  assert.match(await text('.server-note .btn'), /Confirmer la suppression/, 'une suppression demande une confirmation');
  await ev(`document.querySelector('.server-note .btn').click()`);
  await waitFor(`document.querySelector('.server-note').textContent.includes('Supprimées du serveur')`, 'suppression confirmée');
  assert.equal(await status('/api/queue/' + ticket), 404);
  await reopen(URL_PERSIST + '#q=' + ticket);
  await waitFor(`document.getElementById('answer').innerText.includes('Demande introuvable')`, 'message neutre pour une demande supprimée');
});

test('demande inexistante ou lien d\'une autre personne : message neutre, aucune information, service utilisable', async () => {
  await fresh(URL_PERSIST);
  await reopen(URL_PERSIST + '#q=' + 'A'.repeat(22));
  await waitFor(`document.getElementById('answer').innerText.includes('Demande introuvable')`, 'message neutre');
  const t = await ev(`document.getElementById('answer').innerText`);
  assert.ok(!/existe|appartient|autre/i.test(t.replace('n\'existe plus', '')), 'aucune distinction entre inexistante et non autorisée : ' + t);
  await reopen(URL_PERSIST + '#q=../../etc/passwd');                                // lien mal formé : ignoré, jamais envoyé au serveur
  assert.equal(await ev(`document.getElementById('answer').innerText.includes('Demande introuvable')`), false);
  assert.equal(requests.filter((u) => u.includes('/etc/passwd')).length, 0);
  await fresh(URL_PERSIST); await ask('plafond'); await answered();
});

test('notifications : proposition facultative, jamais bloquante ; refus, navigateur sans notification ou autorisation révoquée', async () => {
  await fresh(URL_PERSIST);
  await ask('plafond'); await waitFor(`!!document.querySelector('.track-notify')`, 'bloc de notification');
  const before = requests.filter((u) => u.endsWith('/sw.js')).length;
  assert.ok((await text('.track-notify .track-note')).length > 30, 'une explication ou une solution de repli est toujours affichée');
  assert.equal(requests.filter((u) => u.endsWith('/sw.js')).length, before, 'aucun service worker ni abonnement sans clic volontaire');
  await answered();
  // 1. refus de l'autorisation
  await fresh(URL_PERSIST);
  await ev(`Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); Notification.requestPermission = () => Promise.resolve('denied');`);
  await ask('plafond'); await waitFor(`!!document.querySelector('.track-notify .btn') && !document.querySelector('.track-notify .btn').hidden`, 'bouton de notification');
  assert.match(await text('.track-notify .track-note'), /Facultatif.*ni votre question ni la réponse.*Si vous refusez, rien d'autre ne change/s);
  await ev(`document.querySelector('.track-notify .btn').click()`);
  await waitFor(`document.querySelector('.track-notify .track-note').textContent.includes('Notification non activée')`, 'refus géré');
  assert.equal(requests.filter((u) => u.endsWith('/sw.js')).length, before, 'refus : aucun service worker enregistré');
  await answered('réponse malgré le refus');
  // 2. navigateur sans Web Push
  await fresh(URL_PERSIST);
  await ev(`delete window.PushManager`);
  await ask('plafond'); await waitFor(`!!document.querySelector('.track-notify')`, 'bloc');
  assert.match(await text('.track-notify .track-note'), /ne gère pas les notifications/);
  assert.equal(await ev(`document.querySelector('.track-notify .btn').hidden`), true);
  await answered('réponse sans notifications');
  // 3. autorisation révoquée dans le navigateur
  await fresh(URL_PERSIST);
  await ev(`Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true })`);
  await ask('plafond'); await waitFor(`!!document.querySelector('.track-notify')`, 'bloc');
  assert.match(await text('.track-notify .track-note'), /bloquées pour ce site/);
  await answered('réponse malgré le blocage');
});

test('mini-jeu : facultatif, clavier et souris, résultat, rejouer, retour au suivi, aucune requête', async () => {
  await fresh(URL_PERSIST);
  await ask('plafond'); await waitFor(`!!document.querySelector('.track')`, 'suivi');
  assert.equal(await count('.game'), 0, 'le jeu n\'est jamais lancé sans demande');
  await ev(`[...document.querySelectorAll('.track-actions .btn')].find((b) => /jouant/.test(b.textContent)).click()`);
  await waitFor(`document.querySelectorAll('.game-card').length === 12`, 'cartes');
  assert.equal(await ev(`document.querySelector('.track-actions .btn').getAttribute('aria-expanded')`), 'true');
  const reqs = B.requests.length;
  // clavier : une seule carte dans l'ordre de tabulation, les flèches déplacent le focus
  await ev(`document.querySelectorAll('.game-card')[0].focus()`);
  assert.equal(await ev(`document.querySelectorAll('.game-card[tabindex="0"]').length`), 1);
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  assert.equal(await ev(`[...document.querySelectorAll('.game-card')].indexOf(document.activeElement)`), 1);
  await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  assert.equal(await ev(`[...document.querySelectorAll('.game-card')].indexOf(document.activeElement)`), 5);
  assert.match(await ev(`document.activeElement.getAttribute('aria-label')`), /^Carte 6 sur 12, face cachée$/, 'nom accessible : jamais de carte sans libellé');
  // une erreur, puis toutes les paires
  await ev(`(async () => {
    const cards = [...document.querySelectorAll('.game-card')]; const by = {};
    cards.forEach((c, i) => (by[c.dataset.sym] = by[c.dataset.sym] || []).push(i));
    const k = Object.keys(by); cards[by[k[0]][0]].click(); cards[by[k[1]][0]].click();
    await new Promise((r) => setTimeout(r, 1100));
    for (const s of k) { cards[by[s][0]].click(); cards[by[s][1]].click(); }
  })()`);
  await waitFor(`/^Terminé en \\d+ coups/.test(document.querySelector('.game-result').textContent)`, 'résultat final');
  assert.equal(await count('.game-card.is-matched'), 12);
  assert.match(await text('.game-stats'), /Meilleur résultat : \d+ coups/);
  await ev(`[...document.querySelectorAll('.game-actions .btn')].find((b) => b.textContent === 'Rejouer').click()`);
  assert.equal(await count('.game-card.is-matched'), 0);
  assert.equal(await text('.game-result'), '');
  await ev(`[...document.querySelectorAll('.game-actions .btn')].find((b) => b.textContent === 'Retour au suivi').click()`);
  const closed = await ev(`({ hidden: (document.querySelector('.track-game') || { hidden: true }).hidden, focusOk: !document.querySelector('.track-game') || /jouant/.test(document.activeElement.textContent) })`);
  assert.equal(closed.hidden, true);
  assert.equal(closed.focusOk, true, 'le focus revient au bouton qui a ouvert le jeu');
  const jeu = B.requests.slice(reqs).filter((u) => !/\/api\/queue\/[A-Za-z0-9_-]+$/.test(u) && !u.endsWith('/api/status'));
  assert.deepEqual(jeu, [], 'le jeu ne fait aucune requête (hors suivi de la question) : ' + jeu.join(', '));
  await answered();
});

test('réponse prête pendant une partie : un bandeau invite à la lire, la partie n\'est pas interrompue', async () => {
  await fresh(URL_PERSIST);
  await ask('plafond'); await waitFor(`!!document.querySelector('.track')`, 'suivi');
  await ev(`[...document.querySelectorAll('.track-actions .btn')].find((b) => /jouant/.test(b.textContent)).click()`);
  await waitFor(`!!document.querySelector('.track-ready')`, 'bandeau « réponse prête »', 40000);
  assert.equal(await count('.game'), 1, 'la partie continue');
  assert.equal(await exists('#answer .ans-text'), false, 'la réponse ne remplace pas la partie sans accord du joueur');
  await ev(`document.querySelector('.track-ready .btn').click()`);
  await answered();
  assert.equal(await count('.game'), 0);
});

test('mouvement réduit : le suivi n\'anime rien ; sans préférence, le point de l\'étape en cours pulse', async () => {
  const media = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] });
  try {
    await media('reduce'); await fresh(URL_PERSIST);
    await ask('plafond'); await waitFor(`!!document.querySelector('.track-step.is-current')`, 'étape en cours');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.track-step.is-current .track-dot')).animationName`), 'none');
    await answered();
    await media('no-preference'); await fresh(URL_PERSIST);
    await ask('plafond'); await waitFor(`!!document.querySelector('.track-step.is-current')`, 'étape en cours');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.track-step.is-current .track-dot')).animationName`), 'track-pulse');
    await answered();
  } finally { await send('Emulation.setEmulatedMedia', { features: [] }); }
});

test('téléphone (375 px) : suivi et jeu sans défilement horizontal, cartes assez grandes pour le toucher', async () => {
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  try {
    await fresh(URL_PERSIST);
    await ask('plafond'); await waitFor(`!!document.querySelector('.track')`, 'suivi');
    await ev(`[...document.querySelectorAll('.track-actions .btn')].find((b) => /jouant/.test(b.textContent)).click()`);
    await waitFor(`document.querySelectorAll('.game-card').length === 12`, 'cartes');
    const m = await ev(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, card: Math.round(document.querySelector('.game-card').getBoundingClientRect().width),
      input: Math.round(document.querySelector('.track-link input').getBoundingClientRect().width) })`);
    assert.ok(m.sw <= m.iw + 1, `défilement horizontal : ${m.sw} > ${m.iw}`);
    assert.ok(m.card >= 44, 'cible tactile trop petite : ' + m.card);
    assert.ok(m.input >= 120, 'lien illisible : ' + m.input);
    await waitFor(`!!document.querySelector('.track-ready')`, 'bandeau « réponse prête » pendant la partie', 40000);          // la partie n'est pas interrompue : le joueur choisit quand lire
    await ev(`document.querySelector('.track-ready .btn').click()`);
    await answered();
  } finally { await send('Emulation.clearDeviceMetricsOverride'); }
});

test('réseau coupé pendant l\'attente : message rassurant, puis reprise sans rien perdre', async () => {
  await fresh(URL_PERSIST);
  await askTracked();
  await ev(`window.__f = window.fetch; window.fetch = () => Promise.reject(new TypeError('Failed to fetch'))`);
  await waitFor(`!document.querySelector('.track-net').hidden`, 'message de connexion interrompue', 20000);
  assert.match(await text('.track-net'), /Votre question n'est pas perdue/);
  await ev(`window.fetch = window.__f; window.dispatchEvent(new Event('online'))`);
  await answered('réponse après le retour du réseau');
});

test('double envoi : un seul dépôt ; après une coupure, le nouvel essai réutilise la même clé (aucun doublon)', async () => {
  await fresh(URL_PERSIST);
  await ev(`window.__posts = []; window.__f = window.fetch; window.fetch = (u, i) => { if (u === '/api/queue' && i && i.method === 'POST') window.__posts.push(i.headers['Idempotency-Key']); return window.__f(u, i); };`);
  await ev(`(() => { const t = document.getElementById('question'); t.value = 'plafond'; t.dispatchEvent(new Event('input', { bubbles: true })); const f = document.getElementById('form'); f.requestSubmit(); f.requestSubmit(); })()`);
  await answered();
  assert.equal(await ev('window.__posts.length'), 1, 'deux envois immédiats : un seul dépôt');
  await fresh(URL_PERSIST);
  await ev(`window.__posts = []; window.__f = window.fetch; window.__fail = true;
    window.fetch = (u, i) => { if (u === '/api/queue' && i && i.method === 'POST') { window.__posts.push(i.headers['Idempotency-Key']); if (window.__fail) { window.__fail = false; return Promise.reject(new TypeError('Failed to fetch')); } } return window.__f(u, i); };`);
  await ask('plafond');
  await waitFor(`document.getElementById('answer').innerText.includes('sans risque de doublon')`, 'message après la coupure');
  await ev(`document.getElementById('form').requestSubmit()`);
  await answered();
  const keys = await ev('window.__posts');
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1], 'même clé d\'envoi pour le nouvel essai');
  assert.match(keys[0], /^[A-Za-z0-9_-]{16,64}$/);
});


/* ---------- refonte de l'interface : la réponse d'abord, saisie hors de la zone qui défile, accueil, tiroir, signal « réponse prête » ---------- */
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`);
const phone = (w = 390, h = 844) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
const desktop = () => send('Emulation.clearDeviceMetricsOverride');
const answeredQ = (re) => waitFor(`document.querySelector('#answer .ans-text') && !document.getElementById('answer').hasAttribute('aria-busy') && ${re}.test(document.querySelector('#question-echo .q-text').textContent)`, 'réponse à la question attendue');

test('accueil : titre, trois questions d\'exemple utilisables, trois étapes, bandeau complet ; la conversation prend ensuite la place de l\'accueil', async () => {
  await fresh();
  assert.equal(await ev(`document.getElementById('workspace').classList.contains('is-empty')`), true);
  assert.match(await text('.welcome-title'), /Que cherchez-vous dans les textes de la Banque d'Algérie/);
  assert.equal(await ev(`getComputedStyle(document.querySelector('.welcome')).display`), 'block');
  assert.equal(await ev(`[...document.querySelectorAll('.chip')].every((c) => c.getBoundingClientRect().height > 40 && !c.disabled)`), true, 'puces visibles, assez hautes, utilisables');
  assert.equal(await count('.welcome-steps li'), 3);
  assert.equal(await ev(`getComputedStyle(document.querySelector('.thread')).display`), 'none', 'pas de zone de réponse vide à l\'accueil');
  assert.equal(await ev(`document.querySelector('.notice-short').offsetParent`), null, 'à l\'accueil, le bandeau complet est affiché, pas sa version courte');
  await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
  assert.equal(await ev(`getComputedStyle(document.querySelector('.welcome')).display`), 'none', 'l\'accueil laisse la place à la conversation');
  assert.equal(await count('.chip'), 3, 'les puces restent dans la page, seulement masquées');
});

test('la réponse d\'abord : grande carte au premier plan, sources dans une colonne plus étroite et plus discrète, saisie hors de la zone qui défile', async () => {
  await fresh();
  await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
  const a = await rect('.pane-answer'), s = await rect('.pane-sources'), q = await rect('#question-echo .q-text'), panes = await rect('.panes');
  assert.ok(a.l < s.l, 'la réponse est avant les sources');
  assert.ok(a.w > s.w * 1.4, `la réponse est la plus large : ${a.w} contre ${s.w}`);
  assert.ok(Math.abs(q.r - panes.r) < 2, 'la question de l\'utilisateur est alignée à droite, la réponse à gauche');
  const f = await ev(`(() => { const g = (sel) => getComputedStyle(document.querySelector(sel)); const t = g('#answer .ans-text'); return { ans: parseFloat(t.fontSize), lh: parseFloat(t.lineHeight) / parseFloat(t.fontSize), width: document.querySelector('#answer .ans-text').getBoundingClientRect().width, src: parseFloat(g('#sources .src-title').fontSize), family: t.fontFamily }; })()`);
  assert.ok(f.ans >= 17, 'texte de la réponse assez grand : ' + f.ans); assert.ok(f.lh >= 1.6, 'interligne confortable : ' + f.lh);
  assert.ok(f.width <= 760, 'largeur de lecture limitée : ' + f.width); assert.ok(f.src < f.ans, 'les sources sont typographiquement plus discrètes que la réponse');
  const dock = await rect('.composer-dock'), scroll = await rect('#scroll');
  assert.ok(scroll.b <= dock.t + 1, 'la saisie ne recouvre jamais la zone de contenu (' + scroll.b + ' > ' + dock.t + ')');
  await ev(`document.querySelector('.pane-sources .pane-body').scrollIntoView()`);
  assert.equal(await ev(`document.getElementById('scroll').scrollHeight >= document.getElementById('scroll').clientHeight`), true);
});

test('téléphone : la réponse est visible dès le premier écran et au-dessus des sources, bandeau compact, saisie collée en bas, aucun débordement', async () => {
  await phone();
  try {
    await fresh();
    assert.equal(await ev(`!!document.querySelector('.notice-full').offsetParent`), true, 'à l\'accueil, texte complet de la mise en garde');
    await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
    const m = await ev(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, vh: window.visualViewport.height, ih: innerHeight, ansTop: document.querySelector('#answer .ans-text').getBoundingClientRect().top, srcTop: document.querySelector('.pane-sources').getBoundingClientRect().top,
      dockBottom: document.querySelector('.composer-dock').getBoundingClientRect().bottom, appH: getComputedStyle(document.documentElement).getPropertyValue('--app-h'), vvH: window.visualViewport.height, bodyH: document.body.getBoundingClientRect().height, short: !!document.querySelector('.notice-short').offsetParent, full: !!document.querySelector('.notice-full').offsetParent })`);
    assert.ok(m.sw <= m.iw + 1, `défilement horizontal : ${m.sw} > ${m.iw}`);
    assert.ok(m.ansTop < m.vh * 0.6, 'le texte de la réponse est dans la moitié haute du premier écran : ' + m.ansTop + ' / ' + m.vh);
    assert.ok(m.ansTop < m.srcTop, 'réponse au-dessus des sources');
    // Référence : la zone réellement visible (visualViewport). Dans un navigateur sans interface, window.innerHeight peut être plus grand que l'écran émulé (894 contre 844 en CI).
    assert.ok(Math.abs(m.dockBottom - m.vh) <= 2, 'la saisie est collée au bas de la zone visible : ' + JSON.stringify({ dockBottom: m.dockBottom, visibleHeight: m.vh, innerHeight: m.ih, appH: m.appH, visualViewportH: m.vvH, bodyH: m.bodyH }));
    assert.equal(m.short, true); assert.equal(m.full, false);
    assert.match(await ev(`document.querySelector('.notice-short').innerText`), /non officiel.*non validées par un juriste.*seul le texte officiel \(PDF\) fait foi/s, 'la version courte garde l\'essentiel de la mise en garde');
    await ev(`document.getElementById('notice-more').click()`);
    await waitFor(`!document.getElementById('about-panel').hidden`, '« Texte complet » ouvre « À propos »');
    assert.match(await text('#about-panel'), /n'a pas été entraînée ni spécialisée sur ces textes/);
  } finally { await desktop(); }
});

test('téléphone : l\'historique est un tiroir fermé par défaut ; menu, Échap, voile ou choix d\'une question le gèrent', async () => {
  await phone();
  try {
    await fresh();
    await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
    const vis = () => ev(`getComputedStyle(document.getElementById('history')).visibility`);
    assert.equal(await vis(), 'hidden', 'tiroir fermé par défaut (hors de la navigation au clavier)');
    assert.equal(await ev(`Math.round(document.getElementById('btn-menu').getBoundingClientRect().width)`) >= 44, true, 'bouton menu assez grand pour le toucher');
    await ev(`document.getElementById('btn-menu').click()`);
    await waitFor(`getComputedStyle(document.getElementById('history')).visibility === 'visible'`, 'tiroir ouvert');
    assert.equal(await ev(`document.getElementById('btn-menu').getAttribute('aria-expanded')`), 'true');
    assert.equal(await ev(`document.getElementById('scrim').hidden`), false);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await waitFor(`getComputedStyle(document.getElementById('history')).visibility === 'hidden'`, 'fermeture par Échap');
    await ev(`document.getElementById('btn-menu').click()`); await waitFor(`getComputedStyle(document.getElementById('history')).visibility === 'visible'`, 'réouverture');
    await ev(`document.getElementById('scrim').click()`); await waitFor(`getComputedStyle(document.getElementById('history')).visibility === 'hidden'`, 'fermeture par le voile');
    await ev(`document.getElementById('btn-menu').click()`); await waitFor(`getComputedStyle(document.getElementById('history')).visibility === 'visible'`, 'réouverture');
    await ev(`document.querySelector('.hist-item').click()`);
    await waitFor(`getComputedStyle(document.getElementById('history')).visibility === 'hidden'`, 'fermeture au choix d\'une question');
    assert.equal(await ev(`document.getElementById('btn-menu').getAttribute('aria-expanded')`), 'false');
    assert.match(await text('#question-echo .q-text'), /plafond/);
  } finally { await desktop(); }
});

test('réponse prête : si un panneau recouvre la réponse à son arrivée, un message l\'annonce ; « Lire la réponse » l\'amène à l\'écran ; sinon aucun message', async () => {
  await fresh();
  await ask('plafond première');
  await ev(`document.getElementById('btn-about').click()`);
  await answeredQ('/première/'); await waitFor(`!document.getElementById('toast').hidden`, 'message « réponse prête »');
  assert.match(await text('#toast .toast-text'), /Votre réponse est prête/);
  await ev(`document.getElementById('toast-go').click()`);
  assert.equal(await ev(`document.getElementById('about-panel').hidden`), true, 'le panneau est refermé');
  assert.equal(await ev(`document.getElementById('toast').hidden`), true);
  assert.equal(await ev(`document.activeElement === document.getElementById('answer')`), true, 'le focus est sur la réponse (lecteurs d\'écran)');
  await ask('plafond seconde'); await answeredQ('/seconde/');
  assert.equal(await ev(`document.getElementById('toast').hidden`), true, 'la réponse est déjà à l\'écran : aucun message');
});

test('animations : à l\'arrivée la carte de réponse se révèle ; avec « mouvement réduit », rien ne bouge', async () => {
  const media = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: v }] });
  try {
    await media('no-preference'); await fresh();
    await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
    const names = await ev(`getComputedStyle(document.querySelector('.pane-answer')).animationName`);
    assert.match(names, /rise/); assert.match(names, /ready-glow/);
    await media('reduce'); await fresh();
    await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.pane-answer')).animationName`), 'none');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.question-echo')).animationName`), 'none');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.chip')).transitionDuration`), '0s', 'aucune transition non plus');
  } finally { await send('Emulation.setEmulatedMedia', { features: [] }); }
});

test('saisie : le champ grandit avec le texte (plafonné) puis revient à une ligne', async () => {
  await fresh();
  const h = () => ev(`Math.round(document.getElementById('question').getBoundingClientRect().height)`);
  const set = (v) => ev(`(() => { const t = document.getElementById('question'); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const h0 = await h();
  await set('une ligne\nune autre\net une troisième'); const h1 = await h();
  assert.ok(h1 > h0 + 30, `le champ grandit : ${h0} → ${h1}`);
  await set('ligne\n'.repeat(40)); const h2 = await h();
  assert.ok(h2 <= 176 && h2 > h1, `le champ est plafonné : ${h2}`);
  await set(''); assert.equal(await h(), h0, 'une ligne de nouveau');
});

test('très petit téléphone (320 px) : aucun défilement horizontal, saisie et envoi utilisables, noms accessibles pour chaque bouton', async () => {
  await phone(320, 640);
  try {
    await fresh();
    await ask('GROUPES plafond'); await waitFor(`document.querySelector('#answer .texts')`, 'réponse avec textes');
    const m = await ev(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, send: document.getElementById('btn-send').getBoundingClientRect().width, noName: [...document.querySelectorAll('button')].filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label') || b.title)).length })`);
    assert.ok(m.sw <= m.iw + 1, `défilement horizontal : ${m.sw} > ${m.iw}`);
    assert.ok(m.send >= 44, 'bouton d\'envoi assez grand : ' + m.send);
    assert.equal(m.noName, 0, 'tout bouton a un nom accessible');
  } finally { await desktop(); }
});

test('contraste (WCAG AA, 4,5:1) des textes principaux, en thème clair et en thème sombre', async () => {
  const media = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
  const measure = () => ev(`(() => {
    const parse = (s) => { const m = s.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const bg = (el) => { const chain = []; for (let n = el; n; n = n.parentElement) chain.push(parse(getComputedStyle(n).backgroundColor)); let c = { r: 255, g: 255, b: 255, a: 1 }; for (const x of chain.reverse()) c = over(x, c); return c; };
    const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (el) => { const fg = over(parse(getComputedStyle(el).color), bg(el)); const a = L(fg), b = L(bg(el)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const sels = ['.brand-title', '.brand-sub', '.badge-edu', '.notice-full', '#history-hint', '.conv-head', '.hist-item', '.pane-answer .pane-title', '#answer .ans-text', '#answer .tags .tag-neutral', '#answer .tags .tag-warn',
      '#answer .cite', '#answer .cited-list', '#answer .callout-warn', '#answer .ans-label', '#answer .disclaimer', '.pane-sources .pane-title', '.pane-sub', '#sources .src-ref', '#sources .src-title', '#sources .src-meta dt',
      '#sources .src-meta dd', '#sources .excerpt', '#sources .tag', '#sources .src-cited', '.persist-note', '.counter', '.footer', '.question-echo .q-text', '#btn-send', '.btn-link'];
    return sels.map((s) => { const el = document.querySelector(s); return el ? [s, Math.round(ratio(el) * 100) / 100] : [s, null]; });
  })()`);
  try {
    for (const theme of ['light', 'dark']) {
      await media(theme); await fresh();
      await ask('plafond'); await waitFor(`document.querySelector('#answer .ans-text')`, 'réponse');
      const rows = await measure();
      const missing = rows.filter(([, r]) => r === null).map(([s]) => s);
      assert.deepEqual(missing, [], theme + ' : éléments introuvables');
      const low = rows.filter(([s, r]) => r < 4.5 && s !== '#btn-send').map(([s, r]) => `${s}=${r}`);
      assert.deepEqual(low, [], theme + ' : contraste insuffisant (< 4,5:1)');
      const send_ = rows.find(([s]) => s === '#btn-send')[1]; assert.ok(send_ >= 3, theme + ' : bouton Envoyer (désactivé en fin de réponse) : ' + send_);
    }
  } finally { await send('Emulation.setEmulatedMedia', { features: [] }); }
});

test('aucune ressource externe : toutes les requêtes du navigateur visent l\'application, aucune violation CSP, aucune exception', async () => {
  const foreign = requests.filter((u) => !(u.startsWith(ORIGIN + '/') || (URL_OFF && u.startsWith(new URL(URL_OFF).origin + '/')) || (URL_PERSIST && u.startsWith(new URL(URL_PERSIST).origin + '/')) || u.startsWith('data:') || u === 'about:blank'));
  assert.deepEqual(foreign, [], 'requêtes hors application : ' + foreign.join(', '));
  assert.ok(requests.length > 20, 'les requêtes ont bien été observées (' + requests.length + ')');
  assert.deepEqual(B.violations, [], 'violations de la politique CSP');
  assert.deepEqual(B.exceptions, [], 'exceptions JavaScript non gérées');
});
