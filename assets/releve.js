// Relevé des pointages et contrôles du planning : mêmes règles de calcul que la v16 (fonctions pairPunches, dayPairs,
// daySummary, shiftMin, planChecks, exportCsv, exportDetail), transposées aux données du portail.
// Les heures sont calculées à partir des pointages, sans ressaisie. Ce n'est pas un calcul de paie.
(function () {
  'use strict';
  const FUSEAU = 'Europe/Paris';
  const pad = n => String(n).padStart(2, '0');
  const ajouterJours = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const lundi = iso => { const d = new Date(iso + 'T12:00:00Z'); return ajouterJours(iso, -((d.getUTCDay() + 6) % 7)); };
  const toMin = s => { if (!s) return 0; const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const hm5 = t => String(t || '').slice(0, 5);
  const fmtParis = new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = ts => Object.fromEntries(fmtParis.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const hm = ts => { const p = parts(ts); return p.hour + ':' + p.minute; };
  const hms = ts => { const p = parts(ts); return p.hour + ':' + p.minute + ':' + p.second; };
  const jourDe = ts => { const p = parts(ts); return `${p.year}-${p.month}-${p.day}`; };
  // Instant exact d'une heure de Paris un jour donné (jours de 23 h et de 25 h compris).
  // Même règle que la base (PostgreSQL : (jour + heure) at time zone 'Europe/Paris'), pour que l'écran et le serveur
  // calculent les mêmes retards et les mêmes heures prévues :
  //  - heure existante une seule fois : cet instant ;
  //  - heure ambiguë (passage à l'heure d'hiver, 02:00–02:59 deux fois) : la seconde, en heure d'hiver ;
  //  - heure inexistante (passage à l'heure d'été, 02:00–02:59) : lue en heure d'hiver, soit 03:00–03:59 heure d'été.
  const decalage = ts => { const p = parts(ts); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000; };
  function instant(k, hhmm) {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    const mur = Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), h, m || 0);
    // décalages en vigueur autour de ce jour (+1 h et +2 h à Paris), du plus petit au plus grand
    const decs = [...new Set([decalage(mur - 86400e3), decalage(mur), decalage(mur + 86400e3)])].sort((a, b) => a - b);
    for (const d of decs) { const c = mur - d; if (decalage(c) === d) return c; }   // plus petit décalage valable = heure d'hiver
    return mur - decs[0];                                                           // heure inexistante : lue en heure d'hiver
  }
  const fmtH = min => { min = Math.round(min); const s = min < 0 ? '−' : ''; min = Math.abs(min); return s + Math.floor(min / 60) + 'h' + pad(min % 60); };
  const heuresDec = min => (min / 60).toFixed(2).replace('.', ',');
  const fNum = k => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}`; };

  // ---- conversions depuis les tables du portail
  const pointage = (r, corriges) => ({ id: r.id, s: r.salarie_id, t: r.sens === 'entree' ? 'in' : 'out', ts: Date.parse(r.horodatage), date: r.jour,
    deleted: !!r.supprime, manual: r.source === 'dirigeant' || !!(corriges && corriges.has(r.id)), ajoute: r.source === 'dirigeant', orig: corriges && corriges.get ? corriges.get(r.id) : null });
  const creneau = r => ({ id: r.id, s: r.salarie_id, d: r.jour, a: hm5(r.debut), b: hm5(r.fin), p: +r.pause_min || 0, r: r.poste || '', n: r.note || '' });
  const conge = r => ({ s: r.salarie_id, type: r.type, from: r.du, to: r.au, start: r.debut ? hm5(r.debut) : '', end: r.fin ? hm5(r.fin) : '', status: r.statut });

  const shiftSpan = x => { const a = instant(x.d, x.a); let b = instant(x.d, x.b); if (toMin(x.b) <= toMin(x.a)) b = instant(ajouterJours(x.d, 1), x.b); return [a, b]; };
  const shiftMin = x => { const [a, b] = shiftSpan(x); return Math.max(0, Math.round((b - a) / 60000) - (+x.p || 0)); };

  // ---- appariement des pointages (v16) : doublon = même sens à moins de 2 min (le premier fait foi) ; sortie à 16 h au plus
  const DUP_MS = 120e3, LONG_PAIR = 13 * 3600e3;
  function pairPunches(list) {
    const pairs = []; let open = null, prev = null;
    for (const p of list) {
      if (prev && prev.t === p.t && p.ts - prev.ts < DUP_MS) { (prev.dups = prev.dups || []).push(p.id); continue; }
      prev = p;
      if (p.t === 'in') { if (open) pairs.push({ in: open, out: null }); open = p; }
      else { if (open && p.ts - open.ts <= 16 * 3600e3) { pairs.push({ in: open, out: p }); open = null; } else { if (open) { pairs.push({ in: open, out: null }); open = null; } pairs.push({ in: null, out: p }); } }
    }
    if (open) pairs.push({ in: open, out: null });
    return pairs;
  }

  // Contexte de calcul : pointages, créneaux, congés validés (chargés une fois pour la période +/- 1 jour).
  function contexte(punches, shifts, demandes) {
    const parSal = {};
    for (const p of punches) (parSal[p.s] = parSal[p.s] || []).push(p);
    Object.values(parSal).forEach(l => l.sort((a, b) => a.ts - b.ts));
    return { parSal, shifts, demandes };
  }
  const LEAVE_TYPES = ['Congés payés', 'Absence / indisponibilité', 'Récupération'];
  const punchesOf = (ctx, sid, from, to, avecSupprimes) => (ctx.parSal[sid] || []).filter(p => p.date >= from && p.date <= to && (avecSupprimes || !p.deleted));
  const shiftsOf = (ctx, sid, from, to) => ctx.shifts.filter(x => x.s === sid && x.d >= from && x.d <= to).sort((a, b) => (a.d + a.a).localeCompare(b.d + b.a));
  const leaveOn = (ctx, sid, k) => ctx.demandes.find(r => r.s === sid && r.status === 'acceptee' && LEAVE_TYPES.includes(r.type) && r.from <= k && (r.to || r.from) >= k && !r.start) || null;
  function dayPairs(ctx, sid, k) {
    return pairPunches(punchesOf(ctx, sid, ajouterJours(k, -1), ajouterJours(k, 1))).filter(x => x.in ? x.in.date === k : (x.out && x.out.date === k));
  }
  function daySummary(ctx, sid, k) {
    const sh = shiftsOf(ctx, sid, k, k);
    const pairs = dayPairs(ctx, sid, k);
    const worked = pairs.reduce((m, x) => m + (x.in && x.out ? (x.out.ts - x.in.ts) / 60000 : 0), 0);
    const planned = sh.reduce((m, s) => m + shiftMin(s), 0);
    const firstIn = pairs.find(x => x.in);
    let late = 0;
    if (sh.length && firstIn) { const diffs = sh.map(x => Math.round((firstIn.in.ts - instant(k, x.a)) / 60000)); late = diffs.reduce((m, d) => Math.abs(d) < Math.abs(m) ? d : m, diffs[0]); }
    const long = pairs.some(x => x.in && x.out && x.out.ts - x.in.ts > LONG_PAIR);
    const incomplete = pairs.some(x => !x.in || !x.out) || long;
    return { sh, pairs, worked, planned, late, incomplete, long, leave: leaveOn(ctx, sid, k) };
  }
  // Synthèse d'une période par salarié (tableau « Synthèse » et export) : jours, prévu, pointé, écart, retards, à vérifier.
  function synthese(ctx, salaries, from, to, tolerance) {
    const lignes = [], sommes = [];
    for (const s of salaries) {
      let P = 0, W = 0, L = 0, I = 0, n = 0;
      for (let k = from; k <= to; k = ajouterJours(k, 1)) {
        const sm = daySummary(ctx, s.id, k);
        if (!sm.sh.length && !sm.pairs.length) continue; n++;
        P += sm.planned; W += sm.worked; if (sm.late > tolerance) L++; if (sm.incomplete) I++;
        lignes.push({ s, k, sm });
      }
      if (n || (s.actif !== false)) sommes.push({ s, P, W, L, I, n });
    }
    lignes.sort((a, b) => b.k.localeCompare(a.k) || (a.s.prenom || '').localeCompare(b.s.prenom || '', 'fr'));
    return { lignes, sommes };
  }
  // Semaines du lundi au dimanche (totaux hebdomadaires par salarié).
  function semaines(ctx, s, from, to) {
    const out = []; let w = lundi(from);
    for (; w <= to; w = ajouterJours(w, 7)) {
      let P = 0, W = 0;
      for (let i = 0; i < 7; i++) { const k = ajouterJours(w, i); if (k < from || k > to) continue; const sm = daySummary(ctx, s.id, k); P += sm.planned; W += sm.worked; }
      out.push({ lundi: w, P, W });
    }
    return out;
  }

  // ---- exports CSV (mêmes colonnes que la v16)
  const csvCell = x => { let v = String(x ?? ''); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+([.,]\d+)?$/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
  function telecharger(nom, lignes) {
    const data = '﻿' + lignes.join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' })); a.download = nom;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return data;
  }
  const nomSal = s => `${s.prenom || ''} ${s.nom || ''}`.trim();
  function csvSynthese(ctx, salaries, from, to, tolerance) {
    const lines = [['Date', 'Salarié', 'Poste', 'Prévu', 'Heures prévues', 'Arrivée', 'Départ', 'Heures pointées', 'Écart', 'Retard (min)', 'Statut'].join(';')];
    for (const s of salaries) {
      let tp = 0, tw = 0;
      for (let k = from; k <= to; k = ajouterJours(k, 1)) {
        const sm = daySummary(ctx, s.id, k); if (!sm.sh.length && !sm.pairs.length) continue;
        const fi = sm.pairs.find(x => x.in), lo = [...sm.pairs].reverse().find(x => x.out);
        tp += sm.planned; tw += sm.worked;
        lines.push([fNum(k), nomSal(s) + (s.actif === false ? ' (archivé)' : ''), s.poste || '', sm.sh.map(x => x.a + '-' + x.b).join(' / '), heuresDec(sm.planned),
          fi ? hm(fi.in.ts) : '', lo ? hm(lo.out.ts) : '', heuresDec(sm.worked), heuresDec(sm.worked - sm.planned), sm.late > tolerance ? sm.late : '',
          sm.leave ? sm.leave.type : sm.incomplete ? (sm.long ? 'Durée anormale - à vérifier' : 'Incomplet - à vérifier') : !sm.pairs.length ? 'Absent' : 'OK'].map(csvCell).join(';'));
      }
      if (tp || tw) lines.push(['TOTAL', nomSal(s), '', '', heuresDec(tp), '', '', heuresDec(tw), heuresDec(tw - tp), '', ''].map(csvCell).join(';'));
    }
    return lines;
  }
  function csvDetail(ctx, salaries, from, to, motifs) {
    const lines = [['Date', 'Salarié', 'Type', 'Heure', 'Origine', 'Heure d\'origine', 'Supprimé', 'Motif', 'Heure vérifiée'].map(csvCell).join(';')];
    for (const s of salaries) {
      let wk = null, wt = 0;
      const flush = () => { if (wk) lines.push([`Semaine du ${fNum(wk)}`, nomSal(s), 'TOTAL semaine', heuresDec(wt), '', '', '', '', ''].map(csvCell).join(';')); wt = 0; };
      for (let k = from; k <= to; k = ajouterJours(k, 1)) {
        if (lundi(k) !== wk) { flush(); wk = lundi(k); }
        wt += daySummary(ctx, s.id, k).worked;
        for (const p of punchesOf(ctx, s.id, k, k, true))
          lines.push([fNum(k), nomSal(s), p.t === 'in' ? 'Entrée' : 'Sortie', hms(p.ts), p.ajoute ? 'ajouté' : p.manual ? 'corrigé' : 'pointeuse', p.orig ? hms(p.orig) : '',
            p.deleted ? 'oui' : '', (motifs && motifs[p.id]) || '', p.ajoute ? '' : 'oui'].map(csvCell).join(';'));
      }
      flush();
    }
    return lines;
  }

  // ---- contrôles du planning (règles HCR de la v16, niveaux réglables : interdiction ou avertissement)
  const RULES = {
    leave: { label: 'Créneau pendant un congé validé', def: 'bad' },
    overlap: { label: 'Créneaux qui se chevauchent', def: 'bad' },
    maxDay: { label: 'Durée maximale par jour (11 h cuisine / 11 h 30 autres)', def: 'bad' },
    amplitude: { label: 'Amplitude de plus de 13 h', def: 'bad' },
    rest11: { label: 'Moins de 11 h de repos entre deux jours', def: 'bad' },
    week48: { label: 'Plus de 48 h dans la semaine', def: 'bad' },
    days7: { label: '7 jours travaillés dans la semaine', def: 'bad' },
    days2: { label: 'Un seul jour de repos dans la semaine', def: 'warn' },
    pause: { label: 'Créneau de plus de 6 h sans pause de 20 min', def: 'warn' },
    contract: { label: 'Heures prévues au-delà du contrat, ou plus de 4 h en dessous', def: 'warn' }
  };
  const isKitchen = s => /cuisin|pizza/i.test((s && s.poste) || '');
  const dc = k => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(k + 'T12:00:00Z'));
  // items : créneaux de la semaine ; autour : créneaux de la veille du lundi et du lundi suivant (repos de 11 h).
  function planChecks(items, w, salaries, demandes, niveaux, autour, opt) {
    opt = opt || {};
    const level = k => { const v = (niveaux || {})[k]; return v === 'bad' || v === 'warn' ? v : RULES[k].def; };
    const ctx = { demandes };
    const res = []; const days = [...Array(7)].map((_, i) => ajouterJours(w, i));
    for (const s of salaries) {
      const n = s.prenom; const mine = items.filter(x => x.s === s.id && !x.deleted);
      const add = (r, t) => res.push({ r, l: level(r), t, s: s.id });
      const maxDay = isKitchen(s) ? 660 : 690; let tot = 0; const worked = new Set();
      for (const d of days) {
        const ds = mine.filter(x => x.d === d); if (!ds.length) continue; worked.add(d);
        const lv = leaveOn(ctx, s.id, d); if (lv) add('leave', `${n} est prévu le ${dc(d)} alors qu'il est en ${lv.type.toLowerCase()}`);
        const dm = ds.reduce((m, x) => m + shiftMin(x), 0); tot += dm;
        if (dm > maxDay) add('maxDay', `${n} : ${fmtH(dm)} de travail le ${dc(d)} (maximum ${fmtH(maxDay)})`);
        const r = ds.map(shiftSpan).sort((a, b) => a[0] - b[0]);
        if (r[r.length - 1][1] - r[0][0] > 13 * 3600e3) add('amplitude', `${n} : amplitude de plus de 13 h le ${dc(d)}`);
        for (let i = 1; i < r.length; i++) if (r[i][0] < r[i - 1][1]) add('overlap', `${n} : deux créneaux se chevauchent le ${dc(d)}`);
        for (const x of ds) { const [a, b] = shiftSpan(x); if (b - a > 360 * 60e3 && (+x.p || 0) < 20) add('pause', `${n} : créneau de plus de 6 h le ${dc(d)} sans pause de 20 min`); }
      }
      const all = [...mine, ...(autour || []).filter(x => x.s === s.id)]; const byDay = {};
      for (const x of all) { (byDay[x.d] = byDay[x.d] || []).push(shiftSpan(x)); }
      const dl = Object.keys(byDay).sort();
      for (let i = 1; i < dl.length; i++) {
        if (ajouterJours(dl[i - 1], 1) !== dl[i]) continue;
        const end = Math.max(...byDay[dl[i - 1]].map(r => r[1])), start = Math.min(...byDay[dl[i]].map(r => r[0]));
        if (start - end < 11 * 3600e3) add('rest11', `${n} : moins de 11 h de repos entre le ${dc(dl[i - 1])} et le ${dc(dl[i])}`);
      }
      const off = 7 - worked.size;
      if (mine.length && off < 1) add('days7', `${n} travaille les 7 jours de la semaine`);
      else if (mine.length && off < 2) add('days2', `${n} n'a qu'un jour de repos (la convention HCR en prévoit 2, 1,5 au minimum)`);
      if (tot > 48 * 60) add('week48', `${n} : ${fmtH(tot)} sur la semaine (maximum 48 h)`);
      const c = (+s.contrat_heures || 0) * 60;
      if (c && (mine.length || opt.contractEmpty)) {
        if (tot > c) add('contract', `${n} : ${fmtH(tot)} prévues pour un contrat de ${+s.contrat_heures} h, soit ${fmtH(tot - c)} ${(+s.contrat_heures) < 35 ? "d'heures complémentaires (temps partiel)" : 'au-delà du contrat'}`);
        else if (c - tot > 240) add('contract', `${n} : ${fmtH(tot)} prévues pour un contrat de ${+s.contrat_heures} h`);
      }
    }
    res.forEach(r => { if (!r.t.endsWith('.')) r.t += '.'; });
    return res.sort((a, b) => (a.l === 'bad' ? 0 : 1) - (b.l === 'bad' ? 0 : 1));
  }
  const plannedHours = (items, w) => { const days = new Set([...Array(7)].map((_, i) => ajouterJours(w, i))); const m = {}; for (const x of items) { if (x.deleted || !days.has(x.d)) continue; m[x.s] = (m[x.s] || 0) + shiftMin(x); } return m; };

  window.R = { pad, ajouterJours, lundi, toMin, hm, hms, jourDe, instant, fmtH, heuresDec, fNum, pointage, creneau, conge, shiftSpan, shiftMin,
    pairPunches, contexte, punchesOf, shiftsOf, leaveOn, dayPairs, daySummary, synthese, semaines, csvCell, telecharger, csvSynthese, csvDetail,
    RULES, planChecks, plannedHours, LEAVE_TYPES, LONG_PAIR };
})();
