# Gmail Agent — Guide de déploiement

## Ce que fait l'app
- Se connecte à ton Gmail via OAuth Google
- Analyse chaque email avec Claude (IA)
- Archive, supprime ou étiquette automatiquement
- Affiche un récap des emails supprimés à chaque run
- Installable sur l'écran d'accueil iPhone/Android (PWA)

---

## Étape 1 — Créer les credentials Google

1. Va sur https://console.cloud.google.com
2. Crée un nouveau projet (ex: "Gmail Agent")
3. **APIs & Services → Activer des APIs** → cherche "Gmail API" → Activer
4. **APIs & Services → Identifiants → Créer des identifiants → ID client OAuth**
   - Type : **Application Web**
   - Nom : Gmail Agent
   - URI de redirection autorisés : `https://TON-APP.onrender.com/auth/callback`
   - (tu mettras l'URL Render à l'étape 3)
5. Copie le **Client ID** et le **Client Secret**

---

## Étape 2 — Déployer sur Render

1. Va sur https://render.com → créer un compte gratuit
2. **New → Web Service → Connect a Git repo**
   - Pousse ce dossier sur GitHub d'abord (voir ci-dessous)
   - Ou utilise **Deploy from existing code**
3. Paramètres Render :
   - **Root Directory** : `backend`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
4. **Environment Variables** — ajoute ces variables :

```
ANTHROPIC_API_KEY      = sk-ant-...
GOOGLE_CLIENT_ID       = ...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET   = ...
GOOGLE_REDIRECT_URI    = https://TON-APP.onrender.com/auth/callback
FRONTEND_URL           = https://TON-APP.onrender.com
SESSION_SECRET         = (une longue chaîne aléatoire, ex: openssl rand -hex 32)
NODE_ENV               = production
```

5. Clique **Deploy** — Render te donne une URL du type `https://gmail-agent-xxxx.onrender.com`
6. Retourne sur Google Console et mets à jour l'URI de redirection avec cette URL

---

## Étape 3 — Pousser sur GitHub

```bash
cd gmail-agent
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON-USER/gmail-agent.git
git push -u origin main
```

---

## Étape 4 — Installer sur ton téléphone

### iPhone (Safari)
1. Ouvre `https://ton-app.onrender.com` dans Safari
2. Tape sur le bouton **Partager** (carré avec flèche)
3. **Sur l'écran d'accueil**
4. L'app apparaît comme une vraie app !

### Android (Chrome)
1. Ouvre l'URL dans Chrome
2. Chrome affiche automatiquement **"Ajouter à l'écran d'accueil"**
3. Ou : menu (⋮) → **Ajouter à l'écran d'accueil**

---

## Structure du projet

```
gmail-agent/
├── backend/
│   ├── server.js        # Express + OAuth + Gmail API + Claude
│   ├── package.json
│   └── .env.example     # Copie en .env pour développement local
├── frontend/
│   └── public/
│       ├── index.html   # PWA complète (HTML/CSS/JS)
│       ├── manifest.json
│       └── sw.js        # Service worker
└── render.yaml          # Config Render (optionnel)
```

---

## Développement local

```bash
cd backend
cp .env.example .env
# Remplis .env avec tes clés
npm install
npm run dev
# Ouvre http://localhost:3000
```

---

## Notes importantes

- **Plan Render gratuit** : l'app se met en veille après 15 min d'inactivité, le premier chargement prend ~30s
- **Plan Render Starter ($7/mois)** : toujours actif, recommandé pour un usage quotidien
- Les sessions sont en mémoire — redémarrage = re-connexion Google requise
  Pour persister les sessions, ajoute Redis (Render propose Redis gratuit)
