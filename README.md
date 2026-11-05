# Portail de pointage — version d'essai

Portail web (pages statiques) d'une installation de pointeuse : connexion, espace salarié, espace dirigeant,
pointeuse sur tablette. Les données sont dans un projet Supabase ; ce dépôt ne contient **aucun secret** :
l'adresse du projet et la clé publique de `assets/config.js` sont faites pour être dans le navigateur, et tous
les droits sont vérifiés par la base de données (règles par ligne).

**Version d'essai : branchée sur un projet de développement avec des données fictives uniquement.**

| Page | Rôle |
|---|---|
| `index.html` | connexion, puis orientation selon le rôle |
| `activer.html` | activation du compte ou nouveau mot de passe (lien à usage unique) |
| `oubli.html` | demande de lien « mot de passe oublié » par e-mail |
| `salarie.html` | planning publié, pointages et heures, notifications, demandes, informations |
| `dirigeant.html` | pointages et corrections avec motif, équipe et accès, journal |
| `pointeuse.html` | borne de pointage (compte « tablette ») |
