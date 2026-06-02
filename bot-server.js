const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "kushrider75_bot";
const STORE_PATH = path.join(__dirname, "bot-orders.json");
const AUTH_PATH = path.join(__dirname, "auth-store.json");
const ACCESS_CODE = process.env.KUSH_ACCESS_CODE || process.env.ACCESS_CODE || "";
const OWNER_CODE = process.env.KUSH_OWNER_CODE || process.env.OWNER_CODE || "";
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const OWNER_USERNAMES = ["riley"];

let lastUpdateId = 0;
let store = loadStore();
let authStore = loadAuthStore();
let stockStore = {};
const SESSION_SECRET = process.env.SESSION_SECRET || authStore.sessionSecret;

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (error) {
    return { orders: {}, groupMessages: {} };
  }
}

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  if (USE_SUPABASE) {
    syncOrdersToSupabase().catch((error) => console.error("[supabase] sync orders:", error.message));
  }
}

function loadAuthStore() {
  let loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  } catch (error) {
    loaded = {};
  }

  const normalized = {
    users: loaded && loaded.users && typeof loaded.users === "object" ? loaded.users : {},
    sessions: loaded && loaded.sessions && typeof loaded.sessions === "object" ? loaded.sessions : {},
    sessionSecret: loaded && loaded.sessionSecret ? loaded.sessionSecret : crypto.randomBytes(32).toString("hex")
  };

  if (!loaded.users || !loaded.sessions || !loaded.sessionSecret) {
    fs.writeFileSync(AUTH_PATH, JSON.stringify(normalized, null, 2));
  }

  return normalized;
}

function saveAuthStore() {
  fs.writeFileSync(AUTH_PATH, JSON.stringify(authStore, null, 2));
  if (USE_SUPABASE) {
    syncAuthToSupabase().catch((error) => console.error("[supabase] sync auth:", error.message));
  }
}

function supabaseHeaders(extra) {
  return Object.assign({
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    Accept: "application/json"
  }, extra || {});
}

async function supabaseRequest(pathname, options) {
  if (!USE_SUPABASE) return null;
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + pathname, Object.assign({}, options || {}, {
    headers: supabaseHeaders(options && options.headers)
  }));
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(response.status + " " + text);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function syncAuthToSupabase() {
  if (!USE_SUPABASE) return;

  const users = Object.entries(authStore.users || {}).map(([username, user]) => ({
    username: username,
    salt: user.salt,
    hash: user.hash,
    role: user.role || "client",
    avatar: user.avatar || "",
    created_at: user.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));

  const sessions = Object.entries(authStore.sessions || {}).map(([sessionId, session]) => ({
    session_id: sessionId,
    username: session.username,
    role: session.role || "client",
    expires_at: session.expiresAt
  })).filter((session) => session.username && authStore.users[session.username]);

  if (users.length) {
    await supabaseRequest("app_users?on_conflict=username", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(users)
    });
  }

  if (sessions.length) {
    await supabaseRequest("app_sessions?on_conflict=session_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(sessions)
    });
  }
}

async function deleteSupabaseSession(sessionId) {
  if (!USE_SUPABASE || !sessionId) return;
  await supabaseRequest("app_sessions?session_id=eq." + encodeURIComponent(sessionId), {
    method: "DELETE",
    headers: { Prefer: "return=minimal" }
  });
}

async function syncOrdersToSupabase() {
  if (!USE_SUPABASE) return;

  const orders = Object.entries(store.orders || {}).map(([id, order]) => ({
    id: id,
    username: order.username || "",
    status: order.status || "Acceptee",
    client_chat_id: order.clientChatId ? String(order.clientChatId) : "",
    data: order,
    created_at: order.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));

  if (!orders.length) return;
  await supabaseRequest("app_orders?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(orders)
  });
}

async function syncStockToSupabase(productId) {
  if (!USE_SUPABASE || !productId) return;
  await supabaseRequest("app_stock?on_conflict=product_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      product_id: productId,
      status: stockStore[productId] || "available",
      updated_at: new Date().toISOString()
    }])
  });
}

