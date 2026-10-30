/* Interface de l'assistant juridique (projet éducatif non officiel). Aucune dépendance, aucune ressource externe.
   Tout texte venant de l'API (donc des textes officiels) est inséré avec textContent, jamais interprété comme du HTML.
   L'interface ne montre aucun détail technique (modèle, moteur de recherche, durées, identifiants internes) : seulement ce qui sert à lire et vérifier une réponse. */
(() => {
  'use strict';

  const STORE_KEY = 'regassist.history.v1';
  const MAX_CONVS = 30;
  const MAX_ENTRIES = 150;
  const POLL_MS = 20000;
  const TIMEOUT_MS = 270000; // 270 s : marge supérieure aux 240 s d'amont (Nginx proxy_read_timeout et Gunicorn --timeout)
  const QUEUE_POLL_MS = 2000;
  const QUEUE_POLL_HIDDEN_MS = 10000;                  // onglet en arrière-plan : on ménage le serveur et la batterie
  const DEFAULT_MAX_Q = 500;
  const UNAVAILABLE = 'Le service de rédaction des réponses est momentanément indisponible.';

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  // Libellés du statut juridique calculé à partir des textes (jamais « en vigueur » : le site officiel ne publie pas de statut de vigueur).
  const LEGAL = {
    ACTIVE: ['Dernière version connue', 'neutral'],
    MODIFIED: ['Modifié ultérieurement', 'warn'],
    REPLACED: ['Remplacé (version antérieure)', 'danger'],
    ABROGATED: ["Abrogé d'après les textes", 'danger'],
    HISTORICAL: ["Valeur d'une période échue", 'warn'],
    UNKNOWN: ['Vigueur non déterminée', 'warn'],
  };

  const state = { status: null, reachable: false, checked: false, busy: false, conv: null, convs: [], entry: null, storageOk: true, timer: null, maxQ: DEFAULT_MAX_Q };

  /* ---------- utilitaires ---------- */
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const plain = (s) => String(s || '').replace(/\s*\[règle[^\]]*\]/g, '');          // retire la mention de règle interne éventuelle
  // L'IA recopie parfois les codes internes du statut (« son statut est ACTIVE ») : affichés avec le même libellé que dans les cartes de sources.
  const humanize = (s) => String(s || '').replace(/\b(ACTIVE|MODIFIED|REPLACED|ABROGATED|HISTORICAL|UNKNOWN)\b/g, (m) => LEGAL[m][0].charAt(0).toLowerCase() + LEGAL[m][0].slice(1));
  const fmtDate = (iso) => {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || null;
    const d = new Date(iso + 'T00:00:00Z');
    return isNaN(d) ? iso : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  };
  const fmtWhen = (ts) => new Date(ts).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* ---------- historique (localStorage : reste dans ce navigateur) ---------- */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      state.convs = data && Array.isArray(data.convs) ? data.convs : [];
    } catch (e) { state.convs = []; state.storageOk = false; }
  }
  function saveHistory() {
    const trim = () => {
      state.convs = state.convs.slice(-MAX_CONVS);
      let total = state.convs.reduce((n, c) => n + c.entries.length, 0);
      while (total > MAX_ENTRIES && state.convs.length > 1) { total -= state.convs[0].entries.length; state.convs.shift(); }
    };
    trim();
    for (let attempt = 0; attempt < 3; attempt++) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, convs: state.convs })); state.storageOk = true; return; }
      catch (e) { state.storageOk = false; if (state.convs.length > 1) state.convs.shift(); else break; }
    }
    renderHistory();
  }
  function clearHistory() {
    state.convs = []; state.conv = null; state.entry = null;
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* stockage indisponible : l'historique en mémoire est vidé */ }
    renderHistory(); resetWorkspace();
  }

  function renderHistory() {
    const box = $('history-list'); box.replaceChildren();
    const convs = state.convs.filter((c) => c.entries.length);
    if (!convs.length) box.append(el('p', 'history-empty', 'Aucune question pour le moment.'));
    for (const c of convs.slice().reverse()) {
      box.append(el('div', 'conv-head', 'Conversation du ' + fmtWhen(c.at)));
      for (const en of c.entries.slice().reverse()) {
        const b = el('button', 'hist-item', en.q);
        b.type = 'button'; b.title = en.q; b.dataset.entry = en.id;
        if (state.entry === en.id) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => openEntry(c.id, en.id));
        box.append(b);
      }
    }
    $('history-hint').textContent = state.storageOk
      ? 'Votre historique est enregistré uniquement dans ce navigateur. Chaque question est traitée indépendamment des précédentes.'
      : "Le stockage du navigateur est indisponible : l'historique ne sera pas conservé à la fermeture de la page.";
  }

  function openEntry(convId, entryId) {
    if (state.busy) return;                                  // une question est en cours : ne pas écraser l'affichage du traitement
    const c = state.convs.find((x) => x.id === convId); const en = c && c.entries.find((x) => x.id === entryId);
    if (!en) return;
    toggleHistory(false);
    state.conv = c; state.entry = en.id;
    showQuestion(en.q, 'Réponse enregistrée le ' + fmtWhen(en.at) + ' (historique de ce navigateur) : elle n\'est pas recalculée. Reposez la question pour obtenir une réponse à jour.');
    renderResponse(en.r);
    const note = serverNote(en); if (note) $('answer').append(note);
    renderHistory();
  }

  function newConversation() {
    if (state.busy) return;
    toggleHistory(false);
    state.conv = null; state.entry = null;
    resetWorkspace(); renderHistory(); $('question').focus();
  }

  /* ---------- gabarit : état vide, défilement, tiroir de l'historique, signal « réponse prête » ---------- */
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const setEmpty = (on) => $('workspace').classList.toggle('is-empty', on);
  const scrollToTop = () => { const s = $('scroll'); if (s) s.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); };

  function skeleton(cards) {                         // lignes d'attente décoratives (masquées aux lecteurs d'écran)
    const d = el('div', 'skeleton' + (cards ? ' skeleton-cards' : '')); d.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < (cards ? 2 : 4); i++) d.append(document.createElement('i'));
    return d;
  }

  function toggleHistory(open) {                     // tiroir de l'historique (écrans étroits ; sans effet visible sur grand écran)
    if (document.body.classList.contains('history-open') === open) return;
    document.body.classList.toggle('history-open', open);
    $('scrim').hidden = !open; $('btn-menu').setAttribute('aria-expanded', String(open));
    if (open) $('btn-new').focus(); else if (document.activeElement && $('history').contains(document.activeElement)) $('btn-menu').focus();
  }

  let toastTimer = null;
  function hideToast() { clearTimeout(toastTimer); $('toast').hidden = true; }
  function showToast() { $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 15000); }
  function readAnswer() {                            // « Lire la réponse » : referme les panneaux ouverts et amène la réponse à l'écran
    hideToast(); toggleHistory(false); if (!$('about-panel').hidden) toggleAbout(false);
    const a = $('answer'); a.tabIndex = -1;
    a.closest('.pane').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }); a.focus({ preventScroll: true });
  }
  // La réponse vient d'arriver : légère mise en valeur de la carte, et un message si elle n'est pas visible (panneau ouvert, zone défilée).
  function markReady() {
    const pane = $('answer').closest('.pane');
    pane.classList.remove('is-new'); void pane.offsetWidth; pane.classList.add('is-new');
    setTimeout(() => pane.classList.remove('is-new'), 2600);
    const r = pane.getBoundingClientRect();
    const covered = !$('about-panel').hidden || document.body.classList.contains('history-open');
    if (covered || r.bottom < 80 || r.top > window.innerHeight * 0.85) showToast();
  }

  function autosize() {                              // le champ de saisie grandit avec le texte (plafonné)
    const t = $('question'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 168) + 'px';
  }

  function trackViewport() {                         // hauteur réellement visible : le clavier tactile ne masque plus la saisie
    const vv = window.visualViewport; if (!vv) return;
    const root = document.documentElement.style;
    const apply = () => { if (vv.scale <= 1.02) root.setProperty('--app-h', Math.round(vv.height) + 'px'); };
    vv.addEventListener('resize', apply); apply();
  }

  /* ---------- rendu ---------- */
  function resetWorkspace() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    hideToast(); setEmpty(true);
    $('question-echo').hidden = true; $('answer').removeAttribute('aria-busy');
    $('sources').replaceChildren(el('p', 'placeholder', 'Les textes officiels retrouvés apparaîtront ici, avec leurs extraits.'));
    $('answer').replaceChildren(el('p', 'placeholder', 'Posez une question en bas de page. La réponse n\'est affichée qu\'accompagnée de ses sources.'));
  }

  function showQuestion(q, savedNote) {
    const box = $('question-echo'); box.replaceChildren(el('div', 'q-label', 'Question'), el('div', 'q-text', q));
    if (savedNote) box.append(el('div', 'q-saved', savedNote));
    box.hidden = false; hideToast(); setEmpty(false); scrollToTop();
  }

  function tag(text, kind) { return el('span', 'tag' + (kind ? ' tag-' + kind : ''), text); }

  function links(doc) {
    const l = el('div', 'src-links');
    for (const [label, u] of [['PDF officiel', doc.document_url], ['Page du site', doc.source_url]]) {
      const url = safeUrl(u); if (!url) continue;
      const a = el('a', null, label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (label === 'PDF officiel' && doc.page) {
        a.title = 'Ouvrir le PDF officiel (Page ' + doc.page + ')';
      }
      l.append(a);
    }
    return l;
  }

  function sourceCard(c, cited) {
    const card = el('article', 'source' + (cited ? ' cited' : '')); card.id = 'src-' + c.id;
    const head = el('div', 'src-head', null);
    head.append(el('span', 'src-id', c.id), el('span', 'src-ref', c.texte || 'Texte sans référence'));
    if (cited) head.append(el('span', 'src-cited', 'Cité dans la réponse'));
    card.append(head);
    if (c.titre) card.append(el('div', 'src-title', c.titre));

    const meta = el('dl', 'src-meta');
    const add = (k, v) => { if (v) { meta.append(el('dt', null, k), el('dd', null, v)); } };
    add('Type de texte', cap(c.type));
    add('Date', fmtDate(c.date));
    add('Article', c.emplacement);
    add('Page', c.page ? 'p. ' + c.page + (c.page_fin && c.page_fin !== c.page ? '–' + c.page_fin : '') + ' du PDF' : null);
    add('Rubrique', [c.chapitre, c.section].filter(Boolean).join(' > '));
    if (meta.children.length) card.append(meta);

    const tags = el('div', 'tags');
    const lg = LEGAL[c.statut_juridique];
    if (lg) { const t = tag('Statut juridique : ' + lg[0], lg[1]); if (c.statut_detail) t.title = plain(c.statut_detail); tags.append(t); }
    if (c.statut) tags.append(tag('Statut du texte : ' + c.statut));
    if (c.a_verifier) tags.append(tag('Document signalé à vérifier', 'warn'));
    if (c.extraction === 'ocr' || c.extraction === 'mixed') tags.append(tag('Texte numérisé (reconnaissance automatique)', 'warn'));
    if (c.ocr_uncertain) tags.append(tag('Valeur numérique à vérifier dans le PDF', 'danger'));
    if (tags.children.length) card.append(tags);

    if (c.alerte) card.append(el('div', 'src-alert', c.alerte));
    if (c.via) card.append(el('div', 'rel', '↳ Texte qui ' + c.via));
    for (const [k, v] of Object.entries(c.relations || {})) card.append(el('div', 'rel', k + ' : ' + (Array.isArray(v) ? v.join(' ; ') : v)));

    const exLabel = el('div', 'excerpt-label', 'Passage extrait du document officiel');
    card.append(exLabel);
    const ex = el('div', 'excerpt', c.extrait || ''); ex.setAttribute('role', 'document');
    card.append(ex);
    if ((c.extrait || '').length > 450) {
      const tg = el('button', 'link-btn', "Afficher tout l'extrait"); tg.type = 'button';
      tg.addEventListener('click', () => { const on = ex.classList.toggle('expanded'); tg.textContent = on ? "Réduire l'extrait" : "Afficher tout l'extrait"; });
      card.append(tg);
    }
    const l = links(c); if (l.children.length) card.append(l);
    return card;
  }

  function focusSource(id) {
    const n = document.getElementById('src-' + id); if (!n) return;
    n.scrollIntoView({ block: 'nearest' }); n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1600);
  }

  function withCitations(parent, text, known) {
    for (const part of String(text || '').split(/(\[S\d+\])/)) {
      const m = /^\[(S\d+)\]$/.exec(part);
      if (m && known.has(m[1])) { const b = el('button', 'cite', part); b.type = 'button'; b.title = 'Aller à la source ' + m[1]; b.addEventListener('click', () => focusSource(m[1])); parent.append(b); }
      else if (part) parent.append(document.createTextNode(part));
    }
  }

  function renderSources(r) {
    const box = $('sources'); box.replaceChildren();
    const list = r.sources || [];
    const cited = new Set(r.status === 'answered' ? (r.citations || []).map((c) => c.id) : []);
    if (!list.length) { box.append(el('p', 'placeholder', r.status === 'clarification' ? 'Aucune source : la question doit d\'abord être précisée.' : r.status === 'smalltalk' ? 'Aucune source : ce message n\'est pas une question sur un texte réglementaire.' : 'Aucune source retenue pour cette question.')); return; }
    const sub = {
      answered: list.length + ' passage(s) utilisé(s) pour la réponse ; ceux qu\'elle cite sont signalés. Extraits reproduits tels quels.',
      refused: list.length + ' passage(s) examiné(s) : aucun n\'a permis d\'établir une réponse. Ils ne constituent pas une réponse.',
      llm_unavailable: list.length + ' passage(s) retrouvé(s). Aucune réponse n\'a été rédigée : ils ne constituent pas une réponse.',
    }[r.status] || (list.length + ' passage(s).');
    box.append(el('p', 'pane-sub', sub));
    for (const c of list) box.append(sourceCard(c, cited.has(c.id)));
  }

  function callout(kind, title, text, items) {
    const d = el('div', 'callout callout-' + kind);
    if (title) d.append(el('h3', null, title));
    if (text) d.append(el('p', null, text));
    if (items && items.length) { const ul = el('ul'); for (const n of items) ul.append(el('li', null, n)); d.append(ul); }
    return d;
  }

  // Un texte décrit avec ses seules métadonnées (rien n'est généré) : intitulé officiel, type, date, passages retrouvés, statut juridique, relations, liens.
  function textItem(t) {
    const li = el('li', 'text-item');
    // L'intitulé officiel commence presque toujours par la référence (« Instruction n°07-2026 du 13 juillet 2026 relative au… ») : une seule ligne, référence en gras
    // (comparaison sans espaces ni casse : « n° 07-2026 » = « n°07-2026 »). Sinon : référence puis intitulé sur deux lignes.
    const head = el('div', 'text-ref'); const ti = t.titre || ''; const compact = (s) => s.replace(/\s+/g, '').toLowerCase(); const want = compact(t.reference || '');
    let cut = -1; if (want && ti) { for (let i = 1; i <= ti.length; i++) { if (compact(ti.slice(0, i)) === want) { cut = i; break; } } }
    if (cut > 0) { head.append(el('strong', null, ti.slice(0, cut)), document.createTextNode(ti.slice(cut))); li.append(head); }
    else { head.append(el('strong', null, t.reference || 'Texte sans référence')); li.append(head); if (ti) li.append(el('div', 'text-title', ti)); }
    const meta = el('dl', 'src-meta');
    if (t.type) meta.append(el('dt', null, 'Type de texte'), el('dd', null, cap(t.type)));
    if (t.date) meta.append(el('dt', null, 'Date'), el('dd', null, fmtDate(t.date)));
    if ((t.passages || []).length) {
      const dd = el('dd');
      t.passages.forEach((p, i) => {
        if (i) dd.append(document.createTextNode(' '));
        const b = el('button', 'cite', (p.emplacement ? p.emplacement + ' ' : 'Passage ') + '(' + p.id + ')');
        b.type = 'button'; b.title = 'Voir ce passage dans les sources'; b.addEventListener('click', () => focusSource(p.id)); dd.append(b);
      });
      meta.append(el('dt', null, 'Passages retrouvés'), dd);
    }
    li.append(meta);
    const tags = el('div', 'tags'); const lg = LEGAL[t.statut_juridique];
    if (lg) { const g = tag('Statut juridique : ' + lg[0], lg[1]); if (t.statut_detail) g.title = plain(t.statut_detail); tags.append(g); }
    if (t.statut) tags.append(tag('Statut du texte : ' + t.statut));
    if (tags.children.length) li.append(tags);
    if (t.alerte) li.append(el('div', 'src-alert', t.alerte));
    for (const [k, v] of Object.entries(t.relations || {})) li.append(el('div', 'rel', k + ' : ' + (Array.isArray(v) ? v.join(' ; ') : v)));
    const l = links(t); if (l.children.length) li.append(l);
    return li;
  }

  // « Je ne peux pas répondre directement, mais voici quelques textes… » : phrase fournie par l'API, puis la liste des textes décrits.
  function textsBlock(r) {
    const frag = document.createDocumentFragment();
    frag.append(callout('info', r.texts_intro, 'Ce sont les textes qui se rapprochent le plus de votre question d\'après la recherche. Ils ne constituent pas une réponse et ne contiennent pas nécessairement l\'information recherchée : vérifiez dans le texte officiel.'));
    const ol = el('ol', 'texts'); for (const t of r.texts) ol.append(textItem(t)); frag.append(ol);
    return frag;
  }

  function renderAnswer(r) {
    const box = $('answer'); box.replaceChildren(); box.removeAttribute('aria-busy');
    const notes = r.notes || [];
    const hasTexts = Array.isArray(r.texts) && r.texts.length > 0 && !!r.texts_intro;      // absent des anciennes réponses de l'historique : ancien affichage
    if (r.status === 'answered') {
      // La réponse d'abord : une pastille rappelle d'emblée qu'elle est rédigée par une IA ; la mention complète suit la réponse, dans la même carte.
      const tg = el('div', 'tags'); tg.append(tag('Rédigée par une IA : à vérifier', 'neutral'));
      if (notes.length) tg.append(tag(notes.length + ' avertissement(s) à lire sous la réponse', 'warn'));
      box.append(tg);
      const ids = new Set((r.sources || []).map((s) => s.id));
      const t = el('div', 'ans-text'); withCitations(t, humanize(r.answer), ids); box.append(t);
      const cites = (r.citations || []).map((c) => c.id);
      if (cites.length) { const l = el('div', 'cited-list', 'Sources citées : '); cites.forEach((id, i) => { if (i) l.append(document.createTextNode(' ')); withCitations(l, '[' + id + ']', ids); }); box.append(l); }
      if (notes.length) { const w = callout('warn', 'À vérifier avant tout usage', null, notes.map(plain)); w.classList.add('callout-after'); box.append(w); }
      box.append(el('p', 'ans-label', 'Réponse rédigée par une intelligence artificielle uniquement à partir des sources listées avec elle. Elle peut contenir des erreurs : vérifiez chaque citation dans le texte officiel (PDF).'));
    } else if (r.status === 'refused') {
      const extra = r.reason === 'refus_modele' ? ' Des passages ont été examinés, mais aucune réponse sourcée n\'a pu en être tirée.' : '';
      if (hasTexts) {
        box.append(textsBlock(r));
        box.append(callout('info', 'Pourquoi pas de réponse directe', (r.answer || '') + extra));
      } else {
        box.append(callout('info', 'Aucune réponse établie', (r.answer || '') + extra));
      }
      box.append(el('p', 'ans-label', 'Cela ne prouve pas qu\'aucune disposition n\'existe : reformulez la question (texte, numéro, article, période) ou consultez directement les textes officiels.'));
      if (notes.length) box.append(callout('warn', 'Précisions', null, notes.map(plain)));
    } else if (r.status === 'smalltalk') {
      const t = el('div', 'ans-text'); (r.answer || '').split('\n\n').forEach((p) => t.append(el('p', null, p))); box.append(t);
    } else if (r.status === 'clarification') {
      box.append(callout('info', 'Précision nécessaire', r.answer || ''));
      if (notes.length) box.append(callout('warn', 'Précisions', null, notes.map(plain)));
    } else if (r.status === 'llm_unavailable') {
      const why = (r.llm && r.llm.message) || UNAVAILABLE;
      if (hasTexts) {
        box.append(textsBlock(r));
        box.append(callout('warn', 'Pourquoi pas de réponse directe', why));
      } else {
        box.append(callout('warn', 'Réponse indisponible', why));
        box.append(el('p', 'ans-label', 'Les passages retrouvés sont affichés dans la section Sources. Ils ne constituent pas une réponse.'));
      }
      const rest = notes.filter((n) => n !== why);
      if (rest.length) box.append(callout('warn', 'Précisions', null, rest.map(plain)));
    } else {
      box.append(callout('error', 'Réponse inattendue du service', 'Le service a renvoyé un état non reconnu.'));
    }
    if (r.disclaimer) box.append(el('p', 'disclaimer', r.disclaimer));
  }

  function renderResponse(r) { renderSources(r); renderAnswer(r); }

  function renderError(message) {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    const box = $('answer'); box.replaceChildren(); box.removeAttribute('aria-busy');
    box.append(callout('error', 'La question n\'a pas pu être traitée', message));
    $('sources').replaceChildren(el('p', 'placeholder', 'Aucune source : la question n\'a pas abouti.'));
  }

  function renderLoading() {
    const box = $('answer'); box.replaceChildren(); box.setAttribute('aria-busy', 'true');
    const p = el('p', 'loading'); const t0 = Date.now();
    const msg = el('span', null, 'Recherche dans les textes puis rédaction de la réponse. Cela peut prendre jusqu\'à deux minutes… ');
    const sec = el('span', 'elapsed', '0 s'); sec.setAttribute('aria-live', 'off');
    p.append(msg, sec); box.append(p, skeleton(false));
    $('sources').replaceChildren(el('p', 'placeholder', 'Recherche des sources en cours…'), skeleton(true));
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => { sec.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; }, 1000);
  }

  /* ---------- envoi d'une question ---------- */
  const starting = () => !!(state.status && state.status.app && state.status.app.state === 'starting');

  function updateComposer() {
    const q = $('question').value; const n = q.trim().length;
    const counter = $('counter'); counter.textContent = q.length + ' / ' + state.maxQ; counter.classList.toggle('over', q.length > state.maxQ);
    let msg = '';
    if (!state.checked) msg = '';
    else if (!state.reachable) msg = 'Le service est momentanément injoignable. Réessayez dans un instant.';
    else if (starting()) msg = 'Le service démarre, veuillez patienter quelques secondes…';
    else if (state.status && state.status.llm && !state.status.llm.online) msg = UNAVAILABLE + ' Les textes pertinents seront affichés sans réponse rédigée.';
    else if (queueOn() && !state.busy && (state.status.queue.running || state.status.queue.waiting)) {
      const n = state.status.queue.waiting + (state.status.queue.running ? 1 : 0);
      msg = n === 1 ? 'Une question est en cours de traitement : la vôtre passera juste après.' : n + ' questions sont dans la file : la vôtre passera à son tour.';
    }
    $('composer-msg').textContent = msg;
    const disabled = state.busy || !state.reachable || starting();
    $('btn-send').disabled = disabled || n < 3 || q.length > state.maxQ;
    document.querySelectorAll('.chip').forEach((b) => { b.disabled = disabled; });
    autosize();
  }

  function commitAnswer(q, data, meta) {
    if (!state.conv) { state.conv = { id: uid(), at: Date.now(), entries: [] }; state.convs.push(state.conv); }
    const entry = { id: uid(), at: Date.now(), q: data.question || q, r: data };
    if (meta && meta.ticket) { entry.ticket = meta.ticket; entry.exp = meta.exp; }
    state.conv.entries.push(entry); state.entry = entry.id;
    saveHistory(); renderHistory(); renderResponse(data);
    if (meta && meta.viaLink) $('answer').prepend(el('p', 'ans-label', 'Réponse retrouvée avec votre lien personnel.'));
    const note = serverNote(entry); if (note) $('answer').append(note);
    $('question').value = '';
    markReady();
  }

  async function sendQuestion() {
    const q = $('question').value.trim();
    if (state.busy || q.length < 3 || q.length > state.maxQ) return;
    state.busy = true; updateComposer(); showQuestion(q);
    try {
      const out = queueOn() ? await askQueued(q) : { result: await askDirect(q) };
      if (out && out.result) commitAnswer(q, out.result, out);
    } finally {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.busy = false; refreshStatus(); updateComposer();
    }
  }

  /* Requête unique : la réponse revient sur la même connexion (application locale ; déploiement sans file d'attente). Renvoie la réponse, ou null après avoir affiché l'erreur. */
  async function askDirect(q) {
    renderLoading();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: controller.signal
      });
      if (res.status === 401) { location.assign('/login'); return null; }          // mode réseau : session expirée → page du code d'accès
      let data = null; try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || data.error) {
        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After') || '30';
          renderError('Le serveur traite actuellement une autre question. Veuillez réessayer dans environ ' + retryAfter + ' secondes.');
        } else {
          renderError((data && data.error && data.error.message) || 'Le service a répondu par une erreur (' + res.status + ').');
        }
        return null;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') {
        renderError('Le délai de traitement a expiré (dépassement de 270 secondes). Le serveur est peut-être surchargé.');
      } else {
        renderError('Le service est momentanément injoignable. Réessayez dans un instant.');
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /* ---------- suivi des questions : file d'attente, lien personnel, notification facultative ----------
     Une question déposée reçoit un lien personnel ; la page en relève l'état toutes les quelques secondes. Avec la file persistante, la question est conservée
     sur le serveur : on peut fermer la page et revenir (lien, ou notification). Sinon (file en mémoire), la page doit rester ouverte. */
  const queueOn = () => !!(state.status && state.status.queue && state.status.queue.enabled);
  const persistent = () => queueOn() && !!state.status.queue.persistent;
  const sleep = (ms) => new Promise((r) => { state.wake = r; setTimeout(r, ms); });                // le retour du réseau réveille l'attente
  const fmtEta = (s) => (s < 45 ? "moins d'une minute" : s < 90 ? 'environ 1 minute' : 'environ ' + Math.round(s / 60) + ' minutes');
  const fmtDur = (s) => (s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s');
  const days = () => { const d = (state.status && state.status.queue && state.status.queue.retention_days) || 7; return d === 1 ? '1 jour' : (Number.isInteger(d) ? d : Math.round(d * 10) / 10) + ' jours'; };
  const ACTIVE_KEY = 'regassist.active.v1';
  const TICKET_RE = /^[A-Za-z0-9_-]{16,64}$/;
  const newKey = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const loadActive = () => { try { const v = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); return v && TICKET_RE.test(v.ticket) ? v : null; } catch (e) { return null; } };
  const saveActive = (ticket, q, notified) => { try { localStorage.setItem(ACTIVE_KEY, JSON.stringify({ ticket, q, n: notified ? 1 : 0, at: Date.now() })); } catch (e) { /* stockage indisponible : le lien du suivi reste valable */ } };
  const clearActive = () => { try { localStorage.removeItem(ACTIVE_KEY); } catch (e) { /* rien à effacer */ } };
  const hashTicket = () => { const m = /^#q=([A-Za-z0-9_-]{16,64})$/.exec(location.hash); return m ? m[1] : null; };
  const setHash = (t) => { try { history.replaceState(null, '', t ? '#q=' + t : location.pathname + location.search); } catch (e) { /* adresse non modifiable : sans conséquence */ } };
  const trackUrl = (t) => location.origin + '/#q=' + t;
  const STEPS = ['Question envoyée', 'En attente de traitement', 'En cours de traitement', 'Réponse disponible'];

  async function queueCall(suffix, init) {          // suffix : '' (dépôt) ou '/<ticket>' (état)
    const res = await fetch('/api/queue' + suffix, init);
    if (res.status === 401) { location.assign('/login'); return { res, data: null }; }
    let data = null; try { data = await res.json(); } catch (e) { data = null; }
    return { res, data };
  }

  /* --- notification : proposée après l'envoi, permission demandée seulement après un clic --- */
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };

  function buildNotify(ticket, notified) {
    const wrap = el('div', 'track-notify'); const msg = el('p', 'track-note'); const btn = el('button', 'btn btn-ghost', 'Me prévenir quand la réponse est prête'); btn.type = 'button';
    const push = state.status.queue.push || {};
    const set = (text, withButton) => { msg.textContent = text; btn.hidden = !withButton; };
    if (!push.enabled) set('Ce service n\'envoie pas de notification : gardez votre lien pour revenir lire la réponse.', false);
    else if (!pushSupported()) set('Ce navigateur ne gère pas les notifications : gardez votre lien ou laissez cette page ouverte.', false);
    else if (Notification.permission === 'denied') set('Les notifications sont bloquées pour ce site dans votre navigateur : gardez votre lien pour revenir lire la réponse.', false);
    else if (notified) set('Notification activée pour cette question : elle ne sera envoyée qu\'une fois, à la fin du traitement.', false);
    else set('Facultatif : votre navigateur vous demandera l\'autorisation d\'afficher une notification quand la réponse sera prête, même si ce site est fermé. Elle ne contiendra ni votre question ni la réponse. Si vous refusez, rien d\'autre ne change.', true);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { set('Notification non activée : gardez votre lien pour revenir lire la réponse.', false); return; }
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(push.key) }));
        const res = await fetch('/api/queue/' + encodeURIComponent(ticket) + '/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
        if (res.status === 409) { set('La réponse est déjà prête : ouvrez le suivi pour la lire.', false); return; }
        if (!res.ok) throw new Error('abonnement refusé');
        saveActive(ticket, state.tr && state.tr.q, true);
        set('Notification activée pour cette question : elle ne sera envoyée qu\'une fois, à la fin du traitement.', false);
      } catch (e) {
        set('L\'activation des notifications a échoué : gardez votre lien pour revenir lire la réponse.', false);
      } finally { btn.disabled = false; }
    });
    wrap.append(msg, btn);
    return wrap;
  }

  /* --- fiche de suivi : construite une fois, puis seuls ses textes changent (les boutons restent utilisables) --- */
  function buildTrack(v, q) {
    const box = $('answer'); box.replaceChildren(); box.setAttribute('aria-busy', 'true');
    const card = el('div', 'track'); const live = el('p', 'sr-only'); live.setAttribute('role', 'status');
    const steps = el('ol', 'track-steps'); const items = STEPS.map((t) => { const li = el('li', 'track-step'); li.append(el('span', 'track-dot'), el('span', 'track-label', t)); steps.append(li); return li; });
    const detail = el('p', 'track-detail'); const net = el('p', 'track-net', 'Connexion interrompue : nouvelle tentative en cours. Votre question n\'est pas perdue.'); net.hidden = true;
    card.append(live, steps, detail, net);
    const tr = { card, live, items, detail, net, q, since: null, game: null, gameOpen: false, last: '' };
    if (persistent()) {
      card.append(el('p', 'track-note', 'Vous pouvez fermer cette page : votre question est conservée sur le serveur ' + days() + '. Gardez ce lien personnel pour la retrouver, sans le partager : il donne accès à votre question et à sa réponse.'));
      const row = el('div', 'track-link'); const input = el('input'); input.type = 'text'; input.readOnly = true; input.value = trackUrl(v.ticket); input.setAttribute('aria-label', 'Lien personnel de suivi');
      input.addEventListener('focus', () => input.select());
      const copy = el('button', 'btn btn-ghost', 'Copier le lien'); copy.type = 'button';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(input.value); copy.textContent = 'Lien copié'; } catch (e) { input.focus(); input.select(); copy.textContent = 'Copiez avec Ctrl+C'; } setTimeout(() => { copy.textContent = 'Copier le lien'; }, 2500); });
      row.append(input, copy); card.append(row);
      const rec = loadActive(); card.append(buildNotify(v.ticket, !!(rec && rec.ticket === v.ticket && rec.n)));
    } else {
      card.append(el('p', 'track-note', 'Une seule question est traitée à la fois. Gardez cette page ouverte : votre question démarrera automatiquement.'));
    }
    const actions = el('div', 'track-actions');
    const play = el('button', 'btn btn-ghost', 'Patienter en jouant (facultatif)'); play.type = 'button'; play.setAttribute('aria-expanded', 'false');
    const gameBox = el('div', 'track-game'); gameBox.hidden = true;
    play.addEventListener('click', () => toggleGame(tr, play, gameBox, true));
    const del = el('button', 'btn btn-link', persistent() ? 'Supprimer ma question' : 'Quitter la file d\'attente'); del.type = 'button';
    let armed = null;
    del.addEventListener('click', () => {
      if (persistent() && !armed) { del.textContent = 'Confirmer la suppression'; armed = setTimeout(() => { del.textContent = 'Supprimer ma question'; armed = null; }, 4000); return; }
      clearTimeout(armed); armed = null; leaveTrack(tr);
    });
    actions.append(play, del); card.append(actions, gameBox); box.append(card);
    $('sources').replaceChildren(el('p', 'placeholder', 'Les sources s\'afficheront avec la réponse.'));
    state.tr = tr;
  }

  function toggleGame(tr, play, gameBox, open) {
    tr.gameOpen = open; gameBox.hidden = !open; play.setAttribute('aria-expanded', String(open));
    if (open && !tr.game && window.RegAssistGame) tr.game = window.RegAssistGame.mount(gameBox, { onBack: () => { toggleGame(tr, play, gameBox, false); play.focus(); } });
    if (!open && tr.onGameClose) { const f = tr.onGameClose; tr.onGameClose = null; f(); }
  }

  function updateTrack(v, q) {
    if (!state.tr) buildTrack(v, q);
    const t = state.tr; const idx = v.state === 'queued' ? 1 : v.state === 'running' ? 2 : 3;
    t.items.forEach((li, i) => { li.classList.toggle('is-done', i < idx); li.classList.toggle('is-current', i === idx); if (i === idx) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    let announce;
    if (v.state === 'queued') {
      const n = v.ahead === 1 ? '1 question avant la vôtre' : v.ahead + ' questions avant la vôtre';
      t.detail.textContent = 'N° ' + v.position + ' dans la file · ' + n + '. Attente estimée : ' + fmtEta(v.eta_s) + ' (estimation d\'après les dernières réponses, non garantie).';
      announce = !t.last ? 'Question envoyée. Elle est en attente de traitement, position ' + v.position + '.' : 'En attente de traitement, position ' + v.position + '.';
    } else {
      t.since = t.since || Date.now() - (v.run_s || 0) * 1000;
      t.detail.textContent = 'Votre question est en cours de traitement depuis ' + fmtDur(Math.round((Date.now() - t.since) / 1000)) + '. La durée n\'est pas connue à l\'avance.';
      announce = 'C\'est votre tour : votre question est en cours de traitement.';
    }
    const key = v.state + ':' + (v.position || 0);
    if (key !== t.last) { t.live.textContent = announce; t.last = key; }
  }

  async function leaveTrack(tr) {                   // quitter la file (file en mémoire) ou supprimer la question (file persistante)
    const t = state.ticket; state.cancelled = true;
    let removed = false;
    if (t) { try { const r = await queueCall('/' + encodeURIComponent(t) + '/cancel', { method: 'POST' }); removed = !!(r.data && r.data.cancelled); } catch (e) { /* injoignable : le délai de conservation s'appliquera */ } }
    if (!removed && persistent()) { state.cancelled = false; tr.detail.textContent = 'Le traitement a déjà commencé : la question pourra être supprimée dès que la réponse sera prête.'; return; }
    clearActive(); setHash(null);
  }

  function flagTitle() {                            // onglet en arrière-plan : le titre signale la fin
    if (!document.hidden) return;
    const old = document.title; document.title = 'Réponse prête - ' + old;
    const back = () => { document.title = old; window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
    window.addEventListener('focus', back); document.addEventListener('visibilitychange', back);
  }

  function waitForReader() {                        // pendant une partie, la réponse n'interrompt pas le joueur : un bandeau l'invite à la lire
    const t = state.tr; if (!t || !t.gameOpen) return Promise.resolve();
    return new Promise((resolve) => {
      const b = el('div', 'track-ready'); b.setAttribute('role', 'status'); const btn = el('button', 'btn btn-primary', 'Lire la réponse'); btn.type = 'button';
      b.append(el('span', null, 'Votre réponse est prête.'), btn); t.card.prepend(b);
      btn.addEventListener('click', () => { t.onGameClose = null; resolve(); });
      t.onGameClose = resolve;
    });
  }

  function afterLeave() {
    resetWorkspace();
    if (persistent()) $('answer').replaceChildren(callout('info', 'Question supprimée', 'Votre question a été supprimée du serveur. Vous pouvez en poser une autre.'));
  }

  async function followTicket(v, q) {
    state.ticket = v.ticket; state.cancelled = false; state.tr = null;
    let fails = 0;
    try {
      while (true) {
        if (v.state === 'done') { flagTitle(); await waitForReader(); return v; }
        if (v.state === 'error') { renderError((v.error && v.error.message) || 'La question n\'a pas pu être traitée.'); return null; }
        if (state.cancelled) { afterLeave(); return null; }
        updateTrack(v, q);
        await sleep(document.hidden ? QUEUE_POLL_HIDDEN_MS : QUEUE_POLL_MS);
        if (state.cancelled) { afterLeave(); return null; }
        let r;
        try { r = await queueCall('/' + encodeURIComponent(v.ticket), { cache: 'no-store' }); } catch (e) { r = null; }
        if (!r || !r.data || r.res.status === 429 || r.res.status >= 500) {          // réseau coupé ou service momentanément indisponible : on réessaie, sans rien perdre
          fails++; if (state.tr) state.tr.net.hidden = false;
          if (!persistent() && fails >= 8) { renderError('Le service est momentanément injoignable. Réessayez dans un instant.'); return null; }
          await sleep(Math.min(30000, 3000 * fails));
          continue;
        }
        fails = 0; if (state.tr) state.tr.net.hidden = true;
        if (r.res.status === 404) { clearActive(); setHash(null); renderError('Cette demande n\'existe plus : elle a été supprimée ou son délai de conservation est dépassé. Posez de nouveau votre question.'); return null; }
        if (r.data.error && !r.data.state) { renderError(r.data.error.message); return null; }
        v = r.data;
      }
    } finally {
      state.ticket = null; if (state.tr && state.tr.game) state.tr.game.destroy(); state.tr = null;
    }
  }

  async function askQueued(q) {                     // nouvelle question : dépôt, puis suivi
    state.cancelled = false; renderLoading();
    const key = state.idem && state.idem.q === q ? state.idem.key : newKey();           // même clé pour un nouvel essai de la même question : jamais de doublon
    state.idem = { q, key };
    let r;
    try { r = await queueCall('', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ question: q }) }); }
    catch (e) { renderError('Le service est momentanément injoignable : votre question n\'a pas été envoyée. Vous pouvez la renvoyer sans risque de doublon.'); return null; }
    if (!r.data) { renderError('Le service a répondu par une erreur (' + r.res.status + ').'); return null; }
    if (r.data.error && !r.data.state) { state.idem = null; renderError(r.data.error.message); return null; }
    state.idem = null;
    let v = r.data;
    if (v.state === 'done' && !v.ticket) return { result: v.result };                   // salutation : réponse immédiate
    if (persistent()) { saveActive(v.ticket, q, false); setHash(v.ticket); }
    v = await followTicket(v, q);
    if (!v) return null;
    clearActive(); setHash(null);
    return { result: v.result, ticket: persistent() ? v.ticket : null, exp: Date.now() + (v.expires_in_s || 0) * 1000 };
  }

  async function resumeTracking(ticket) {           // retour sur le site avec un lien personnel, une notification ou une question encore en cours
    if (state.busy || !TICKET_RE.test(ticket) || !queueOn()) return;
    state.busy = true; updateComposer(); renderLoading();
    try {
      let r;
      try { r = await queueCall('/' + encodeURIComponent(ticket), { cache: 'no-store' }); } catch (e) { renderError('Le service est momentanément injoignable. Rechargez la page pour reprendre le suivi : votre question n\'est pas perdue.'); return; }
      if (!r.data || r.res.status === 404 || (r.data.error && !r.data.state)) {
        clearActive(); setHash(null); resetWorkspace();
        $('answer').replaceChildren(callout('info', 'Demande introuvable', 'Cette demande n\'existe plus : elle a été supprimée ou son délai de conservation est dépassé. Vous pouvez poser de nouveau votre question.'));
        return;
      }
      const known = findEntry(ticket);
      if (known) { clearActive(); setHash(null); openEntry(known.c.id, known.en.id); return; }
      const q = r.data.question || ''; showQuestion(q);
      const v = await followTicket(r.data, q);
      if (v) { clearActive(); setHash(null); commitAnswer(q, v.result, { ticket, exp: Date.now() + (v.expires_in_s || 0) * 1000, viaLink: true }); }
    } finally {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      state.busy = false; refreshStatus(); updateComposer();
    }
  }

  function findEntry(ticket) {
    for (const c of state.convs) for (const en of c.entries) if (en.ticket === ticket) return { c, en };
    return null;
  }

  // Sous une réponse conservée sur le serveur : date de suppression automatique et suppression immédiate.
  function serverNote(entry) {
    if (!entry.ticket || !entry.exp) return null;
    const p = el('p', 'server-note'); const when = new Date(entry.exp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    p.append(document.createTextNode('Cette question et sa réponse restent sur le serveur jusqu\'au ' + when + ', pour que vous puissiez les retrouver avec votre lien. '));
    const b = el('button', 'btn btn-link', 'Les supprimer maintenant'); b.type = 'button'; let armed = null;
    b.addEventListener('click', async () => {
      if (!armed) { b.textContent = 'Confirmer la suppression'; armed = setTimeout(() => { b.textContent = 'Les supprimer maintenant'; armed = null; }, 4000); return; }
      clearTimeout(armed); armed = null; b.disabled = true;
      let gone = false; try { const r = await queueCall('/' + encodeURIComponent(entry.ticket) + '/cancel', { method: 'POST' }); gone = !!(r.data && r.data.cancelled) || (r.res.status === 200); } catch (e) { gone = false; }
      if (gone) { delete entry.ticket; delete entry.exp; saveHistory(); p.textContent = 'Supprimées du serveur. L\'historique de ce navigateur n\'est pas modifié.'; } else { b.disabled = false; b.textContent = 'Les supprimer maintenant'; p.append(document.createTextNode(' Suppression impossible pour le moment.')); }
    });
    p.append(b);
    return p;
  }

  /* ---------- disponibilité du service (aucun détail technique affiché) ---------- */
  async function refreshStatus() {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.status === 401) { location.assign('/login'); return; }
      if (!res.ok) throw new Error('status ' + res.status);
      state.status = await res.json(); state.reachable = true;
      state.maxQ = (state.status.limits && state.status.limits.max_question_chars) || DEFAULT_MAX_Q;
    } catch (e) { state.status = null; state.reachable = false; }
    state.checked = true;
    renderPersistNotes();
    updateComposer();
  }

  // Avec la file persistante, la question est conservée sur le serveur : l'interface le dit avant l'envoi et dans « À propos » (le texte par défaut dit le contraire).
  function renderPersistNotes() {
    const on = persistent(); const note = $('persist-note');
    note.hidden = !on; $('about-data').hidden = !on; $('about-data-default').hidden = on;
    if (on) {
      note.textContent = 'Pour vous permettre de fermer la page et de revenir lire la réponse, votre question et sa réponse sont conservées sur le serveur ' + days() + ', puis supprimées. Vous pouvez les supprimer à tout moment.';
      $('about-data').textContent = "Pour vous permettre de fermer la page et de revenir lire la réponse, votre question et sa réponse sont conservées sur le serveur pendant " + days() + ", puis supprimées ; vous pouvez les supprimer à tout moment. Elles ne sont lisibles qu'avec votre lien personnel, et le texte des questions n'est pas écrit dans les journaux. Votre historique est enregistré dans votre navigateur ; vous pouvez l'effacer à tout moment.";
    }
  }

  function toggleAbout(open) {
    const p = $('about-panel'); p.hidden = !open; $('btn-about').setAttribute('aria-expanded', String(open));
    if (open) $('btn-about-close').focus(); else $('btn-about').focus();
  }

  /* ---------- initialisation ---------- */
  function init() {
    loadHistory(); renderHistory(); resetWorkspace(); updateComposer();
    $('form').addEventListener('submit', (ev) => { ev.preventDefault(); sendQuestion(); });
    $('question').addEventListener('input', updateComposer);
    $('question').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendQuestion(); } });
    document.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.busy || !state.reachable || starting()) return;
        const q = btn.dataset.question || btn.textContent.trim();
        $('question').value = q;
        updateComposer();
        $('question').focus();
      });
    });
    $('btn-new').addEventListener('click', newConversation);
    let armed = null;
    $('btn-clear').addEventListener('click', () => {
      const b = $('btn-clear');
      if (!armed) { b.textContent = "Confirmer l'effacement"; armed = setTimeout(() => { b.textContent = "Effacer l'historique"; armed = null; }, 4000); return; }
      clearTimeout(armed); armed = null; b.textContent = "Effacer l'historique"; clearHistory();
    });
    $('btn-about').addEventListener('click', () => toggleAbout($('about-panel').hidden));
    $('btn-about-close').addEventListener('click', () => toggleAbout(false));
    $('btn-menu').addEventListener('click', () => toggleHistory(!document.body.classList.contains('history-open')));
    $('scrim').addEventListener('click', () => toggleHistory(false));
    $('toast-go').addEventListener('click', readAnswer);
    $('notice-more').addEventListener('click', () => toggleAbout(true));            // bandeau compact : « Texte complet » ouvre le panneau « À propos »
    $('toast-close').addEventListener('click', hideToast);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (!$('about-panel').hidden) toggleAbout(false);
      else if (document.body.classList.contains('history-open')) toggleHistory(false);
      else if (!$('toast').hidden) hideToast();
    });
    trackViewport();
    refreshStatus().then(() => { const t = hashTicket() || (loadActive() || {}).ticket; if (t) resumeTracking(t); });            // lien personnel ou question encore en cours : le suivi reprend
    setInterval(() => { if (!document.hidden && !state.busy) refreshStatus(); }, POLL_MS);
    window.addEventListener('online', () => { if (state.wake) state.wake(); });
    window.addEventListener('hashchange', () => { const t = hashTicket(); if (t && !state.busy) resumeTracking(t); });
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (ev) => {          // clic sur une notification alors que le site est déjà ouvert
      const m = ev.data && ev.data.type === 'open-ticket' ? /#q=([A-Za-z0-9_-]{16,64})$/.exec(String(ev.data.url)) : null;
      if (m && !state.busy) resumeTracking(m[1]);
    });
    window.addEventListener('focus', refreshStatus);
    window.addEventListener('pagehide', () => {          // file en mémoire seulement : page fermée = place libérée (la file persistante conserve la demande)
      if (state.ticket && !persistent()) fetch('/api/queue/' + encodeURIComponent(state.ticket) + '/cancel', { method: 'POST', keepalive: true }).catch(() => {});
    });
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) $('question').focus();          // sur téléphone, le clavier ne s'ouvre pas tout seul au chargement
  }
  init();
})();
