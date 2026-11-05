// Réglages de CETTE installation (un fichier par établissement). Aucune donnée secrète :
// l'adresse du projet et la clé publique sont faites pour être dans le navigateur ;
// les droits sont vérifiés par la base de données.
window.CONFIG = {
  projet: 'kdfaingdiijpcxcrkchw',                         // projet Supabase de DÉVELOPPEMENT (données fictives)
  urlProjet: 'https://kdfaingdiijpcxcrkchw.supabase.co',
  clePublique: 'sb_publishable_6xacaOVtMR9tRnwAXO2U7A_XTk3lbyy',
  nomParDefaut: 'Portail de pointage (essai)',             // affiché avant la connexion
  couleurParDefaut: '#8a6a43',
  dossierJustificatifs: 'justificatifs',
  inactiviteMinutes: 30,                                   // déconnexion automatique sans activité (espaces dirigeant et salarié)
  environnement: 'essai'                                   // 'essai' affiche un bandeau « données fictives »
};
