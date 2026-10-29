/* Mini-jeu facultatif pendant l'attente : mémoire de paires (6 paires de formes neutres, 12 cartes).
   Choisi parmi trois pistes (mémoire, séquence à reproduire, réflexes) parce qu'il se lit sans son ni couleur, se joue au clavier comme au toucher, ne demande aucune
   rapidité (adapté à un outil juridique sérieux) et dure environ une minute. Il ne fait aucune requête et ne touche ni à la question ni à sa réponse : il vit
   dans son propre cadre et se détruit avec lui. Seul le meilleur résultat est gardé dans ce navigateur (localStorage, facultatif). */
(() => {
  'use strict';

  const SHAPES = [['■', 'carré'], ['●', 'disque'], ['▲', 'triangle'], ['◆', 'losange'], ['▼', 'triangle inversé'], ['○', 'cercle']];
  const COLS = 4;
  const BEST_KEY = 'regassist.game.best.v1';
  const HIDE_DELAY_MS = 900;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const shuffle = (a, rnd) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const fmt = (s) => (s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s');
  const loadBest = () => { try { const b = JSON.parse(localStorage.getItem(BEST_KEY) || 'null'); return b && b.moves > 0 ? b : null; } catch (e) { return null; } };
  const saveBest = (b) => { try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch (e) { /* stockage indisponible : le jeu fonctionne sans */ } };
  const better = (a, b) => !b || a.moves < b.moves || (a.moves === b.moves && a.secs < b.secs);

  function mount(container, opts) {
    const onBack = (opts && opts.onBack) || (() => {});
    const rnd = (opts && opts.random) || Math.random;
    container.replaceChildren();
    const root = el('div', 'game');
    const head = el('div', 'game-head'); head.append(el('strong', null, 'Mémoire'), el('span', 'game-help', 'Retrouvez les 6 paires. Souris, toucher, ou clavier : flèches pour choisir une carte, Entrée pour la retourner.'));
    const stats = el('p', 'game-stats');
    const grid = el('div', 'game-grid'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Cartes du jeu de mémoire');
    const result = el('p', 'game-result'); result.setAttribute('role', 'status');
    const actions = el('div', 'game-actions');
    const again = el('button', 'btn btn-ghost', 'Rejouer'); again.type = 'button';
    const back = el('button', 'btn btn-ghost', 'Retour au suivi'); back.type = 'button';
    actions.append(again, back); root.append(head, stats, grid, result, actions); container.append(root);

    let cards, first, second, lock, moves, found, t0, timer, hideTimer, dead = false;

    const label = (c, i) => {
      if (c.matched) return 'Carte ' + (i + 1) + ' : ' + SHAPES[c.sym][1] + ', paire trouvée';
      return c.open ? 'Carte ' + (i + 1) + ' : ' + SHAPES[c.sym][1] : 'Carte ' + (i + 1) + ' sur ' + SHAPES.length * 2 + ', face cachée';
    };
    const paint = (c, i) => {
      c.btn.textContent = c.open || c.matched ? SHAPES[c.sym][0] : '';
      c.btn.classList.toggle('is-open', c.open && !c.matched);
      c.btn.classList.toggle('is-matched', c.matched);
      c.btn.setAttribute('aria-label', label(c, i));
      c.btn.setAttribute('aria-disabled', c.matched ? 'true' : 'false');
    };
    const renderStats = () => {
      const best = loadBest(); const secs = t0 ? Math.round((Date.now() - t0) / 1000) : 0;
      stats.textContent = 'Coups : ' + moves + ' · Temps : ' + fmt(secs) + ' · Meilleur résultat : ' + (best ? best.moves + ' coups en ' + fmt(best.secs) : 'aucun');
    };
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

    function focusCard(i) {
      const n = cards.length; const k = Math.max(0, Math.min(n - 1, i));
      cards.forEach((c, j) => { c.btn.tabIndex = j === k ? 0 : -1; });
      cards[k].btn.focus();
    }

    function flip(i) {
      const c = cards[i];
      if (dead || lock || c.open || c.matched) return;
      if (!t0) { t0 = Date.now(); timer = setInterval(renderStats, 1000); }
      c.open = true; paint(c, i);
      if (first === null) { first = i; return; }
      second = i; moves += 1; renderStats();
      if (cards[first].sym === c.sym) {
        cards[first].matched = c.matched = true; cards[first].open = c.open = false;
        paint(cards[first], first); paint(c, i); first = second = null; found += 1;
        if (found === SHAPES.length) win();
      } else {
        lock = true;
        hideTimer = setTimeout(() => {
          const a = first, b = second; cards[a].open = cards[b].open = false; paint(cards[a], a); paint(cards[b], b);
          first = second = null; lock = false;
        }, HIDE_DELAY_MS);
      }
    }

    function win() {
      stopTimer();
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000)); const now = { moves, secs }; const prev = loadBest();
      const record = better(now, prev); if (record) saveBest(now);
      renderStats();
      result.textContent = 'Terminé en ' + moves + ' coups et ' + fmt(secs) + (record ? ' : nouveau meilleur résultat.' : '.');
      again.focus();
    }

    function start() {
      stopTimer(); if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      grid.replaceChildren(); result.textContent = '';
      first = second = null; lock = false; moves = 0; found = 0; t0 = 0;
      const syms = shuffle(SHAPES.concat(SHAPES).map((_, i) => i % SHAPES.length), rnd);
      cards = syms.map((sym, i) => {
        const btn = el('button', 'game-card'); btn.type = 'button'; btn.dataset.sym = String(sym);
        const c = { sym, btn, open: false, matched: false };
        btn.tabIndex = i === 0 ? 0 : -1;
        btn.addEventListener('click', () => flip(i));
        btn.addEventListener('focus', () => { cards.forEach((o, j) => { o.btn.tabIndex = j === i ? 0 : -1; }); });
        btn.addEventListener('keydown', (ev) => {
          const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[ev.key];
          if (move !== undefined) { ev.preventDefault(); focusCard(i + move); }
          else if (ev.key === 'Home') { ev.preventDefault(); focusCard(0); }
          else if (ev.key === 'End') { ev.preventDefault(); focusCard(cards.length - 1); }
        });
        grid.append(btn); paint(c, i);
        return c;
      });
      renderStats();
    }

    again.addEventListener('click', () => { start(); focusCard(0); });
    back.addEventListener('click', onBack);
    start();
    return { destroy() { dead = true; stopTimer(); if (hideTimer) clearTimeout(hideTimer); container.replaceChildren(); } };
  }

  window.RegAssistGame = { mount };
})();
