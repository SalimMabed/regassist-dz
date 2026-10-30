// Tests de la logique du quiz d'attente (quiz-logic.js) et de l'intégrité de ses fichiers : sélection, score, messages, meilleur résultat, absence de tout code réseau.
// Aucune dépendance : Node seul, sans navigateur. Lancement : node --test local_app/tests/test_quiz.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, '..', 'static');
const L = createRequire(import.meta.url)(path.join(STATIC, 'quiz-logic.js'));
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');

const sandbox = { window: {} }; vm.createContext(sandbox); vm.runInContext(read('quiz-data.js'), sandbox);
const DATA = sandbox.window.RegAssistQuizData;
const BANK = DATA.questions;

function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
class Mem { constructor() { this.m = {}; } getItem(k) { return k in this.m ? this.m[k] : null; } setItem(k, v) { this.m[k] = String(v); } }

test('banque : fichier de données chargé, figé, 5 questions au moins, chaque question complète et référencée', () => {
  assert.ok(Object.isFrozen(DATA) && BANK.length >= 15);
  for (const q of BANK) {
    assert.ok(q.question && q.explanation && q.choices.length >= 3 && q.choices.length <= 4 && q.answer >= 0 && q.answer < q.choices.length, q.id);
    assert.ok(q.source.title && q.source.quote && q.source.reference, q.id);
    if (q.kind === 'assistant') { assert.ok(q.source.type === 'application' && q.source.url === null && q.source.page === null, 'source = texte de l\'application, sans PDF : ' + q.id); continue; }
    assert.ok(q.source.page >= 1, q.id);
    assert.ok(q.source.url.startsWith('https://www.bank-of-algeria.dz/'), 'lien du document original : ' + q.id);
  }
});

test('série : 5 questions distinctes, textes distincts, types variés, au moins une question sur un article et une sur l\'assistant', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const s = L.pickSession(BANK, { random: seeded(seed) });
    assert.equal(s.length, 5, 'seed ' + seed);
    assert.equal(new Set(s.map((i) => i.question.id)).size, 5);
    assert.equal(new Set(s.map((i) => i.question.source.document_id)).size, 5, 'jamais deux fois le même texte');
    assert.ok(s.some((i) => i.question.kind === 'contenu'), 'une question sur le contenu d\'un article');
    assert.ok(s.some((i) => i.question.kind === 'assistant'), 'une question sur l\'assistant (IA, limites, valeur juridique)');
    const kinds = {}; s.forEach((i) => { kinds[i.question.kind] = (kinds[i.question.kind] || 0) + 1; });
    assert.ok(Object.entries(kinds).every(([k, n]) => n <= (k === 'contenu' ? 3 : 2)), JSON.stringify(kinds));
  }
});

test('réponses mélangées : chaque ordre est une permutation et la bonne réponse suit le mélange', () => {
  const positions = new Set();
  for (let seed = 1; seed <= 80; seed++) {
    for (const it of L.pickSession(BANK, { random: seeded(seed) })) {
      const n = it.question.choices.length;
      assert.deepEqual([...it.order].sort(), [...Array(n).keys()]);
      assert.equal(it.order[it.correct], it.question.answer, 'la bonne réponse reste la bonne réponse');
      positions.add(it.correct);
    }
  }
  assert.ok(positions.size >= 3, 'la bonne réponse n\'est pas toujours à la même place : ' + [...positions]);
});

test('série : déterministe pour un même tirage, différente d\'un tirage à l\'autre', () => {
  const ids = (seed) => L.pickSession(BANK, { random: seeded(seed) }).map((i) => i.question.id).join();
  assert.equal(ids(7), ids(7));
  assert.ok(new Set([1, 2, 3, 4, 5, 6].map(ids)).size >= 5);
});

test('questions jamais vues d\'abord ; quand tout a été vu, la série reste possible', () => {
  const want = ['loi-23-09-art-01-centimes', 'reg-23-01-objet', 'reg-20-01-date', 'reg-26-01-numero', 'assistant-formation'];
  const seen = BANK.map((q) => q.id).filter((id) => !want.includes(id));
  assert.deepEqual(L.pickSession(BANK, { random: seeded(3), seen }).map((i) => i.question.id).sort(), want.slice().sort());
  assert.equal(L.pickSession(BANK, { random: seeded(3), seen: BANK.map((q) => q.id) }).length, 5);
});

test('banque réduite ou vide : seules les questions disponibles sont proposées, jamais de question inventée', () => {
  assert.deepEqual(L.pickSession([], {}), []);
  assert.equal(L.pickSession(BANK.slice(0, 3), { random: seeded(1) }).length, 3);
  assert.equal(L.pickSession(BANK.slice(0, 1), { random: seeded(1) }).length, 1);
});