async function hydrateFromSupabase() {
  if (!USE_SUPABASE) return;

  const [users, sessions, orders, stock] = await Promise.all([
    supabaseRequest("app_users?select=*"),
    supabaseRequest("app_sessions?select=*"),
    supabaseRequest("app_orders?select=*"),
    supabaseRequest("app_stock?select=*")
  ]);

  if (Array.isArray(users) && users.length) {
    authStore.users = users.reduce((acc, user) => {
      acc[user.username] = {
        salt: user.salt,
        hash: user.hash,
        role: user.role || "client",
        avatar: user.avatar || "",
        createdAt: user.created_at || ""
      };
      return acc;
    }, {});
  }

  if (Array.isArray(sessions)) {
    authStore.sessions = sessions.reduce((acc, session) => {
      if (session.expires_at > Date.now() && authStore.users[session.username]) {
        acc[session.session_id] = {
          username: session.username,
          role: session.role || "client",
          expiresAt: session.expires_at
        };
      }
      return acc;
    }, {});
  }

  if (Array.isArray(orders) && orders.length) {
    store.orders = orders.reduce((acc, row) => {
      const data = row.data && typeof row.data === "object" ? row.data : {};
      acc[row.id] = Object.assign({}, data, {
        id: row.id,
        username: row.username || data.username || "",
        status: row.status || data.status || "Acceptee",
        clientChatId: row.client_chat_id || data.clientChatId || "",
        createdAt: row.created_at || data.createdAt || ""
      });
      return acc;
    }, {});
  }

  if (Array.isArray(stock)) {
    stockStore = stock.reduce((acc, row) => {
      acc[row.product_id] = row.status || "available";
      return acc;
    }, {});
  }

  saveAuthStore();
  saveStore();
}

function isOwnerUsername(username) {
  return OWNER_USERNAMES.includes(String(username || "").trim().toLowerCase());
}

function publicUser(username) {
  const user = authStore.users[username] || {};
  return {
    username: username,
    role: user.role || "client",
    avatar: user.avatar || "",
    createdAt: user.createdAt || ""
  };
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
}

function createPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt: salt, hash: hashPassword(password, salt) };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const candidate = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.hash, "hex"));
}

function signSession(id) {
  return id + "." + crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("hex");
}

function readCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index === -1) return cookies;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

