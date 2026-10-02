# Quiz Drapeaux

Bot Discord de quiz en français : drapeaux, culture générale, réponses rapides et classement persistant. Les panneaux de questions et les retours du bot utilisent Discord Components V2.

## Prérequis

- Node.js 20.18 ou plus récent
- Une application et un bot créés dans le [portail développeur Discord](https://discord.com/developers/applications)
- Active `MESSAGE CONTENT INTENT` dans **Bot > Privileged Gateway Intents** pour permettre au bot de lire les réponses écrites.

## Installation

1. Dans le portail Discord, crée l'application, ouvre **Bot**, crée le bot et copie son token. Ne partage jamais ce token.
2. Dans **OAuth2 > URL Generator**, coche les scopes `bot` et `applications.commands`. Dans les permissions du bot, coche **View Channels**, **Send Messages** et **Manage Roles** (pour le rôle du podium). Ouvre le lien généré pour inviter le bot sur ton serveur.
3. Crée un fichier `.env` à la racine, puis renseigne `DISCORD_TOKEN` et `DISCORD_CLIENT_ID` (l'ID de l'application se trouve dans **General Information**).
4. Dans un terminal ouvert dans ce dossier, exécute :

   ```powershell
   npm install
   npm start
   ```

Les commandes slash sont synchronisées automatiquement au démarrage. Renseigne `DISCORD_GUILD_ID` dans `.env` pour les rendre disponibles presque immédiatement sur un serveur précis ; sans cet ID, elles sont enregistrées globalement et leur propagation peut prendre un peu de temps.

## Commandes

- `/set score quiz salon:#quiz` : (permission **Gérer le serveur**) crée ou déplace uniquement le panneau du classement quiz.
- `/set score message salon:#messages` : configure le salon indépendant du Top 10 des messages.
- `/set score vocal salon:#vocal` : configure le salon indépendant du Top 10 vocal.
- `/set quiz automatique salon:#discussion` : choisit séparément le salon où le bot pose une question de drapeau chaque heure.
- `/quiz demarrer theme:drapeaux|culture|mixte questions:5` : lance une partie dans le salon. Le nombre de questions peut aller de 1 à 20.
- `/quiz arreter` : arrête la partie du salon.
- `/quiz scores` : affiche le Top 10 des points gagnés depuis lundi à 00h.
- `.leaderboard` : affiche les Top 10 Quiz, Messages et Vocal. Le menu permet de consulter 7, 14 ou 28 jours.
- `.leaderboard @role` : configure le rôle cosmétique commun des membres du Top 3 de chaque classement. Le rôle doit être sans permissions et gérable par le bot; le bot l’affiche en haut de la liste des rôles.
- `.help` : affiche les commandes et fonctions disponibles sur le serveur.
- `.config` : fait quitter le bot du serveur ; nécessite la permission **Gérer le serveur**.
- `.dev` : active ou désactive le mode développeur, réservé à l'ID propriétaire `226447179877842944`. Quand il est activé, les autres utilisateurs ne peuvent plus utiliser les commandes ni répondre aux quiz.

Les joueurs répondent en écrivant dans le salon. Le premier à trouver gagne 15 points en moins de 4 secondes, 10 points en moins de 7 secondes, sinon 5 points. Chaque question reste ouverte 20 secondes ; sans bonne réponse, la question et la solution sont supprimées après 5 secondes. Les trois classements fixes repartent à zéro chaque lundi à 00h, heure de Paris. Les historiques 7/14/28 jours se remplissent à partir du déploiement de cette fonction.

Un quiz automatique d'un drapeau est lancé toutes les heures dans le salon configuré avec `/set quiz automatique salon:#discussion`. Ce salon est indépendant des salons de classements. Le bot doit rester connecté et cette configuration doit être faite pour chaque serveur.

Les scores et statistiques sont conservés dans `data/scores.json`, `data/activity.json` et `data/leaderboards.json`. Les données locales sont ignorées par Git. Le Top 10 Messages compte les messages des membres, pas ceux des bots. Le Top 10 Vocal mesure le temps connecté aux salons vocaux et reprend le suivi des membres présents au redémarrage du bot. Les drapeaux sont servis par [FlagCDN](https://flagcdn/).

Le bot reste en ligne tant que le processus Node tourne. Pour le laisser actif en continu, héberge le dossier sur une machine ou un service qui garde le processus démarré.