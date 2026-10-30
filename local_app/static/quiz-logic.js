/* Quiz d'attente : logique pure (sélection des questions, score, messages, meilleur résultat). Aucun accès au DOM ni au réseau : testable seul sous Node.
   Les questions viennent du fichier de données quiz-data.js (généré à partir du corpus) ; l'interface est dans quiz.js. */
(() => {
  'use strict';

  const SESSION_SIZE = 5;
  const BEST_KEY = 'regassist.quiz.best.v1';
  const SEEN_KEY = 'regassist.quiz.seen.v1';
  const SEEN_MAX = 200;
  const CAP = { contenu: 3 };                      // au plus 3 questions « article » par série, 2 de tout autre type : une série variée
  const DEFAULT_CAP = 2;

  const shuffle = (a, rnd) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

  /* Série de questions : jamais deux fois le même texte, types variés, au moins une question sur le contenu d'un article, questions encore jamais vues d'abord.
     Chaque élément garde la question d'origine et l'ordre (mélangé) de ses réponses : `correct` est la position de la bonne réponse à l'écran. */
  function pickSession(questions, opts) {
    const o = opts || {}; const rnd = o.random || Math.random; const size = o.size || SESSION_SIZE; const seen = new Set(o.seen || []);
    const fresh = shuffle(questions.filter((q) => !seen.has(q.id)), rnd); const old = shuffle(questions.filter((q) => seen.has(q.id)), rnd);
    const pool = fresh.concat(old);
    const chosen = [];
    const take = (relaxDocs, relaxKinds) => {
      for (const q of pool) {
        if (chosen.length >= size) return;
        if (chosen.includes(q)) continue;
        if (!relaxDocs && chosen.some((c) => c.source.document_id === q.source.document_id)) continue;
        if (!relaxKinds && chosen.filter((c) => c.kind === q.kind).length >= (CAP[q.kind] || DEFAULT_CAP)) continue;
        chosen.push(q);
      }
    };
    const article = pool.find((q) => q.kind === 'contenu');                      // une question sur le contenu d'un article au moins, si la banque en a
    const assistant = pool.find((q) => q.kind === 'assistant');                  // et, dans les séries d'au moins 4 questions, une sur l'assistant lui-même (IA, limites, valeur juridique)
    if (size >= 3 && article) chosen.push(article);
    if (size >= 4 && assistant) chosen.push(assistant);
    take(false, false); take(false, true); take(true, true);
    return shuffle(chosen, rnd).map((q) => {
      const order = shuffle(q.choices.map((_, i) => i), rnd);
      return { question: q, order, correct: order.indexOf(q.answer) };
    });
  }

  function summarize(items, picks) {               // picks[i] = position choisie à l'écran, ou undefined si la question n'a pas été répondue
    let correct = 0; let answered = 0;
    items.forEach((it, i) => { if (picks[i] !== undefined && picks[i] !== null) { answered += 1; if (picks[i] === it.correct) correct += 1; } });
    return { correct, answered, total: items.length };
  }

  function message(correct, total) {
    const r = total ? correct / total : 0;
    if (r === 1) return 'Impressionnant ! Vous connaissez vos textes sur le bout des doigts.';
    if (r >= 0.8) return 'Très bon résultat !';
    if (r >= 0.6) return 'Pas mal ! Il reste quelques textes à découvrir.';
    if (r > 0) return 'L\'essentiel, c\'est d\'apprendre quelque chose !';
    return 'On vous a peut-être posé des questions trop difficiles cette fois-ci.';
  }

  /* Stockage local au navigateur uniquement (facultatif : le quiz fonctionne sans). Rien n'est jamais envoyé au serveur. */
  const store = (s) => { if (s) return s; try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } };
  function loadBest(storage) {
    try { const b = JSON.parse(store(storage).getItem(BEST_KEY) || 'null'); return b && b.total > 0 && b.correct >= 0 && b.correct <= b.total ? { correct: b.correct, total: b.total } : null; } catch (e) { return null; }
  }
  function saveBest(correct, total, storage) {     // renvoie true s'il s'agit d'un nouveau meilleur résultat
    const prev = loadBest(storage);
    if (prev && correct / total <= prev.correct / prev.total) return false;
    try { store(storage).setItem(BEST_KEY, JSON.stringify({ correct, total })); } catch (e) { /* stockage indisponible : le quiz fonctionne sans */ }
    return true;
  }
  function loadSeen(storage) {
    try { const a = JSON.parse(store(storage).getItem(SEEN_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(-SEEN_MAX) : []; } catch (e) { return []; }
  }
  function saveSeen(ids, storage) {
    const prev = loadSeen(storage); const all = prev.concat(ids.filter((i) => !prev.includes(i))).slice(-SEEN_MAX);
    try { store(storage).setItem(SEEN_KEY, JSON.stringify(all)); } catch (e) { /* idem */ }
  }

  const api = { SESSION_SIZE, pickSession, summarize, message, loadBest, saveBest, loadSeen, saveSeen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.RegAssistQuizLogic = api;
})();