test('score : bonnes réponses, questions répondues, total', () => {
  const s = L.pickSession(BANK, { random: seeded(11) });
  assert.deepEqual(L.summarize(s, s.map((i) => i.correct)), { correct: 5, answered: 5, total: 5 });
  assert.deepEqual(L.summarize(s, s.map((i) => (i.correct + 1) % i.order.length)), { correct: 0, answered: 5, total: 5 });
  const mix = s.map((i, k) => (k < 3 ? i.correct : (i.correct + 1) % i.order.length)); assert.deepEqual(L.summarize(s, mix), { correct: 3, answered: 5, total: 5 });
  assert.deepEqual(L.summarize(s, [s[0].correct]), { correct: 1, answered: 1, total: 5 }, 'une question laissée sans réponse n\'est pas comptée comme répondue');
  assert.deepEqual(L.summarize([], []), { correct: 0, answered: 0, total: 0 });
});

test('messages de fin : un message par palier, ceux demandés pour 5, 4, 3, 1-2 et 0 sur 5', () => {
  assert.equal(L.message(5, 5), 'Impressionnant ! Vous connaissez vos textes sur le bout des doigts.');
  assert.equal(L.message(4, 5), 'Très bon résultat !');
  assert.equal(L.message(3, 5), 'Pas mal ! Il reste quelques textes à découvrir.');
  assert.equal(L.message(2, 5), 'L\'essentiel, c\'est d\'apprendre quelque chose !');
  assert.equal(L.message(1, 5), 'L\'essentiel, c\'est d\'apprendre quelque chose !');
  assert.equal(L.message(0, 5), 'On vous a peut-être posé des questions trop difficiles cette fois-ci.');
  assert.equal(L.message(0, 0), 'On vous a peut-être posé des questions trop difficiles cette fois-ci.');
});

test('meilleur résultat : conservé localement, jamais écrasé par un moins bon, tolérant au stockage absent ou corrompu', () => {
  const st = new Mem();
  assert.equal(L.loadBest(st), null);
  assert.equal(L.saveBest(3, 5, st), true); assert.deepEqual(L.loadBest(st), { correct: 3, total: 5 });
  assert.equal(L.saveBest(2, 5, st), false); assert.equal(L.saveBest(3, 5, st), false); assert.deepEqual(L.loadBest(st), { correct: 3, total: 5 });
  assert.equal(L.saveBest(5, 5, st), true); assert.deepEqual(L.loadBest(st), { correct: 5, total: 5 });
  st.m['regassist.quiz.best.v1'] = '{"correct":9,"total":5}'; assert.equal(L.loadBest(st), null, 'valeur incohérente ignorée');
  st.m['regassist.quiz.best.v1'] = 'pas du json'; assert.equal(L.loadBest(st), null);
  const broken = { getItem() { throw new Error('stockage bloqué'); }, setItem() { throw new Error('stockage bloqué'); } };
  assert.equal(L.loadBest(broken), null); assert.doesNotThrow(() => L.saveBest(4, 5, broken)); assert.deepEqual(L.loadSeen(broken), []); assert.doesNotThrow(() => L.saveSeen(['a'], broken));
});

test('questions déjà vues : mémorisées sans doublon et bornées', () => {
  const st = new Mem(); L.saveSeen(['a', 'b'], st); L.saveSeen(['b', 'c'], st);
  assert.deepEqual(L.loadSeen(st), ['a', 'b', 'c']);
  L.saveSeen(Array.from({ length: 300 }, (_, i) => 'q' + i), st); assert.equal(L.loadSeen(st).length, 200);
  st.m['regassist.quiz.seen.v1'] = '{"x":1}'; assert.deepEqual(L.loadSeen(st), []);
});

test('aucun code réseau, aucune injection de HTML, aucun script externe dans le quiz et ses données', () => {
  for (const f of ['quiz.js', 'quiz-logic.js', 'quiz-data.js']) {
    const src = read(f);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(|\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|serviceWorker|postMessage/.test(src), f + ' : code réseau ou injection');
    assert.ok(!/(?:src|href)\s*=\s*["']https?:/.test(src.replace(/a\.href = s\.url/g, '')), f + ' : ressource externe');
  }
  assert.ok(!/localStorage\.(?:get|set)Item\([^)]*(?:question|answer|reponse)/i.test(read('quiz.js')), 'jamais de réponse de l\'utilisateur dans le stockage');
});