function getSession(req) {
  const signed = readCookies(req).kush75_session_id || "";
  const parts = signed.split(".");
  if (parts.length !== 2) return null;

  const expected = signSession(parts[0]).split(".")[1];
  if (parts[1].length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;

  const session = authStore.sessions[parts[0]];
  if (!session || session.expiresAt < Date.now() || session.username === "acces-code" || !authStore.users[session.username]) {
    delete authStore.sessions[parts[0]];
    saveAuthStore();
    deleteSupabaseSession(parts[0]).catch((error) => console.error("[supabase] delete session:", error.message));
    return null;
  }

  return session;
}

function setSessionCookie(res, username, role) {
  const id = crypto.randomBytes(24).toString("hex");
  authStore.sessions[id] = {
    username: username,
    role: role || "client",
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  saveAuthStore();

  res.setHeader("Set-Cookie", [
    "kush75_session_id=" + encodeURIComponent(signSession(id)) + "; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000)
  ]);
}

function clearSessionCookie(req, res) {
  const signed = readCookies(req).kush75_session_id || "";
  const id = signed.split(".")[0];
  if (id) {
    delete authStore.sessions[id];
    saveAuthStore();
    deleteSupabaseSession(id).catch((error) => console.error("[supabase] delete session:", error.message));
  }
  res.setHeader("Set-Cookie", "kush75_session_id=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0");
}

function isOwnerSession(session) {
  if (!session || !session.username) return false;
  const user = authStore.users[session.username] || {};
  return user.role === "owner";
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "https://rileyfreeman755.github.io",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);

  if (pathname === "/catalogue.html" && !getSession(req)) {
    sendRedirect(res, "/index.html");
    return;
  }

  const filePath = path.resolve(__dirname, "." + pathname);
  if (!filePath.startsWith(__dirname) || filePath === AUTH_PATH || filePath === STORE_PATH || filePath.endsWith(".js") && path.basename(filePath) === "bot-server.js") {
    sendJson(res, 403, { ok: false, error: "Acces refuse" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: "Fichier introuvable" });
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

function telegram(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) {
      reject(new Error("TELEGRAM_BOT_TOKEN manquant"));
      return;
    }

    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + BOT_TOKEN + "/" + method,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) {
            reject(new Error(json.description || "Erreur Telegram"));
            return;
          }
          resolve(json.result);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startLink(orderId) {
  return "https://t.me/" + BOT_USERNAME + "?start=" + encodeURIComponent(orderId);
}

function formatOrder(order) {
  const items = Array.isArray(order.items) && order.items.length
    ? order.items.map((item) => "- " + item.name + " (" + item.format + ") x" + item.quantity + " = " + item.lineTotal).join("\n")
    : "Panier vide";

  return [
    "✅ Commande " + order.id + " acceptee !",
    "",
    "📦 Produits :",
    items,
    "",
    "📍 Adresse : " + (order.address || "A renseigner"),
    "🕘 Tournee : " + (order.round || "Non renseignee"),
    "🚚 Service : " + (order.service || "Non renseigne"),
    "",
    "💰 Total a encaisser : " + (order.total || "0.00 EUR"),
    "",
    "👤 Client Telegram : " + (order.clientChatId ? "connecte" : "en attente"),
    "🔗 Lien client : " + startLink(order.id),
    "",
    "💬 Pour ecrire au client : reponds a ce message avec /msg ton texte",
    "Exemple : /msg Je suis en bas dans 10 min",
    "",
    "👇 Boutons livreur :"
  ].join("\n");
}

function deliveryKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: "⏰ Arrivee -1h", callback_data: "eta_60|" + orderId }],
      [
        { text: "⌛ 30 min", callback_data: "eta_30|" + orderId },
        { text: "⌛ 10 min", callback_data: "eta_10|" + orderId }
      ],
      [
        { text: "⚡ 5 min", callback_data: "eta_5|" + orderId },
        { text: "📍 Arrive", callback_data: "arrived|" + orderId }
      ],
      [{ text: "⚠️ Signaler un RETARD", callback_data: "delay|" + orderId }],
      [{ text: "✅ MARQUER COMME LIVREE", callback_data: "delivered|" + orderId }],
      [{ text: "◀️ Retour Menu Livreur", callback_data: "menu|" + orderId }]
    ]
  };
}

function clientText(action) {
  const labels = {
    eta_60: "⏰ Votre livreur arrive dans environ 1h.",
    eta_30: "⌛ Votre livreur arrive dans environ 30 min.",
    eta_10: "⌛ Votre livreur arrive dans environ 10 min.",
    eta_5: "⚡ Votre livreur arrive dans environ 5 min.",
    arrived: "📍 Votre livreur est arrive.",
    delay: "⚠️ Votre livreur a signale un retard. Il revient vers vous rapidement.",
    delivered: "✅ Commande marquee comme livree."
  };
  return labels[action] || "";
}

function statusForAction(action) {
  const statuses = {
    eta_60: "En route",
    eta_30: "Arrive bientot",
    eta_10: "Arrive bientot",
    eta_5: "Arrive bientot",
    arrived: "Arrive",
    delay: "Retard",
    delivered: "Livree"
  };
  return statuses[action] || "";
}

function adminText(action, orderId) {
  const labels = {
    eta_60: "⏰ Arrivee -1h envoyee",
    eta_30: "⌛ 30 min envoye",
    eta_10: "⌛ 10 min envoye",
    eta_5: "⚡ 5 min envoye",
    arrived: "📍 Arrive envoye",
    delay: "⚠️ Retard signale",
    delivered: "✅ Commande livree",
    menu: "◀️ Menu livreur"
  };
  return (labels[action] || "Action") + " - " + orderId;
}

async function notifyClient(orderId, text) {
  const order = store.orders[orderId];
  if (!order || !order.clientChatId) return false;

  await telegram("sendMessage", {
    chat_id: order.clientChatId,
    text: text
  });
  return true;
}

