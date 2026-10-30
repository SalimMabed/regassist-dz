/* Quiz facultatif pendant l'attente : « Vous nous posez une question, nous avons bien le droit de vous en poser une aussi ! »
   5 questions tirées de la banque quiz-data.js (faits vérifiés dans les textes officiels du corpus, chacun avec sa source et le lien vers le PDF d'origine).
   Cette interface ne fait AUCUNE requête (ni modèle, ni serveur, ni service externe) : elle lit un fichier de données déjà chargé et ne garde, dans ce navigateur
   seulement, que le meilleur résultat et les identifiants des questions déjà vues. La logique (sélection, score) est dans quiz-logic.js. */
(() => {
  'use strict';

  const L = window.RegAssistQuizLogic;
  const NOTE = 'Quiz à vocation pédagogique. Les réponses sont fondées sur les documents référencés et ne constituent pas un avis juridique.';
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const TYPES = { 'règlement': 'Règlement', instruction: 'Instruction', note: 'Note', loi: 'Loi', ordonnance: 'Ordonnance', lignes_directrices: 'Lignes directrices' };
  const OFFICIAL = 'https://www.bank-of-algeria.dz/';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const button = (label, cls) => { const b = el('button', cls, label); b.type = 'button'; return b; };
  const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? Number(m[3]) + (m[3] === '01' ? 'er ' : ' ') + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : ''; };
  const score = (c, t) => c + ' sur ' + t;

  function sourceCard(s, limit) {
    const box = el('div', 'quiz-source');
    box.append(el('p', 'quiz-source-label', 'Source'));
    box.append(el('p', 'quiz-source-title', s.title));
    const app = s.type === 'application';                      // question sur l'assistant lui-même : la source est un texte de l'application, sans PDF ni page
    const ident = [(TYPES[s.type] || 'Texte') + (s.number ? ' n° ' + s.number : ''), fmtDate(s.date)].filter(Boolean).join(' du ');
    box.append(el('p', 'quiz-source-ref', app ? s.reference : ident + ' · ' + s.reference + ' · page ' + s.page + ' du PDF'));
    const q = el('blockquote', 'quiz-quote', '« ' + s.quote + ' »');
    box.append(q);
    if (!app && typeof s.url === 'string' && s.url.startsWith(OFFICIAL)) {
      const a = el('a', 'quiz-source-link', 'Ouvrir le document officiel (PDF, page ' + s.page + ')');
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      box.append(a);
    }
    if (limit) box.append(el('p', 'quiz-limit', 'À savoir : ' + limit));
    return box;
  }

  function mount(container, opts) {
    const o = opts || {};
    const onBack = o.onBack || (() => {});
    const onSwitch = o.onSwitch || null;
    const bank = o.data || (window.RegAssistQuizData && window.RegAssistQuizData.questions) || [];
    const rnd = o.random || Math.random;
    const storage = o.storage;
    container.replaceChildren();
    const root = el('div', 'quiz');
    const live = el('p', 'sr-only'); live.setAttribute('role', 'status');
    const screen = el('div', 'quiz-screen');
    root.append(live, screen); container.append(root);

    let items = [], picks = [], idx = 0, answered = false, view = 'intro', record = false, dead = false;
    const say = (t) => { live.textContent = ''; setTimeout(() => { if (!dead) live.textContent = t; }, 30); };       // relance l'annonce même si le texte est identique

    function frame(titleText) {
      screen.replaceChildren();
      const card = el('div', 'quiz-card quiz-enter');
      const h = el('h3', 'quiz-title', titleText); h.tabIndex = -1;
      card.append(h); screen.append(card);
      return { card, h };
    }
    function footer(card, withSwitch) {
      const row = el('div', 'quiz-actions');
      return { row, finish: () => { if (withSwitch && onSwitch) { const g = button('Choisir le mini-jeu', 'btn btn-ghost'); g.addEventListener('click', onSwitch); row.append(g); } const b = button('Retour au suivi', 'btn btn-link'); b.addEventListener('click', onBack); row.append(b); card.append(row, el('p', 'quiz-note', NOTE)); } };
    }

    function intro() {
      view = 'intro';
      const { card } = frame('Vous nous posez une question, nous avons bien le droit de vous en poser une aussi !');
      if (!bank.length) {
        card.append(el('p', 'quiz-sub', 'Le quiz n\'est pas disponible pour le moment. Votre question suit son cours.'));
        const f = footer(card, true); f.finish(); return;
      }
      card.append(el('p', 'quiz-sub', 'En attendant notre réponse, testez vos connaissances sur les textes et la réglementation de la Banque d\'Algérie.'));
      card.append(el('p', 'quiz-meta', Math.min(L.SESSION_SIZE, bank.length) + ' questions, sans chronomètre. Chaque réponse est expliquée et renvoie au texte officiel.'));
      const best = L.loadBest(storage);
      if (best) card.append(el('p', 'quiz-meta quiz-best', 'Votre meilleur résultat : ' + score(best.correct, best.total) + '.'));
      const go = button('Relever le défi', 'btn btn-primary'); go.addEventListener('click', start);
      const f = footer(card, true); f.row.append(go); f.finish();
    }

    function start() {
      items = L.pickSession(bank, { random: rnd, seen: L.loadSeen(storage) });
      L.saveSeen(items.map((it) => it.question.id), storage);
      picks = []; idx = 0; record = false;
      question();
    }

    function question() {
      view = 'question'; answered = false;
      const it = items[idx]; const q = it.question; const n = items.length;
      const { card, h } = frame(q.question);
      h.className = 'quiz-title quiz-question'; h.id = 'quiz-q-' + idx;
      const prog = el('div', 'quiz-progress'); prog.setAttribute('role', 'progressbar');
      prog.setAttribute('aria-label', 'Progression du quiz'); prog.setAttribute('aria-valuemin', '1'); prog.setAttribute('aria-valuemax', String(n)); prog.setAttribute('aria-valuenow', String(idx + 1));
      prog.setAttribute('aria-valuetext', 'Question ' + (idx + 1) + ' sur ' + n);
      for (let i = 0; i < n; i++) prog.append(el('span', 'quiz-seg' + (i < idx ? ' is-done' : i === idx ? ' is-current' : '')));
      card.prepend(el('p', 'quiz-step', 'Question ' + (idx + 1) + ' sur ' + n)); card.prepend(prog);
      const group = el('div', 'quiz-choices'); group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', h.id);
      const buttons = it.order.map((orig, pos) => {
        const b = button('', 'quiz-choice'); b.append(el('span', 'quiz-letter', 'ABCD'[pos]), el('span', 'quiz-choice-text', q.choices[orig]), el('span', 'quiz-choice-status'));
        b.getElementsByClassName('quiz-letter')[0].setAttribute('aria-hidden', 'true');
        b.addEventListener('click', () => choose(pos));
        group.append(b); return b;
      });
      const fb = el('div', 'quiz-feedback'); fb.hidden = true;
      const next = button(idx + 1 < n ? 'Question suivante' : 'Voir mon résultat', 'btn btn-primary'); next.hidden = true;
      next.addEventListener('click', () => { if (idx + 1 < n) { idx += 1; question(); } else result(); });
      card.append(group, fb);
      const f = footer(card, false); f.row.append(next); f.finish();
      ui = { buttons, fb, next };
      h.focus({ preventScroll: true });
      say('Question ' + (idx + 1) + ' sur ' + n + '. ' + q.question);
    }

    let ui = null;
    function choose(pos) {
      if (answered || view !== 'question') return;
      answered = true; picks[idx] = pos;
      const it = items[idx]; const q = it.question; const ok = pos === it.correct;
      ui.buttons.forEach((b, j) => {
        b.setAttribute('aria-disabled', 'true'); b.classList.add('is-locked');
        const st = b.getElementsByClassName('quiz-choice-status')[0];
        if (j === it.correct) { b.classList.add('is-correct'); st.textContent = j === pos ? 'Bonne réponse, c\'est la vôtre' : 'Bonne réponse'; }
        else if (j === pos) { b.classList.add('is-wrong'); st.textContent = 'Votre réponse : incorrecte'; }
      });
      const good = q.choices[q.answer];
      ui.fb.replaceChildren(
        el('p', 'quiz-verdict ' + (ok ? 'is-correct' : 'is-wrong'), ok ? 'Bonne réponse !' : 'Réponse incorrecte. La bonne réponse était : ' + good),
        el('p', 'quiz-explain', q.explanation), sourceCard(q.source, q.limit));
      ui.fb.hidden = false; ui.next.hidden = false;
      say((ok ? 'Bonne réponse. ' : 'Réponse incorrecte. La bonne réponse était : ' + good + '. ') + q.explanation);
    }

    function result() {
      view = 'result';
      const s = L.summarize(items, picks);
      record = L.saveBest(s.correct, s.total, storage);
      const best = L.loadBest(storage); const msg = L.message(s.correct, s.total);
      const { card, h } = frame('Quiz terminé');
      card.append(el('p', 'quiz-score', score(s.correct, s.total)), el('p', 'quiz-message', msg));
      const facts = el('ul', 'quiz-facts');
      facts.append(el('li', null, 'Bonnes réponses : ' + s.correct), el('li', null, 'Questions répondues : ' + s.answered + ' sur ' + s.total));
      if (best) facts.append(el('li', null, 'Meilleur résultat : ' + score(best.correct, best.total) + (record ? ' (nouveau meilleur résultat)' : '')));
      card.append(facts);
      const again = button('Recommencer', 'btn btn-primary'); again.addEventListener('click', start);
      const f = footer(card, true); f.row.prepend(again); f.finish();
      h.focus({ preventScroll: true });
      say('Quiz terminé. Score : ' + score(s.correct, s.total) + '. ' + msg);
    }

    intro();
    return { destroy() { dead = true; container.replaceChildren(); }, get view() { return view; } };
  }

  window.RegAssistQuiz = { mount };
})();
