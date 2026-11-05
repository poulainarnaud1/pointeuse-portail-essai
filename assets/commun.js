// Outils communs aux pages du portail.
(function () {
  'use strict';
  const C = window.CONFIG;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const FUSEAU = 'Europe/Paris';

  // Dates et heures toujours affichées à l'heure de Paris, quel que soit l'appareil.
  const fmt = (o) => new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, ...o });
  const jourCivil = d => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('/').reverse().join('-');
  const heure = d => fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  const dateLongue = iso => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso + 'T12:00:00Z'));
  const dateCourte = iso => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso + 'T12:00:00Z'));
  const ajouterJours = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const lundi = iso => { const d = new Date(iso + 'T12:00:00Z'); const j = (d.getUTCDay() + 6) % 7; return ajouterJours(iso, -j); };
  const aujourdhui = () => jourCivil(new Date());
  const hm = t => String(t || '').slice(0, 5);
  const duree = min => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h + ' h ' + String(m).padStart(2, '0'); };

  // Messages d'erreur compréhensibles.
  const MESSAGES = {
    invalid_credentials: 'Adresse e-mail ou mot de passe incorrect.',
    'Invalid login credentials': 'Adresse e-mail ou mot de passe incorrect.',
    user_banned: 'Ce compte est désactivé. Adressez-vous à votre responsable.',
    otp_expired: 'Ce lien a expiré ou a déjà servi. Demandez-en un nouveau.',
    weak_password: 'Mot de passe trop faible : au moins 10 caractères, avec lettres et chiffres.',
    same_password: 'Le nouveau mot de passe doit être différent de l’ancien.',
    over_email_send_rate_limit: 'Trop de demandes : réessayez dans quelques minutes.',
    reseau: 'Connexion impossible : vérifiez le réseau.',
    non_connecte: 'Session expirée : reconnectez-vous.',
    acces_refuse: 'Action non autorisée pour votre compte.'
  };
  const messageErreur = e => MESSAGES[e && e.code] || MESSAGES[e && e.message] || ((e && e.message) ? String(e.message) : 'Une erreur est survenue.');

  function toast(t) {
    const d = document.createElement('div'); d.className = 'toast'; d.setAttribute('role', 'status'); d.textContent = t;
    document.body.appendChild(d); setTimeout(() => d.remove(), 3500);
  }
  function bandeauEssai() {
    if (C.environnement === 'essai' && !$('.essai')) {
      const b = document.createElement('div'); b.className = 'essai'; b.textContent = 'Version d’essai — données fictives uniquement';
      document.body.prepend(b);
    }
  }

  // Identité de l'établissement (nom, couleur, logo) appliquée à la page.
  function appliquerIdentite(etab) {
    const r = (etab && etab.reglages) || {};
    const couleur = /^#[0-9a-f]{6}$/i.test(r.couleur || '') ? r.couleur : C.couleurParDefaut;
    document.documentElement.style.setProperty('--accent', couleur);
    if (etab && etab.nom) document.title = etab.nom + ' — ' + document.title.split(' — ').pop();
  }

  // Mot de passe : règles vérifiées aussi côté serveur (réglage d'authentification).
  function controleMotDePasse(a, b) {
    if (a.length < 10) return 'Au moins 10 caractères.';
    if (!/[a-zA-Z]/.test(a) || !/[0-9]/.test(a)) return 'Mélangez lettres et chiffres.';
    if (a !== b) return 'Les deux saisies ne sont pas identiques.';
    return '';
  }

  // Garde d'accès : renvoie { user, membre, etab } ou redirige vers la connexion.
  async function garde(rolesAutorises) {
    bandeauEssai();
    if (!sb.session) { location.replace('index.html'); return null; }
    let membres;
    try { await sb.moi(); membres = await sb.lire('membres', { select: 'id,etab_id,role,salarie_id,actif', user_id: 'eq.' + sb.utilisateur.id, actif: 'eq.true' }); }
    catch (e) { await sb.deconnexion(); location.replace('index.html?raison=session'); return null; }
    const membre = membres.find(m => rolesAutorises.includes(m.role));
    if (!membre) { location.replace('index.html?raison=role'); return null; }
    const [etab] = await sb.lire('etablissements', { select: 'id,nom,reglages', id: 'eq.' + membre.etab_id });
    appliquerIdentite(etab);
    suivreErreurs();
    if (membre.role !== 'tablette') surveillerInactivite();
    return { user: sb.utilisateur, membre, etab };
  }

  // Suivi des erreurs : les erreurs imprévues de la page sont signalées au serveur (page + message court, sans données
  // saisies) et apparaissent au dirigeant dans Réglages > État du service. 5 envois au plus par page ouverte.
  function suivreErreurs() {
    let restant = 5;
    const page = location.pathname.split('/').pop() || 'index.html';
    const envoyer = m => { if (restant-- > 0 && sb.session) sb.rpc('signaler_erreur', { p_page: page, p_message: String(m).slice(0, 300) }).catch(() => {}); };
    addEventListener('error', e => envoyer((e.message || 'erreur') + (e.lineno ? ' (ligne ' + e.lineno + ')' : '')));
    addEventListener('unhandledrejection', e => envoyer('promesse rejetée : ' + ((e.reason && e.reason.message) || e.reason)));
  }

  // Déconnexion automatique après une période sans activité.
  function surveillerInactivite() {
    const limite = (C.inactiviteMinutes || 30) * 60000;
    const cle = 'portail.activite.' + C.projet;
    const marquer = () => { try { localStorage.setItem(cle, String(Date.now())); } catch (e) { /* */ } };
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(ev => addEventListener(ev, marquer, { passive: true }));
    marquer();
    setInterval(async () => {
      let derniere = Date.now(); try { derniere = Number(localStorage.getItem(cle)) || Date.now(); } catch (e) { /* */ }
      if (Date.now() - derniere > limite) { await sb.deconnexion(); location.replace('index.html?raison=inactivite'); }
    }, 30000);
  }

  // Heures calculées à partir des pointages (entrée -> sortie suivante, même passé minuit, 16 h au plus).
  // Ce n'est pas un calcul de paie : aucune majoration, heure supplémentaire ou complémentaire.
  function heuresParJour(pointages) {
    const tri = pointages.filter(p => !p.supprime).slice().sort((a, b) => new Date(a.horodatage) - new Date(b.horodatage));
    const jours = {}; const incomplets = [];
    for (let i = 0; i < tri.length; i++) {
      const p = tri[i];
      if (p.sens !== 'entree') { incomplets.push(p); continue; }
      const s = tri[i + 1];
      const ecart = s ? (new Date(s.horodatage) - new Date(p.horodatage)) / 60000 : null;
      if (s && s.sens === 'sortie' && ecart <= 16 * 60) {
        (jours[p.jour] = jours[p.jour] || { minutes: 0, paires: [] }).minutes += ecart;
        jours[p.jour].paires.push([p, s]); i++;
      } else incomplets.push(p);
    }
    return { jours, incomplets };
  }


  // Petit formulaire dans la page (remplace les fenêtres du navigateur). champs : [{id, label, type, valeur, options, requis, aide}]
  function formulaire(titre, champs, bouton, texte) {
    return new Promise(resolve => {
      const fond = document.createElement('div');
      fond.className = 'fond-modal';
      fond.innerHTML = `<form class="carte modal pile" role="dialog" aria-modal="true" aria-label="${esc(titre)}">
        <h2 style="margin:0">${esc(titre)}</h2>${texte ? `<p class="doux petit" style="margin:0">${esc(texte)}</p>` : ''}
        ${champs.map(c => c.type === 'select'
          ? `<label class="champ">${esc(c.label)}<select name="${c.id}">${c.options.map(o => `<option value="${esc(o[0])}" ${o[0] === c.valeur ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`
          : c.type === 'textarea'
          ? `<label class="champ">${esc(c.label)}<textarea name="${c.id}" ${c.requis ? 'required' : ''}>${esc(c.valeur || '')}</textarea></label>`
          : c.type === 'checkbox'
          ? `<label class="ligne petit"><input type="checkbox" name="${c.id}" ${c.valeur ? 'checked' : ''}> ${esc(c.label)}</label>`
          : `<label class="champ">${esc(c.label)}<input type="${c.type || 'text'}" name="${c.id}" value="${esc(c.valeur ?? '')}" ${c.requis ? 'required' : ''} ${c.attr || ''}></label>`).join('')}
        ${champs.filter(c => c.aide).map(c => `<p class="doux petit" style="margin:0">${esc(c.aide)}</p>`).join('')}
        <div class="message erreur cache" data-err></div>
        <div class="ligne"><button class="bouton" type="submit">${esc(bouton || 'Valider')}</button><button class="bouton discret" type="button" data-annuler>Annuler</button></div></form>`;
      document.body.appendChild(fond);
      const f = fond.querySelector('form');
      const fermer = v => { fond.remove(); resolve(v); };
      fond.querySelector('[data-annuler]').onclick = () => fermer(null);
      fond.addEventListener('keydown', e => { if (e.key === 'Escape') fermer(null); });
      f.onsubmit = e => {
        e.preventDefault();
        const v = {};
        for (const c of champs) { const el = f.elements[c.id]; v[c.id] = c.type === 'checkbox' ? el.checked : el.value.trim(); }
        const manque = champs.find(c => c.requis && !v[c.id]);
        if (manque) { const m = f.querySelector('[data-err]'); m.textContent = 'Champ obligatoire : ' + manque.label; m.classList.remove('cache'); return; }
        fermer(v);
      };
      const premier = f.querySelector('input,select,textarea'); if (premier) premier.focus();
    });
  }

  window.P = { $, esc, fmt, jourCivil, heure, dateLongue, dateCourte, ajouterJours, lundi, aujourdhui, hm, duree,
    messageErreur, toast, bandeauEssai, appliquerIdentite, controleMotDePasse, garde, heuresParJour, formulaire };
})();
