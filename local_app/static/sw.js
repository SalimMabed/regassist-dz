/* Service worker : affiche une notification quand le serveur signale qu'une réponse est prête (Web Push), et ouvre le suivi au clic.
   Il n'accède à aucun réseau, ne met rien en cache et ne lit que le message chiffré du serveur (titre, texte court, lien de suivi). */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 80) : 'Votre réponse est disponible !';
  const body = typeof d.body === 'string' && d.body ? d.body.slice(0, 160) : 'Revenez découvrir la réponse à votre question.';
  const url = typeof d.url === 'string' && /^\/#q=[A-Za-z0-9_-]{16,64}$/.test(d.url) ? d.url : '/';
  event.waitUntil(self.registration.showNotification(title, { body, tag: 'regassist-answer', data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ type: 'open-ticket', url }); return c.focus(); }          // une fenêtre du site est déjà ouverte : on la ramène au premier plan
    }
    return self.clients.openWindow(url);
  }));
});