async function handleStart(message) {
  const text = String(message.text || "");
  const parts = text.split(/\s+/);
  const orderId = parts[1];

  if (!orderId || !store.orders[orderId]) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Bienvenue chez Kush Rider. Lance le bot depuis le bouton Telegram du panier pour connecter ta commande."
    });
    return;
  }

  store.orders[orderId].clientChatId = message.chat.id;
  store.orders[orderId].clientName = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username || "Client";
  store.orders[orderId].status = store.orders[orderId].status || "Acceptee";
  saveStore();

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: "Commande " + orderId + " connectee. Tu recevras ici les infos du livreur."
  });

  await telegram("sendMessage", {
    chat_id: CHAT_ID,
    text: "Client connecte a la commande " + orderId + "."
  }).catch(() => {});
}

async function handleAdminMessage(message) {
  if (String(message.chat.id) !== CHAT_ID) return;

  const text = String(message.text || "").trim();
  if (!text.startsWith("/msg")) return;

  let orderId = "";
  let body = "";

  if (message.reply_to_message) {
    orderId = store.groupMessages[String(message.reply_to_message.message_id)] || "";
    body = text.replace(/^\/msg(@\w+)?\s*/i, "").trim();
  } else {
    const match = text.match(/^\/msg(?:@\w+)?\s+(\S+)\s+([\s\S]+)/i);
    if (match) {
      orderId = match[1];
      body = match[2].trim();
    }
  }

  if (!orderId || !store.orders[orderId]) {
    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: "Commande introuvable. Reponds au message de commande avec /msg ton texte."
    });
    return;
  }

  if (!body) {
    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: "Message vide. Exemple : /msg Je suis en bas."
    });
    return;
  }

  const sent = await notifyClient(orderId, body);
  await telegram("sendMessage", {
    chat_id: CHAT_ID,
    text: sent
      ? "Message envoye au client pour " + orderId + "."
      : "Client pas encore connecte au bot pour " + orderId + "."
  });
}

function clientLabel(message) {
  const fullName = [message.from && message.from.first_name, message.from && message.from.last_name].filter(Boolean).join(" ");
  const username = message.from && message.from.username ? "@" + message.from.username : "";
  return [fullName || "Client", username].filter(Boolean).join(" - ");
}

async function handleClientMessage(message) {
  if (message.chat.type !== "private") return;
  if (String(message.text || "").startsWith("/start")) return;

  const chatId = String(message.chat.id);
  const orderEntry = Object.entries(store.orders).find(([, order]) => String(order.clientChatId || "") === chatId);
  const orderId = orderEntry ? orderEntry[0] : "";
  const order = orderEntry ? orderEntry[1] : null;

  if (!orderId || !order) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Je n'ai pas encore trouve ta commande. Lance le bot depuis le bouton Telegram du panier."
    }).catch(() => {});
    return;
  }

  const forwarded = await telegram("sendMessage", {
    chat_id: CHAT_ID,
    text: [
      "Message client - " + orderId,
      "Client site : " + (order.username || "inconnu"),
      "Client Telegram : " + clientLabel(message),
      "",
      String(message.text || "")
    ].join("\n")
  });

  store.groupMessages[String(forwarded.message_id)] = orderId;
  saveStore();
}

async function handleCallback(callback) {
  const [action, orderId] = String(callback.data || "").split("|");
  await telegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: adminText(action, orderId),
    show_alert: false
  });

  if (action === "menu" || action === "done") return;

  const text = clientText(action);
  const status = statusForAction(action);
  if (status && store.orders[orderId]) {
    store.orders[orderId].status = status;
    store.orders[orderId].statusUpdatedAt = new Date().toISOString();
    saveStore();
  }
  const sent = text ? await notifyClient(orderId, text) : false;

  await telegram("sendMessage", {
    chat_id: CHAT_ID,
    text: sent
      ? adminText(action, orderId) + " au client."
      : "Client pas encore connecte au bot pour " + orderId + "."
  }).catch(() => {});

  if (callback.message && action === "delivered") {
    await telegram("editMessageReplyMarkup", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: "✅ Commande livree", callback_data: "done|" + orderId }]] }
    }).catch(() => {});
  }
}

