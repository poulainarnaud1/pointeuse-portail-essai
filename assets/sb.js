// Client minimal pour Supabase (authentification, base, fonctions, fichiers), sans dépendance extérieure.
// Seule la clé PUBLIQUE du projet est utilisée ici : tous les droits sont vérifiés par la base (règles par ligne).
(function () {
  'use strict';
  const C = window.CONFIG;
  const CLE_SESSION = 'portail.session.' + C.projet;
  const H = { apikey: C.clePublique };

  let session = null;
  try { session = JSON.parse(localStorage.getItem(CLE_SESSION) || 'null'); } catch (e) { session = null; }

  function enregistrer(s) {
    session = s;
    try { s ? localStorage.setItem(CLE_SESSION, JSON.stringify(s)) : localStorage.removeItem(CLE_SESSION); } catch (e) { /* navigation privée */ }
  }
  function avecExpiration(d) {
    return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: d.user };
  }

  class ErreurSb extends Error {
    constructor(statut, code, message) { super(message || code || ('Erreur ' + statut)); this.statut = statut; this.code = code; }
  }

  async function lire(r) {
    const t = await r.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
    if (!r.ok) {
      const code = (d && (d.error_code || d.code || d.erreur || d.error)) || String(r.status);
      const msg = (d && (d.msg || d.message || d.error_description || d.detail || d.erreur)) || t;
      throw new ErreurSb(r.status, code, msg);
    }
    return d;
  }

  async function appel(chemin, options = {}) {
    let r;
    try { r = await fetch(C.urlProjet + chemin, options); }
    catch (e) { throw new ErreurSb(0, 'reseau', 'Connexion impossible : vérifiez le réseau.'); }
    return lire(r);
  }

  let renouvellement = null;
  async function jeton() {
    if (!session) return null;
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    if (!renouvellement) {
      renouvellement = appel('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      }).then(d => { enregistrer(avecExpiration(d)); return session.access_token; })
        .catch(e => { if (e.statut && e.statut < 500) enregistrer(null); throw e; })
        .finally(() => { renouvellement = null; });
    }
    return renouvellement;
  }
  async function entetes(extra) {
    const t = await jeton();
    if (!t) throw new ErreurSb(401, 'non_connecte', 'Session expirée : reconnectez-vous.');
    return { ...H, Authorization: 'Bearer ' + t, ...(extra || {}) };
  }

  const sb = {
    ErreurSb,
    get session() { return session; },
    get utilisateur() { return session && session.user; },

    async connexion(email, motDePasse) {
      const d = await appel('/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email).trim(), password: motDePasse })
      });
      enregistrer(avecExpiration(d));
      return d.user;
    },
    async deconnexion(partout) {
      try { if (session) await fetch(C.urlProjet + '/auth/v1/logout' + (partout ? '?scope=global' : ''), { method: 'POST', headers: await entetes() }); }
      catch (e) { /* la session locale est effacée de toute façon */ }
      enregistrer(null);
    },
    // Lien d'activation ou de réinitialisation : jeton à usage unique dans l'adresse.
    async verifierJeton(tokenHash, type) {
      const d = await appel('/auth/v1/verify', {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_hash: tokenHash, type })
      });
      enregistrer(avecExpiration(d));
      return d.user;
    },
    // Session transmise par le lien de l'e-mail Supabase (fragment #access_token=…).
    sessionDepuisAdresse() {
      const f = new URLSearchParams(location.hash.slice(1));
      if (!f.get('access_token')) return false;
      enregistrer({ access_token: f.get('access_token'), refresh_token: f.get('refresh_token'),
        expires_at: Number(f.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(f.get('expires_in') || 3600), user: null });
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    },
    async demanderReinitialisation(email, retour) {
      return appel('/auth/v1/recover?redirect_to=' + encodeURIComponent(retour), {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: String(email).trim() })
      });
    },
    async changerMotDePasse(motDePasse) {
      const d = await appel('/auth/v1/user', { method: 'PUT', headers: await entetes({ 'Content-Type': 'application/json' }), body: JSON.stringify({ password: motDePasse }) });
      if (session) enregistrer({ ...session, user: d });
      return d;
    },
    async moi() {
      const d = await appel('/auth/v1/user', { headers: await entetes() });
      if (session) enregistrer({ ...session, user: d });
      return d;
    },

    // Base : lecture (paramètres PostgREST), ajout, modification, appel de fonction.
    async lire(table, params) {
      return appel('/rest/v1/' + table + '?' + new URLSearchParams(params || {}).toString(), { headers: await entetes() });
    },
    async ajouter(table, ligne) {
      return appel('/rest/v1/' + table, { method: 'POST', headers: await entetes({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(ligne) });
    },
    async modifier(table, filtre, valeurs) {
      return appel('/rest/v1/' + table + '?' + new URLSearchParams(filtre).toString(), { method: 'PATCH', headers: await entetes({ 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(valeurs) });
    },
    async rpc(fonction, args) {
      return appel('/rest/v1/rpc/' + fonction, { method: 'POST', headers: await entetes({ 'Content-Type': 'application/json' }), body: JSON.stringify(args || {}) });
    },
    async fonction(nom, corps) {
      return appel('/functions/v1/' + nom, { method: 'POST', headers: await entetes({ 'Content-Type': 'application/json' }), body: JSON.stringify(corps || {}) });
    },

    // Fichiers privés : dépôt et lien de lecture temporaire (quelques minutes).
    async deposer(chemin, fichier) {
      return appel('/storage/v1/object/' + C.dossierJustificatifs + '/' + chemin, {
        method: 'POST', headers: await entetes({ 'Content-Type': fichier.type || 'application/octet-stream', 'x-upsert': 'false' }), body: fichier
      });
    },
    async lienTemporaire(chemin, secondes) {
      const d = await appel('/storage/v1/object/sign/' + C.dossierJustificatifs + '/' + chemin, {
        method: 'POST', headers: await entetes({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: secondes || 300 })
      });
      return C.urlProjet + '/storage/v1' + d.signedURL;
    }
  };
  window.sb = sb;
})();
