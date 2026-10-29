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
  const QUEUE_MAX_WAIT_MS = 45 * 60 * 1000;
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
    state.conv = c; state.entry = en.id;
    showQuestion(en.q, 'Réponse enregistrée le ' + fmtWhen(en.at) + ' (historique de ce navigateur) : elle n\'est pas recalculée. Reposez la question pour obtenir une réponse à jour.');
    renderResponse(en.r);
    renderHistory();
  }

  function newConversation() {
    if (state.busy) return;
    state.conv = null; state.entry = null;
    resetWorkspace(); renderHistory(); $('question').focus();
  }

  /* ---------- rendu ---------- */
  function resetWorkspace() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    $('question-echo').hidden = true; $('answer').removeAttribute('aria-busy');
    $('sources').replaceChildren(el('p', 'placeholder', 'Les textes officiels retrouvés apparaîtront ici, avec leurs extraits.'));
    $('answer').replaceChildren(el('p', 'placeholder', 'Posez une question en bas de page. La réponse n\'est affichée qu\'accompagnée de ses sources.'));
  }

  function showQuestion(q, savedNote) {
    const box = $('question-echo'); box.replaceChildren(el('div', 'q-label', 'Question'), el('div', 'q-text', q));
    if (savedNote) box.append(el('div', 'q-saved', savedNote));
    box.hidden = false;
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
      box.append(el('p', 'ans-label', 'Réponse rédigée par une intelligence artificielle uniquement à partir des sources ci-contre. Elle peut contenir des erreurs : vérifiez chaque citation dans le texte officiel (PDF).'));
      if (notes.length) { const tg = el('div', 'tags'); tg.append(tag(notes.length + ' avertissement(s) à lire sous la réponse', 'warn')); box.append(tg); }
      const ids = new Set((r.sources || []).map((s) => s.id));
      const t = el('div', 'ans-text'); withCitations(t, humanize(r.answer), ids); box.append(t);
      const cites = (r.citations || []).map((c) => c.id);
      if (cites.length) { const l = el('div', 'cited-list', 'Sources citées : '); cites.forEach((id, i) => { if (i) l.append(document.createTextNode(' ')); withCitations(l, '[' + id + ']', ids); }); box.append(l); }
      if (notes.length) { const w = callout('warn', 'À vérifier avant tout usage', null, notes.map(plain)); w.classList.add('callout-after'); box.append(w); }
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
        box.append(el('p', 'ans-label', 'Les passages retrouvés sont affichés ci-contre. Ils ne constituent pas une réponse.'));
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
    p.append(msg, sec); box.append(p);
    $('sources').replaceChildren(el('p', 'placeholder', 'Recherche des sources en cours…'));
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
  }

  function commitAnswer(q, data) {
    if (!state.conv) { state.conv = { id: uid(), at: Date.now(), entries: [] }; state.convs.push(state.conv); }
    const entry = { id: uid(), at: Date.now(), q: data.question || q, r: data };
    state.conv.entries.push(entry); state.entry = entry.id;
    saveHistory(); renderHistory(); renderResponse(data);
    $('question').value = '';
  }

  async function sendQuestion() {
    const q = $('question').value.trim();
    if (state.busy || q.length < 3 || q.length > state.maxQ) return;
    state.busy = true; updateComposer(); showQuestion(q);
    try {
      const data = queueOn() ? await askQueued(q) : await askDirect(q);
      if (data) commitAnswer(q, data);
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

  /* ---------- file d'attente (déploiement public) : un ticket, puis l'état est relevé toutes les quelques secondes ---------- */
  const queueOn = () => !!(state.status && state.status.queue && state.status.queue.enabled);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtEta = (s) => (s < 45 ? "moins d'une minute" : s < 90 ? 'environ 1 minute' : 'environ ' + Math.round(s / 60) + ' minutes');

  // Fiche « file d'attente » : construite une fois, puis seuls ses textes sont mis à jour (le bouton reste cliquable).
  function renderQueueCard() {
    const box = $('answer'); box.replaceChildren(); box.setAttribute('aria-busy', 'true');
    const card = el('div', 'queue-card'); card.setAttribute('role', 'status');
    const head = el('div', 'queue-head', 'Votre question est en file d\'attente');
    const pos = el('div', 'queue-pos'); const ahead = el('div', 'queue-line'); const eta = el('div', 'queue-line');
    const hint = el('p', 'queue-hint', 'Une seule question est traitée à la fois. Gardez cette page ouverte : votre question démarrera automatiquement.');
    const leave = el('button', 'btn btn-ghost queue-leave','Quitter la file d\'attente'); leave.type = 'button';
    leave.addEventListener('click', cancelQueued);
    card.append(head, pos, ahead, eta, hint, leave); box.append(card);
    $('sources').replaceChildren(el('p', 'placeholder', 'Les sources s\'afficheront avec la réponse.'));
    state.qui = { card, head, pos, ahead, eta };
  }

  function updateQueueCard(v) {
    if (!state.qui) renderQueueCard();
    const u = state.qui;
    u.pos.textContent = 'N° ' + v.position + ' dans la file';
    u.ahead.textContent = v.ahead === 1 ? '1 question avant la vôtre' : v.ahead + ' questions avant la vôtre';
    u.eta.textContent = 'Attente estimée : ' + fmtEta(v.eta_s);
  }

  async function cancelQueued() {
    const t = state.ticket; state.cancelled = true;
    if (t) { try { await fetch('/api/queue/' + encodeURIComponent(t) + '/cancel', { method: 'POST' }); } catch (e) { /* le ticket expirera de lui-même */ } }
  }

  async function queueCall(suffix, init) {          // suffix : '' (dépôt) ou '/<ticket>' (état)
    const res = await fetch('/api/queue' + suffix, init);
    if (res.status === 401) { location.assign('/login'); return { res, data: null }; }
    let data = null; try { data = await res.json(); } catch (e) { data = null; }
    return { res, data };
  }

  async function askQueued(q) {
    state.cancelled = false; state.ticket = null; state.qui = null;
    const t0 = Date.now(); let fails = 0; let first = true;
    renderLoading();
    try {
      let v = null;
      while (true) {
        let r;
        try {
          r = first
            ? await queueCall('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }) })
            : await queueCall('/' + encodeURIComponent(v.ticket), { cache: 'no-store' });
        } catch (e) {
          if (first || ++fails >= 8) { renderError('Le service est momentanément injoignable. Réessayez dans un instant.'); return null; }
          await sleep(QUEUE_POLL_MS); continue;
        }
        if (!r.data) { if (r.res.status === 401) return null; renderError('Le service a répondu par une erreur (' + r.res.status + ').'); return null; }
        fails = 0;
        if (r.data.error && !r.data.state) { renderError(r.res.status === 404 && !first ? 'Votre place dans la file a expiré. Posez de nouveau votre question.' : r.data.error.message); return null; }
        v = r.data; first = false;
        if (v.state === 'done') return v.result;
        if (v.state === 'error') { renderError((v.error && v.error.message) || 'La question n\'a pas pu être traitée.'); return null; }
        state.ticket = v.ticket;
        if (state.cancelled) { resetWorkspace(); return null; }
        if (v.state === 'queued') updateQueueCard(v);
        else if (state.qui) { state.qui = null; renderLoading(); }          // c'est son tour : retour à l'affichage « traitement en cours »
        if (Date.now() - t0 > QUEUE_MAX_WAIT_MS) { renderError('L\'attente a dépassé 45 minutes. Réessayez plus tard.'); return null; }
        await sleep(QUEUE_POLL_MS);
        if (state.cancelled) { resetWorkspace(); return null; }
      }
    } finally {
      state.ticket = null; state.qui = null;
    }
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
    updateComposer();
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
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('about-panel').hidden) toggleAbout(false); });
    refreshStatus(); setInterval(() => { if (!document.hidden && !state.busy) refreshStatus(); }, POLL_MS);
    window.addEventListener('focus', refreshStatus);
    window.addEventListener('pagehide', () => {          // page fermée : on libère sa place dans la file
      if (state.ticket) fetch('/api/queue/' + encodeURIComponent(state.ticket) + '/cancel', { method: 'POST', keepalive: true }).catch(() => {});
    });
    $('question').focus();
  }
  init();
})();