async function pollUpdates() {
  if (!BOT_TOKEN) return;

  try {
    const updates = await telegram("getUpdates", {
      offset: lastUpdateId ? lastUpdateId + 1 : undefined,
      timeout: 0,
      allowed_updates: ["message", "callback_query"]
    });

    for (const update of updates) {
      lastUpdateId = update.update_id;

      if (update.callback_query) {
        await handleCallback(update.callback_query);
      }

      if (update.message && update.message.text) {
        if (String(update.message.text).startsWith("/start")) {
          await handleStart(update.message);
        } else if (String(update.message.chat.id) === CHAT_ID) {
          await handleAdminMessage(update.message);
        } else {
          await handleClientMessage(update.message);
        }
      }
    }
  } catch (error) {
    console.error("[bot] updates:", error.message);
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    const session = getSession(req);
    sendJson(res, 200, {
      ok: true,
      authenticated: Boolean(session),
      user: session ? publicUser(session.username) : null,
      memberCount: Object.keys(authStore.users).length
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    try {
      const body = JSON.parse(await readBody(req));
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const confirmPassword = String(body.confirmPassword || "");
      const accessCode = String(body.accessCode || "");
      const isOwner = isOwnerUsername(username);

      if (!ACCESS_CODE) {
        sendJson(res, 500, { ok: false, error: "Configure KUSH_ACCESS_CODE sur le serveur." });
        return;
      }

      if (isOwner && !OWNER_CODE) {
        sendJson(res, 500, { ok: false, error: "Configure KUSH_OWNER_CODE sur le serveur." });
        return;
      }

      if (isOwner && accessCode !== OWNER_CODE) {
        sendJson(res, 403, { ok: false, error: "Pseudo reserve au patron." });
        return;
      }

      if (!isOwner && accessCode !== ACCESS_CODE) {
        sendJson(res, 403, { ok: false, error: "Code d'acces incorrect." });
        return;
      }

      if (!username || username.length < 3) {
        sendJson(res, 400, { ok: false, error: "Choisis un pseudo d'au moins 3 caracteres." });
        return;
      }

      if (!password || password.length < 4) {
        sendJson(res, 400, { ok: false, error: "Le mot de passe doit faire au moins 4 caracteres." });
        return;
      }

      if (password !== confirmPassword) {
        sendJson(res, 400, { ok: false, error: "Les mots de passe ne correspondent pas." });
        return;
      }

      if (authStore.users[username]) {
        sendJson(res, 409, { ok: false, error: "Ce pseudo existe deja." });
        return;
      }

      const passwordData = createPassword(password);
      authStore.users[username] = {
        salt: passwordData.salt,
        hash: passwordData.hash,
        role: isOwner ? "owner" : "client",
        createdAt: new Date().toISOString()
      };
      saveAuthStore();
      setSessionCookie(res, username, authStore.users[username].role);
      sendJson(res, 200, { ok: true, user: publicUser(username), memberCount: Object.keys(authStore.users).length });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      const body = JSON.parse(await readBody(req));
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const accessCode = String(body.accessCode || "");
      const isOwner = isOwnerUsername(username);

      if (!ACCESS_CODE) {
        sendJson(res, 500, { ok: false, error: "Configure KUSH_ACCESS_CODE sur le serveur." });
        return;
      }

      if (!accessCode) {
        sendJson(res, 400, { ok: false, error: "Entre le code d'acces." });
        return;
      }

      if (isOwner && !OWNER_CODE) {
        sendJson(res, 500, { ok: false, error: "Configure KUSH_OWNER_CODE sur le serveur." });
        return;
      }

      if (isOwner && accessCode !== OWNER_CODE) {
        sendJson(res, 403, { ok: false, error: "Code patron incorrect." });
        return;
      }

      if (!isOwner && accessCode !== ACCESS_CODE) {
        sendJson(res, 403, { ok: false, error: "Code d'acces incorrect." });
        return;
      }

      if (!username || !password || !verifyPassword(password, authStore.users[username])) {
        sendJson(res, 401, { ok: false, error: "Pseudo ou mot de passe incorrect." });
        return;
      }

      if (isOwner && authStore.users[username].role !== "owner") {
        authStore.users[username].role = "owner";
        saveAuthStore();
      }

      setSessionCookie(res, username, authStore.users[username].role);
      sendJson(res, 200, { ok: true, user: publicUser(username), memberCount: Object.keys(authStore.users).length });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/profile") {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, error: "Connexion requise" });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const avatar = String(body.avatar || "");

      if (avatar && !avatar.startsWith("data:image/")) {
        sendJson(res, 400, { ok: false, error: "Image invalide." });
        return;
      }

      authStore.users[session.username].avatar = avatar;
      saveAuthStore();
      sendJson(res, 200, { ok: true, user: publicUser(session.username) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/orders") {
    const session = getSession(req);
    if (!isOwnerSession(session)) {
      sendJson(res, 403, { ok: false, error: "Acces patron requis" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      orders: Object.values(store.orders).sort(function(a, b) {
        return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      })
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/my-orders") {
    const session = getSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, error: "Connexion requise" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      orders: Object.values(store.orders)
        .filter(function(order) {
          return String(order.username || "").toLowerCase() === String(session.username || "").toLowerCase();
        })
        .sort(function(a, b) {
          return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
        })
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/order/status") {
    const session = getSession(req);
    if (!isOwnerSession(session)) {
      sendJson(res, 403, { ok: false, error: "Acces patron requis" });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const orderId = String(body.orderId || "");
      const status = String(body.status || "");

      if (!orderId || !store.orders[orderId]) {
        sendJson(res, 404, { ok: false, error: "Commande introuvable" });
        return;
      }

      if (!status) {
        sendJson(res, 400, { ok: false, error: "Statut manquant" });
        return;
      }

      store.orders[orderId].status = status;
      store.orders[orderId].statusUpdatedAt = new Date().toISOString();
      saveStore();
      sendJson(res, 200, { ok: true, order: store.orders[orderId] });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stock") {
    sendJson(res, 200, {
      ok: true,
      stock: stockStore
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stock") {
    const session = getSession(req);
    if (!isOwnerSession(session)) {
      sendJson(res, 403, { ok: false, error: "Acces patron requis" });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));
      const productId = String(body.productId || "");
      const status = String(body.status || "");
      const allowed = ["available", "soon", "out"];

      if (!productId || !allowed.includes(status)) {
        sendJson(res, 400, { ok: false, error: "Stock invalide" });
        return;
      }

      stockStore[productId] = status;
      await syncStockToSupabase(productId);
      sendJson(res, 200, { ok: true, stock: stockStore });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/order") {
    if (!getSession(req)) {
      sendJson(res, 401, { ok: false, error: "Connexion requise" });
      return;
    }

    if (!BOT_TOKEN || !CHAT_ID) {
      sendJson(res, 500, { ok: false, error: "Configure TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID" });
      return;
    }

    try {
      const order = JSON.parse(await readBody(req));
      const session = getSession(req);
      store.orders[order.id] = Object.assign({}, order, {
        username: session && session.username ? session.username : order.username,
        clientChatId: store.orders[order.id] && store.orders[order.id].clientChatId,
        status: store.orders[order.id] && store.orders[order.id].status || "Acceptee",
        createdAt: new Date().toISOString()
      });
      saveStore();

      const result = await telegram("sendMessage", {
        chat_id: CHAT_ID,
        text: formatOrder(store.orders[order.id]),
        reply_markup: deliveryKeyboard(order.id || "CMD")
      });

      store.groupMessages[String(result.message_id)] = order.id;
      saveStore();

      sendJson(res, 200, {
        ok: true,
        messageId: result.message_id,
        startLink: startLink(order.id)
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Route introuvable" });
});

async function startServer() {
  if (USE_SUPABASE) {
    try {
      await hydrateFromSupabase();
      console.log("Supabase connecte: donnees chargees.");
    } catch (error) {
      console.error("[supabase] demarrage:", error.message);
    }
  } else {
    console.log("Supabase non configure: stockage local Render seulement.");
  }

  server.listen(PORT, () => {
    console.log("Kush Rider bot server actif sur http://localhost:" + PORT);
    console.log("Variables requises: KUSH_ACCESS_CODE, TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID");
    console.log("Bot username: @" + BOT_USERNAME);
  });

  setInterval(pollUpdates, 2500);
}

startServer();
