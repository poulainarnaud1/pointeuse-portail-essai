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

  async function brut(chemin, options) {
    try { return await fetch(C.urlProjet + chemin, options); }
    catch (e) { throw new ErreurSb(0, 'reseau', 'Connexion impossible : vérifiez le réseau.'); }
  }
  // Rétablit l'ordre demandé à PostgREST (« col.asc,col2.desc.nullslast ») sur des lignes lues par clé.
  // Dates et heures ISO : ordre des caractères (identique à la base) ; textes : ordre alphabétique français.
  function trier(lignes, ordre) {
    const regles = String(ordre || '').split(',').filter(Boolean).map(o => { const [c, ...m] = o.split('.'); const desc = m.includes('desc');
      return { c, desc, nullsPremiers: m.includes('nullsfirst') || (desc && !m.includes('nullslast')) }; });
    if (!regles.length) return lignes;
    const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\d|^\d\d:\d\d/.test(v);
    const cmp = (a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : iso(a) && iso(b) ? (a < b ? -1 : a > b ? 1 : 0)
      : typeof a === 'boolean' ? (a === b ? 0 : a ? 1 : -1) : String(a).localeCompare(String(b), 'fr');
    return lignes.sort((x, y) => {
      for (const r of regles) {
        const a = x[r.c], b = y[r.c];
        if (a == null || b == null) { if (a == null && b == null) continue; return (a == null) === r.nullsPremiers ? -1 : 1; }
        const d = cmp(a, b); if (d) return r.desc ? -d : d;
      }
      return 0;
    });
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

  // Lecture par pages : taille demandée par page, et clé de tri qui départage les égalités pour chaque table.
  const PAGE = 1000;
  const CLES_TRI = { messages_lus: 'message_id,salarie_id', semaines: 'etab_id,lundi', codes_pointage: 'salarie_id' };

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
    // Lecture COMPLÈTE, par pages. Le serveur renvoie au plus un nombre limité de lignes par réponse (1 000 par défaut
    // chez Supabase) : demander « limit=20000 » ne garantit rien. Les pages sont lues « par clé » (identifiant
    // immuable : id > dernier id lu), si bien qu'un pointage ajouté ou corrigé pendant la lecture ne décale pas les
    // pages. À la fin, les lignes sont recomptées (sans doublon) et comparées au total compté par le serveur :
    // en cas d'écart, la lecture est refaite (3 essais), puis refusée (erreur « lecture_incomplete ») plutôt que de
    // présenter un relevé ou un export tronqué comme complet. L'ordre demandé (« order ») est rétabli ensuite.
    // Avec un paramètre « limit », la lecture est volontairement partielle (ex. les 500 dernières entrées).
    async lire(table, params) {
      const p = { ...(params || {}) };
      if (p.limit) return appel('/rest/v1/' + table + '?' + new URLSearchParams(p).toString(), { headers: await entetes() });
      const ordre = p.order || ''; delete p.order;
      const cle = CLES_TRI[table];                                   // tables sans identifiant unique « id »
      if (!cle && p.select && p.select !== '*' && !p.select.split(',').includes('id')) p.select += ',id';
      const compter = async () => {
        const r = await brut('/rest/v1/' + table + '?' + new URLSearchParams({ ...p, select: cle ? cle.split(',')[0] : 'id' }).toString(),
          { method: 'HEAD', headers: await entetes({ Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }) });
        const t = Number((r.headers.get('Content-Range') || '').split('/')[1]);
        if (!r.ok && r.status !== 416) throw new ErreurSb(r.status, 'lecture', 'Lecture impossible (' + table + ').');
        if (!Number.isFinite(t)) throw new ErreurSb(0, 'lecture_incomplete', 'Le serveur n’a pas indiqué le nombre de lignes (' + table + ') : lecture refusée.');
        return t;
      };
      const ident = x => cle ? cle.split(',').map(c => x[c]).join('|') : x.id;
      for (let essai = 1; essai <= 3; essai++) {
        const avant = await compter();
        const lignes = []; let dernier = null;
        for (let n = 0; n < 100000; n++) {
          const q = new URLSearchParams(p);
          if (cle) q.set('order', cle);                               // petites tables : par décalage, sur une clé stable
          else { q.set('order', 'id'); if (dernier !== null) q.append('id', 'gt.' + dernier); }
          const debut = cle ? lignes.length : 0;
          const r = await brut('/rest/v1/' + table + '?' + q.toString(), { headers: await entetes({ 'Range-Unit': 'items', Range: debut + '-' + (debut + PAGE - 1) }) });
          if (r.status === 416) break;
          const page = await lire(r);
          if (!Array.isArray(page)) throw new ErreurSb(0, 'lecture_incomplete', 'Réponse inattendue du serveur (' + table + ').');
          if (!page.length) break;
          lignes.push(...page);
          if (!cle) dernier = page[page.length - 1].id;
        }
        const uniques = new Set(lignes.map(ident)).size;
        const apres = await compter();
        if (uniques === lignes.length && lignes.length === apres && apres === avant) return trier(lignes, ordre);
        // des lignes ont été ajoutées ou retirées pendant la lecture : on relit tout
      }
      throw new ErreurSb(0, 'lecture_incomplete', 'Lecture incomplète des données (' + table + ') : les totaux et exports ne sont pas affichés. Réessayez dans un instant.');
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
    // Espace « justificatifs » par défaut ; « photos » pour les photos de pointage.
    async deposer(chemin, fichier, espace) {
      return appel('/storage/v1/object/' + (espace || C.dossierJustificatifs) + '/' + chemin, {
        method: 'POST', headers: await entetes({ 'Content-Type': fichier.type || 'application/octet-stream', 'x-upsert': 'false' }), body: fichier
      });
    },
    async lienTemporaire(chemin, secondes, espace) {
      const d = await appel('/storage/v1/object/sign/' + (espace || C.dossierJustificatifs) + '/' + chemin, {
        method: 'POST', headers: await entetes({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: secondes || 300 })
      });
      return C.urlProjet + '/storage/v1' + d.signedURL;
    }
  };
  window.sb = sb;
})();
