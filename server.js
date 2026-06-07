require("dotenv").config();
const path = require("path");
const express       = require("express");
const session       = require("express-session");
const cors          = require("cors");
const { google }    = require("googleapis");
const Anthropic     = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "gmail-agent-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  const auth = oauthClient();
  const url  = auth.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/userinfo.email"
    ]
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Missing code" });
  const auth = oauthClient();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  // Get user email
  const oauth2 = google.oauth2({ version: "v2", auth });
  const { data } = await oauth2.userinfo.get();
  req.session.tokens = tokens;
  req.session.email  = data.email;
  res.redirect(`${process.env.FRONTEND_URL || "/"}?connected=1`);
});

app.get("/auth/status", (req, res) => {
  res.json({ connected: !!req.session.tokens, email: req.session.email || null });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── Gmail helper ──────────────────────────────────────────────────────────────
function getGmail(req) {
  const auth = oauthClient();
  auth.setCredentials(req.session.tokens);
  return google.gmail({ version: "v1", auth });
}

// ── Agent route — traite N emails ────────────────────────────────────────────
// SSE : envoie chaque email traité en temps réel
app.get("/agent/run", async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: "Not authenticated" });

  const limit = Math.min(parseInt(req.query.limit) || 50, 500);

  // SSE headers
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const gmail = getGmail(req);

    // 1. Fetch existing labels
    send("info", { msg: "Récupération des labels Gmail…" });
    const labelsRes = await gmail.users.labels.list({ userId: "me" });
    const labelMap  = {}; // name.lower → id
    for (const l of (labelsRes.data.labels || [])) {
      labelMap[l.name.toLowerCase()] = l.id;
    }

    // 2. Fetch threads page by page
    send("info", { msg: `Récupération de ${limit} emails…` });
    let threads    = [];
    let pageToken  = undefined;
    const pageSize = 20;

    while (threads.length < limit) {
      const r = await gmail.users.threads.list({
        userId: "me", q: "in:inbox",
        maxResults: Math.min(pageSize, limit - threads.length),
        pageToken
      });
      threads   = [...threads, ...(r.data.threads || [])];
      pageToken = r.data.nextPageToken;
      if (!pageToken || !r.data.threads?.length) break;
    }

    threads = threads.slice(0, limit);
    send("info", { msg: `${threads.length} emails trouvés — analyse en cours…`, total: threads.length });

    const deleted  = [];
    const stats    = { deleted: 0, archived: 0, labeled: 0, errors: 0, total: 0 };

    // 3. Process each thread
    for (let i = 0; i < threads.length; i++) {
      const t = threads[i];

      // Get thread details
      let subject = "(sans objet)", from = "", snippet = "";
      try {
        const detail  = await gmail.users.threads.get({ userId: "me", id: t.id, format: "metadata", metadataHeaders: ["Subject", "From"] });
        const msg     = detail.data.messages?.[0];
        subject       = msg?.payload?.headers?.find(h => h.name === "Subject")?.value || "(sans objet)";
        from          = msg?.payload?.headers?.find(h => h.name === "From")?.value || "";
        snippet       = msg?.snippet || "";
      } catch {}

      // Classify with Claude
      let action = "label", labelName = "Divers", reason = "";
      try {
        const resp = await anthropic.messages.create({
          model:      "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: `Tu es un agent de gestion d'emails. Analyse et retourne UNIQUEMENT un JSON (sans markdown) :
{"category":"Newsletters|Promotions|Travail/Clients|Finances|Réseaux sociaux|Famille/Amis|Spam|Autre","action":"delete|archive|label","label":"nom court si label sinon null","reason":"5 mots max"}
Règles:
- Promotions → delete
- Spam → delete
- Newsletters → archive
- Réseaux sociaux → archive
- Travail/Clients, Finances, Famille/Amis → label
- Doute → archive plutôt que delete`,
          messages: [{ role: "user", content: `De: ${from}\nSujet: ${subject}\nAperçu: ${snippet}` }]
        });
        const json = JSON.parse(resp.content[0].text.replace(/```json|```/g, "").trim());
        action    = json.action    || "label";
        labelName = json.label     || json.category || "Divers";
        reason    = json.reason    || "";
      } catch (e) {
        action = "label"; labelName = "Divers"; reason = "erreur classification";
      }

      // Apply action
      let applied = false;
      try {
        if (action === "delete") {
          await gmail.users.threads.modify({ userId: "me", id: t.id, requestBody: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] } });
          applied = true;
          deleted.push({ subject, from, reason });
          stats.deleted++;
        } else if (action === "archive") {
          await gmail.users.threads.modify({ userId: "me", id: t.id, requestBody: { removeLabelIds: ["INBOX"] } });
          applied = true;
          stats.archived++;
        } else {
          // Ensure label exists
          const key = labelName.toLowerCase();
          let lid   = labelMap[key];
          if (!lid) {
            const nl  = await gmail.users.labels.create({ userId: "me", requestBody: { name: labelName } });
            lid        = nl.data.id;
            labelMap[key] = lid;
          }
          await gmail.users.threads.modify({ userId: "me", id: t.id, requestBody: { addLabelIds: [lid] } });
          applied = true;
          stats.labeled++;
        }
      } catch (e) {
        stats.errors++;
        reason = "erreur action";
      }

      stats.total++;
      send("email", { index: i + 1, total: threads.length, subject, from, action, labelName, applied, reason });
    }

    // 4. Send final recap
    send("done", { stats, deleted });

  } catch (e) {
    send("error", { msg: e.message });
  }

  res.end();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true }));

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/auth') && !req.path.startsWith('/agent') && !req.path.startsWith('/health'))
    res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => console.log(`Gmail Agent backend running on port ${PORT}`));
