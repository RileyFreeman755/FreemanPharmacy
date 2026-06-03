# Bot Telegram Kush Rider

Ce serveur recoit les commandes du site et les envoie a ton bot Telegram avec les boutons livreur.

## 1. Recuperer les infos

- `TELEGRAM_BOT_TOKEN` : token donne par BotFather.
- `TELEGRAM_CHAT_ID` : id du chat, groupe ou canal ou le bot doit envoyer les commandes.
- `TELEGRAM_PASS_CHAT_ID` : id de l'autre groupe ou envoyer les commandes que tu ne peux pas faire.

Ne mets jamais le token directement dans `catalogue.html`.

## 2. Lancer le serveur

Dans PowerShell, depuis le dossier du site :

```powershell
$env:TELEGRAM_BOT_TOKEN="TON_TOKEN_ICI"
$env:TELEGRAM_CHAT_ID="TON_CHAT_ID_ICI"
$env:TELEGRAM_PASS_CHAT_ID="TON_AUTRE_GROUPE_ICI"
$env:TELEGRAM_BOT_USERNAME="kushrider75_bot"
$env:KUSH_ACCESS_CODE="TON_CODE_PRIVE"
$env:SESSION_SECRET="UNE_LONGUE_PHRASE_SECRETE_ALEATOIRE"
node bot-server.js
```

Le serveur ecoute sur :

```text
http://localhost:8787
```

Ouvre le site via `http://localhost:8787/index.html`.
Ne mets pas en ligne les fichiers `auth-store.json`, `bot-orders.json` ou `.env`.

## 3. Fonctionnement

Quand le client choisit `Telegram` dans le panier, le site envoie la commande au serveur.

Le bot publie un message avec :

- commande acceptee
- produits
- adresse
- heure souhaitee
- telephone visible seulement dans le groupe principal
- zone
- tournee
- total
- boutons livreur

Le bouton `PASSER LA COMMANDE` envoie une version sans telephone dans `TELEGRAM_PASS_CHAT_ID`.
Cette version garde l'heure souhaitee, l'adresse, les produits et le total.

Le site ouvre aussi le bot avec un lien `/start` special pour connecter le client a sa commande.
Quand le client appuie sur `Start`, le bot retient son chat ID.

## 4. Envoyer une notification au client

Une fois le client connecte au bot, les boutons livreur envoient automatiquement un message au client :

- `30 min` -> le client recoit que le livreur arrive dans environ 30 min
- `10 min`
- `5 min`
- `Arrive`
- `Signaler un retard`
- `Marquer comme livree`

## 5. Ecrire manuellement au client

Dans le groupe commandes, reponds au message de commande avec :

```text
/msg Ton message ici
```

Exemple :

```text
/msg Je suis en bas, veste noire.
```

Tu peux aussi envoyer avec l'id de commande :

```text
/msg CMD-123456789 Je suis en bas.
```

Boutons disponibles :

- Arrivee -1h
- 30 min
- 10 min
- 5 min
- Arrive
- Signaler un retard
- Marquer comme livree
- Retour menu livreur
