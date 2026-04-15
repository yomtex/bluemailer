// ╔══════════════════════════════════════════════════════════════╗
//  BLUE MAILER v3.1 — Server-Side API
//  License gating · Device tracking · Session management
//  SMTP · Bulk/Personalized Send · Validate · Sort · Dedupe
//  Inbox Scanner · SPF/DKIM Checker · Template Manager
//  Admin Panel · Credit System · Email Cache
// ╚══════════════════════════════════════════════════════════════╝

const express      = require("express");
const cors         = require("cors");
const multer       = require("multer");
const nodemailer   = require("nodemailer");
const dns          = require("dns").promises;
const net          = require("net");
const path         = require("path");
const fs           = require("fs");
const crypto       = require("crypto");
const Imap         = require("imap-simple");
const { simpleParser } = require("mailparser");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ────────────────────────────────────────────────────
const DATA_DIR         = path.join(__dirname, "data");
const DEVICES_FILE     = path.join(DATA_DIR, "devices.json");
const SESSIONS_FILE    = path.join(DATA_DIR, "sessions.json");
const TEMPLATES_FILE   = path.join(DATA_DIR, "templates.json");
const LICENSES_FILE    = path.join(DATA_DIR, "licenses.json");
const EMAIL_CACHE_FILE = path.join(DATA_DIR, "email_cache.json");
const ADMIN_FILE       = path.join(DATA_DIR, "admin.json");
const USAGE_FILE       = path.join(DATA_DIR, "usage.json");

[DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
[DEVICES_FILE, SESSIONS_FILE, TEMPLATES_FILE, EMAIL_CACHE_FILE, USAGE_FILE].forEach(f => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, "{}", "utf8");
});

// ─── Default Admin Config ─────────────────────────────────────
if (!fs.existsSync(ADMIN_FILE)) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({
    password: "admin123",
    adminSessions: {}
  }, null, 2));
}

// ─── Default Licenses ─────────────────────────────────────────
const BUILTIN_LICENSES = {
  "9f4b7e2a-6c13-4a8f-9d12-3b2e8f1d5a6c": {
    tier: "Premium", maxDevices: 10, label: "PREMIUM", color: "#1e90ff",
    features: ["send_bulk","send_personal","smtp_test","validate","sort","dedupe","spf_dkim","inbox_scan","blacklist","templates","proj_lib"],
    creditsEnabled: false, creditsTotal: 0, active: true,
    createdAt: new Date().toISOString(), note: "Default Premium license"
  },
  "d3a8cfae-2b04-4f2e-8b34-7a9f0d6e1c2b": {
    tier: "Business", maxDevices: 5, label: "BUSINESS", color: "#00d4ff",
    features: ["send_bulk","send_personal","smtp_test","validate","sort","dedupe","templates","proj_lib"],
    creditsEnabled: false, creditsTotal: 0, active: true,
    createdAt: new Date().toISOString(), note: "Default Business license"
  },
  "a7b9f2c1-5e88-4d33-9c77-11b2e6f4a9d0": {
    tier: "Basic", maxDevices: 2, label: "BASIC", color: "#607898",
    features: ["send_bulk","smtp_test"],
    creditsEnabled: false, creditsTotal: 0, active: true,
    createdAt: new Date().toISOString(), note: "Default Basic license"
  },
  "c2f98b4d-3a21-4bbf-8f0a-5e6d7c2b9a1f": {
    tier: "Marketing", maxDevices: 5, label: "MARKETING", color: "#ff8c42",
    features: ["send_bulk","send_personal","smtp_test","validate","sort","templates"],
    creditsEnabled: false, creditsTotal: 0, active: true,
    createdAt: new Date().toISOString(), note: "Default Marketing license"
  },
  "t-6e5d4c3b-2a19-4f8e-9a7b-1c2d3e4f5a6b": {
    tier: "Trial", maxDevices: 1, label: "TRIAL", color: "#ffcc00",
    features: ["send_bulk","smtp_test"],
    creditsEnabled: true, creditsTotal: 100, active: true,
    expiresAfterDays: 7,
    createdAt: new Date().toISOString(), note: "Default Trial license"
  }
};

if (!fs.existsSync(LICENSES_FILE)) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(BUILTIN_LICENSES, null, 2));
}

// ─── Credit Rate Table ────────────────────────────────────────
// Tune pricing here — never touch the logic below.
// Each value is credits-per-item. Charge is always rounded UP,
// with a minimum of 1 credit per request.
const CREDIT_RATES = {
  send_bulk:     0.1,   //  1 credit per 10 recipients
  send_personal: 0.1,   //  1 credit per 10 leads
  validate:      0.05,  //  1 credit per 20 emails validated
  sort:          0.02,  //  1 credit per 50 emails sorted
  dedupe:        0.02,  //  1 credit per 50 emails deduped
  spf_dkim:      0.5,   //  1 credit per 2 domains
  blacklist:     1.0,   //  1 credit per domain
  inbox_scan:    2.0,   //  2 credits per inbox scanned
  smtp_test:     0.5,   //  1 credit per 2 SMTP entries
  default:       1.0,   //  fallback: 1 credit flat
};

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ─── Data helpers ─────────────────────────────────────────────
function readJSON(file)     { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } }
function writeJSON(file, d) { fs.writeFileSync(file, JSON.stringify(d, null, 2), "utf8"); }

// ─── License helpers ──────────────────────────────────────────
function getLicenses()          { return readJSON(LICENSES_FILE); }
function saveLicenses(d)        { writeJSON(LICENSES_FILE, d); }
function getLicense(key)        { return getLicenses()[key] || null; }

// ─── Credit helpers ───────────────────────────────────────────
function getUsage()    { return readJSON(USAGE_FILE); }
function saveUsage(d)  { writeJSON(USAGE_FILE, d); }

function getCreditsUsed(licenseKey) {
  const usage = getUsage();
  return usage[licenseKey]?.creditsUsed || 0;
}

// Volume-aware credit deduction.
// count    — number of items being processed (recipients, emails, domains …)
// Returns  { ok: true, deducted: N } on success,
//          { ok: false, cost: N, remaining: M } when balance is insufficient.
function deductCredits(licenseKey, feature = "generic", count = 1) {
  const lic = getLicense(licenseKey);
  if (!lic || !lic.creditsEnabled) return { ok: true, deducted: 0 }; // unlimited

  const rate = CREDIT_RATES[feature] ?? CREDIT_RATES.default;
  const cost = Math.max(1, Math.ceil(count * rate));

  const usage = getUsage();
  if (!usage[licenseKey]) usage[licenseKey] = { creditsUsed: 0, history: [] };

  const used      = usage[licenseKey].creditsUsed;
  const remaining = (lic.creditsTotal || 0) - used;
  if (remaining < cost) return { ok: false, cost, remaining };

  usage[licenseKey].creditsUsed = used + cost;
  usage[licenseKey].history.push({ feature, count, cost, ts: new Date().toISOString() });
  if (usage[licenseKey].history.length > 500) {
    usage[licenseKey].history = usage[licenseKey].history.slice(-500);
  }
  saveUsage(usage);
  return { ok: true, deducted: cost };
}

// Backward-compat shim — flat 1-credit calls still work unchanged.
function deductCredit(licenseKey, feature = "generic") {
  return deductCredits(licenseKey, feature, 1).ok;
}

function addCredits(licenseKey, amount) {
  const licenses = getLicenses();
  if (!licenses[licenseKey]) return false;
  licenses[licenseKey].creditsTotal = (licenses[licenseKey].creditsTotal || 0) + amount;
  saveLicenses(licenses);
  return true;
}

// ─── Email Cache helpers ──────────────────────────────────────
const EMAIL_CACHE_TTL_DAYS = 30;

// In-memory cache mirror — prevents concurrent file read/write corruption
let _cacheMemory = null;
let _cacheDirty  = false;
let _cacheFlushTimer = null;

function _loadCacheMemory() {
  if (!_cacheMemory) _cacheMemory = readJSON(EMAIL_CACHE_FILE);
  return _cacheMemory;
}

function _scheduleCacheFlush() {
  if (_cacheFlushTimer) return;
  _cacheFlushTimer = setTimeout(() => {
    _cacheFlushTimer = null;
    if (_cacheDirty && _cacheMemory) {
      writeJSON(EMAIL_CACHE_FILE, _cacheMemory);
      _cacheDirty = false;
    }
  }, 300); // batch all writes within 300 ms window
}

function getEmailCache() { return _loadCacheMemory(); }
function saveEmailCache(d) {
  _cacheMemory = d; _cacheDirty = true; _scheduleCacheFlush();
}

function checkEmailCache(email) {
  const cache = _loadCacheMemory();
  const entry = cache[email];
  if (!entry) return null;
  const age = (Date.now() - new Date(entry.cachedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (age > EMAIL_CACHE_TTL_DAYS) {
    delete _cacheMemory[email]; _cacheDirty = true; _scheduleCacheFlush();
    return null;
  }
  return entry;
}

// Batch-write multiple results at once — safe for concurrent callers
function cacheEmailResults(results) {
  // results: [{ email, status, reason, domain, licenseKey }]
  const cache = _loadCacheMemory();
  const now   = new Date().toISOString();
  for (const r of results) {
    cache[r.email] = { status: r.status, reason: r.reason || null, domain: r.domain, licenseKey: r.licenseKey, cachedAt: now };
  }
  _cacheMemory = cache; _cacheDirty = true; _scheduleCacheFlush();
}

// Keep single-write helper for back-compat (admin clear etc.)
function cacheEmailResult(email, status, reason, domain, licenseKey) {
  cacheEmailResults([{ email, status, reason, domain, licenseKey: licenseKey || null }]);
}

function clearEmailCache(olderThanDays = 0) {
  const cache = _loadCacheMemory();
  const now = Date.now();
  let cleared = 0;
  for (const [email, entry] of Object.entries(cache)) {
    const age = (now - new Date(entry.cachedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (age >= olderThanDays) { delete cache[email]; cleared++; }
  }
  _cacheMemory = cache; _cacheDirty = true; _scheduleCacheFlush();
  return cleared;
}

// ─── IP helpers ───────────────────────────────────────────────
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim()
      || req.socket.remoteAddress
      || "0.0.0.0";
}

function parseUA(ua = "") {
  const os = ua.includes("Windows") ? "Windows"
           : ua.includes("Mac")     ? "macOS"
           : ua.includes("Linux")   ? "Linux"
           : ua.includes("Android") ? "Android"
           : ua.includes("iPhone")  ? "iOS"
           : "Unknown";
  const browser = ua.includes("Chrome")  ? "Chrome"
                : ua.includes("Firefox") ? "Firefox"
                : ua.includes("Safari")  ? "Safari"
                : ua.includes("Edge")    ? "Edge"
                : "Unknown";
  return { os, browser };
}

async function geoIP(ip) {
  try {
    if (ip.startsWith("127.") || ip.startsWith("::") || ip === "0.0.0.0") {
      return { country: "Localhost", city: "Local", isp: "Local", flag: "🏠" };
    }
    const res = await Promise.race([
      fetch(`http://ip-api.com/json/${ip}?fields=status,country,city,isp,countryCode`).then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))
    ]);
    if (res.status === "success") {
      return { country: res.country, city: res.city, isp: res.isp, countryCode: res.countryCode, flag: "" };
    }
  } catch {}
  return { country: "Unknown", city: "—", isp: "—", flag: "🌐" };
}

// ─── Session helpers ──────────────────────────────────────────
function genToken() { return crypto.randomBytes(32).toString("hex"); }

function createSession(licenseKey, deviceId, ip, ua) {
  const sessions = readJSON(SESSIONS_FILE);
  const token = genToken();
  sessions[token] = {
    licenseKey, deviceId, ip,
    createdAt: new Date().toISOString(),
    lastSeen:  new Date().toISOString(),
    ua: ua || ""
  };
  writeJSON(SESSIONS_FILE, sessions);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const sessions = readJSON(SESSIONS_FILE);
  const s = sessions[token];
  if (!s) return null;
  // Fix 3: Only flush to disk if lastSeen is more than 30 seconds old —
  // prevents hundreds of writes/minute under normal load.
  const now = new Date();
  if (!s.lastSeen || (now - new Date(s.lastSeen)) > 30000) {
    s.lastSeen = now.toISOString();
    sessions[token] = s;
    writeJSON(SESSIONS_FILE, sessions);
  }
  return s;
}

function destroySession(token) {
  const sessions = readJSON(SESSIONS_FILE);
  delete sessions[token];
  writeJSON(SESSIONS_FILE, sessions);
}

// ─── Auth middleware ──────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers["x-session-token"] || req.body?.sessionToken;
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: "Unauthorized. Please activate your license." });
  req.session = session;
  req.license = getLicense(session.licenseKey);
  if (!req.license) return res.status(401).json({ error: "License not found." });
  if (!req.license.active) return res.status(403).json({ error: "License deactivated." });
  next();
}

// Returns the item count for a feature from a parsed request body.
// This runs synchronously inside the middleware (body is already parsed).
function getVolumeForFeature(feature, body) {
  switch (feature) {
    case "send_bulk":
      return [...new Set((body.recipients || []).map(r => r.trim().toLowerCase()))].length;
    case "send_personal":
      return parseLeads(body.leadsText || "").length;
    case "validate":
      return [...new Set(
        (body.emailsText || "").split(/[\r\n]+/).map(l => l.trim().toLowerCase())
          .filter(l => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l))
      )].length;
    case "sort":
      return parseEmails(body.emailsText || "").length;
    case "dedupe":
      return (body.emailsText || "").split(/[\r\n]+/).filter(l => l.trim().includes("@")).length;
    case "spf_dkim":
    case "blacklist":
      return (body.domains || []).length;
    case "inbox_scan":
      return (body.accounts || []).length;
    case "smtp_test":
      return (body.entries || []).length;
    default:
      return 1;
  }
}

function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.license?.features.includes(feature)) {
      return res.status(403).json({ error: `Feature '${feature}' not available on your ${req.license?.tier || "current"} plan.` });
    }
    if (req.license.creditsEnabled) {
      const count  = getVolumeForFeature(feature, req.body);
      const result = deductCredits(req.session.licenseKey, feature, count);
      if (!result.ok) {
        return res.status(402).json({
          error:     "Insufficient credits.",
          need:      result.cost,
          remaining: result.remaining,
          hint:      `This job (${count} item${count !== 1 ? "s" : ""}) costs ${result.cost} credit${result.cost !== 1 ? "s" : ""}. Contact admin to top up.`
        });
      }
    }
    next();
  };
}

// ─── Admin middleware ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  const adminData = readJSON(ADMIN_FILE);
  if (!token || !adminData.adminSessions || !adminData.adminSessions[token]) {
    return res.status(401).json({ error: "Admin authentication required." });
  }
  const session = adminData.adminSessions[token];
  // 24h expiry
  if (Date.now() - new Date(session.createdAt).getTime() > 86400000) {
    delete adminData.adminSessions[token];
    writeJSON(ADMIN_FILE, adminData);
    return res.status(401).json({ error: "Admin session expired." });
  }
  next();
}

// ─── SSE helpers ─────────────────────────────────────────────
function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}
function sseSend(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

// ─── Utility ─────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseEmails(text) {
  return [...new Set(
    text.split(/[\r\n,;]+/).map(l => l.trim().toLowerCase()).filter(l => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l))
  )];
}

function parseLeads(text) {
  const seen = new Set();
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(/[,|;]/);
    const email = parts[0].trim().toLowerCase();
    let name = parts[1] ? parts.slice(1).join(",").trim() : extractName(email);
    if (!name) name = "Friend";
    return { email, name };
  }).filter(l => {
    // Fix 2: Dedup by email — skip already-seen addresses
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l.email)) return false;
    if (seen.has(l.email)) return false;
    seen.add(l.email);
    return true;
  });
}

function extractName(email) {
  const local = email.split("@")[0] || "";
  const cleaned = local.replace(/[._\-+0-9]+/g, " ").trim();
  const generic = new Set(["info","support","sales","noreply","no-reply","admin","contact","hello","team","mail","news","newsletter"]);
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length || (parts.length === 1 && generic.has(parts[0].toLowerCase()))) return "";
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

function renderTemplate(tpl, data) {
  return tpl.replace(/{{\s*(\w+)\s*}}/gi, (_, k) => data[k] !== undefined ? data[k] : _);
}

async function canConnect(host, port, timeout = 4000) {
  return new Promise(resolve => {
    const s = net.createConnection(port, host);
    s.setTimeout(timeout);
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error",   () => { s.destroy(); resolve(false); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

async function detectImap(email) {
  const domain = email.split("@")[1].toLowerCase();
  const known = {
    "gmail.com":"imap.gmail.com","yahoo.com":"imap.mail.yahoo.com",
    "outlook.com":"imap-mail.outlook.com","hotmail.com":"imap-mail.outlook.com",
    "live.com":"imap-mail.outlook.com","aol.com":"imap.aol.com",
    "icloud.com":"imap.mail.me.com","zoho.com":"imap.zoho.com",
    "yandex.com":"imap.yandex.com","protonmail.com":"127.0.0.1",
    "gmx.com":"imap.gmx.com","mail.com":"imap.mail.com"
  };
  if (known[domain]) return { host: known[domain], port: 993, tls: true };
  let rootDomain = domain;
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length) {
      const parts = mx.sort((a,b)=>a.priority-b.priority)[0].exchange.replace(/\.$/, "").split(".");
      rootDomain = parts.slice(-2).join(".");
    }
  } catch {}
  const guesses = [`imap.${rootDomain}`,`mail.${domain}`,`mail.${rootDomain}`,`imap.${domain}`,rootDomain];
  for (const host of guesses) {
    try {
      await dns.lookup(host);
      if (await canConnect(host, 993)) return { host, port: 993, tls: true };
      if (await canConnect(host, 143)) return { host, port: 143, tls: false };
    } catch {}
  }
  return { host: guesses[0], port: 993, tls: true };
}

// ╔══════════════════════════════════════════════════════════════╗
//  ADMIN ROUTES
// ╚══════════════════════════════════════════════════════════════╝

// Serve admin panel
app.get("/admin", (_, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// Admin login
app.post("/api/admin/auth", (req, res) => {
  const { password } = req.body;
  const adminData = readJSON(ADMIN_FILE);
  if (password !== adminData.password) {
    return res.status(401).json({ error: "Invalid admin password." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  if (!adminData.adminSessions) adminData.adminSessions = {};
  // Clean old sessions
  const now = Date.now();
  for (const [t, s] of Object.entries(adminData.adminSessions)) {
    if (now - new Date(s.createdAt).getTime() > 86400000) delete adminData.adminSessions[t];
  }
  adminData.adminSessions[token] = { createdAt: new Date().toISOString() };
  writeJSON(ADMIN_FILE, adminData);
  res.json({ ok: true, token });
});

// Admin: change password
app.post("/api/admin/change-password", requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password too short (min 6 chars)." });
  const adminData = readJSON(ADMIN_FILE);
  adminData.password = newPassword;
  writeJSON(ADMIN_FILE, adminData);
  res.json({ ok: true });
});

// Admin: get dashboard stats
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const licenses = getLicenses();
  const devices  = readJSON(DEVICES_FILE);
  const sessions = readJSON(SESSIONS_FILE);
  const usage    = getUsage();
  const cache    = getEmailCache();

  const licList = Object.entries(licenses).map(([key, lic]) => {
    const devList = devices[key]?.list || [];
    const used    = usage[key]?.creditsUsed || 0;
    const active  = Object.values(sessions).filter(s => s.licenseKey === key &&
      (Date.now() - new Date(s.lastSeen).getTime()) < 60000).length;
    return {
      key, ...lic,
      deviceCount: devList.filter(d => !d.revoked).length,
      creditsUsed: used,
      creditsRemaining: lic.creditsEnabled ? Math.max(0, (lic.creditsTotal || 0) - used) : null,
      activeSessions: active
    };
  });

  const onlineSessions = Object.values(sessions).filter(s =>
    (Date.now() - new Date(s.lastSeen).getTime()) < 60000).length;

  const totalDevices = Object.values(devices).reduce((n, d) => n + (d.list?.filter(x => !x.revoked).length || 0), 0);
  const cacheSize    = Object.keys(cache).length;
  const validCached  = Object.values(cache).filter(e => e.status === "valid").length;
  const invalidCached = Object.values(cache).filter(e => e.status !== "valid").length;

  res.json({
    licenses: licList,
    totalLicenses: licList.length,
    activeLicenses: licList.filter(l => l.active).length,
    totalDevices,
    onlineSessions,
    emailCache: { total: cacheSize, valid: validCached, invalid: invalidCached }
  });
});

// Admin: list all licenses
app.get("/api/admin/licenses", requireAdmin, (req, res) => {
  const licenses = getLicenses();
  const devices  = readJSON(DEVICES_FILE);
  const usage    = getUsage();
  const result = Object.entries(licenses).map(([key, lic]) => ({
    key, ...lic,
    deviceCount: (devices[key]?.list || []).filter(d => !d.revoked).length,
    creditsUsed: usage[key]?.creditsUsed || 0
  }));
  res.json({ licenses: result });
});

// Admin: create license
app.post("/api/admin/licenses/create", requireAdmin, (req, res) => {
  const { tier, maxDevices, features, label, color, creditsEnabled, creditsTotal, expiresAfterDays, note } = req.body;
  if (!tier || !maxDevices) return res.status(400).json({ error: "Tier and maxDevices required." });

  const key = `${crypto.randomUUID()}`;
  const licenses = getLicenses();
  licenses[key] = {
    tier, maxDevices: parseInt(maxDevices),
    features: features || [],
    label: label || tier.toUpperCase(),
    color: color || "#1a7fff",
    creditsEnabled: !!creditsEnabled,
    creditsTotal: parseInt(creditsTotal) || 0,
    active: true,
    createdAt: new Date().toISOString(),
    note: note || "",
    ...(expiresAfterDays ? { expiresAfterDays: parseInt(expiresAfterDays) } : {})
  };
  saveLicenses(licenses);
  res.json({ ok: true, key, license: licenses[key] });
});

// Admin: update license
app.put("/api/admin/licenses/:key", requireAdmin, (req, res) => {
  const { key } = req.params;
  const licenses = getLicenses();
  if (!licenses[key]) return res.status(404).json({ error: "License not found." });
  const { tier, maxDevices, features, label, color, creditsEnabled, creditsTotal, active, expiresAfterDays, note } = req.body;
  if (tier !== undefined) licenses[key].tier = tier;
  if (maxDevices !== undefined) licenses[key].maxDevices = parseInt(maxDevices);
  if (features !== undefined) licenses[key].features = features;
  if (label !== undefined) licenses[key].label = label;
  if (color !== undefined) licenses[key].color = color;
  if (creditsEnabled !== undefined) licenses[key].creditsEnabled = !!creditsEnabled;
  if (creditsTotal !== undefined) licenses[key].creditsTotal = parseInt(creditsTotal);
  if (active !== undefined) licenses[key].active = !!active;
  if (expiresAfterDays !== undefined) licenses[key].expiresAfterDays = expiresAfterDays ? parseInt(expiresAfterDays) : null;
  if (note !== undefined) licenses[key].note = note;
  licenses[key].updatedAt = new Date().toISOString();
  saveLicenses(licenses);
  res.json({ ok: true, license: licenses[key] });
});

// Admin: delete license
app.delete("/api/admin/licenses/:key", requireAdmin, (req, res) => {
  const { key } = req.params;
  const licenses = getLicenses();
  if (!licenses[key]) return res.status(404).json({ error: "License not found." });
  delete licenses[key];
  saveLicenses(licenses);
  // Kill sessions for this license
  const sessions = readJSON(SESSIONS_FILE);
  for (const [tok, s] of Object.entries(sessions)) {
    if (s.licenseKey === key) delete sessions[tok];
  }
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ ok: true });
});

// Admin: add/set credits
app.post("/api/admin/licenses/:key/credits", requireAdmin, (req, res) => {
  const { key } = req.params;
  const { amount, mode } = req.body; // mode: 'add' | 'set' | 'reset'
  const licenses = getLicenses();
  if (!licenses[key]) return res.status(404).json({ error: "License not found." });

  const usage = getUsage();
  if (!usage[key]) usage[key] = { creditsUsed: 0, history: [] };

  if (mode === "reset") {
    usage[key].creditsUsed = 0;
    usage[key].history = [];
  } else if (mode === "set") {
    licenses[key].creditsTotal = parseInt(amount) || 0;
    licenses[key].creditsEnabled = true;
  } else { // add
    licenses[key].creditsTotal = (licenses[key].creditsTotal || 0) + (parseInt(amount) || 0);
    licenses[key].creditsEnabled = true;
  }

  saveLicenses(licenses);
  saveUsage(usage);
  res.json({ ok: true, creditsTotal: licenses[key].creditsTotal, creditsUsed: usage[key].creditsUsed });
});

// Admin: get usage history for a license
app.get("/api/admin/licenses/:key/usage", requireAdmin, (req, res) => {
  const { key } = req.params;
  const usage = getUsage();
  res.json({ usage: usage[key] || { creditsUsed: 0, history: [] } });
});

// Admin: get all devices across all licenses
app.get("/api/admin/devices", requireAdmin, (req, res) => {
  const devices  = readJSON(DEVICES_FILE);
  const sessions = readJSON(SESSIONS_FILE);
  const licenses = getLicenses();

  const onlineDevices = new Set(Object.values(sessions)
    .filter(s => (Date.now() - new Date(s.lastSeen).getTime()) < 60000)
    .map(s => s.deviceId));

  const result = [];
  for (const [licKey, licData] of Object.entries(devices)) {
    const lic = licenses[licKey] || {};
    for (const dev of (licData.list || [])) {
      result.push({ ...dev, licenseKey: licKey, licenseTier: lic.tier || "?", online: onlineDevices.has(dev.deviceId) });
    }
  }
  res.json({ devices: result, total: result.length, online: result.filter(d => d.online).length });
});

// Admin: revoke any device
app.post("/api/admin/devices/revoke", requireAdmin, (req, res) => {
  const { deviceId, licenseKey } = req.body;
  const devices = readJSON(DEVICES_FILE);
  const devList = devices[licenseKey]?.list || [];
  const dev = devList.find(d => d.deviceId === deviceId);
  if (!dev) return res.status(404).json({ error: "Device not found." });
  dev.revoked = true;
  writeJSON(DEVICES_FILE, devices);
  const sessions = readJSON(SESSIONS_FILE);
  for (const [tok, s] of Object.entries(sessions)) {
    if (s.deviceId === deviceId) delete sessions[tok];
  }
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ ok: true });
});

// Admin: email cache stats
app.get("/api/admin/email-cache", requireAdmin, (req, res) => {
  const cache = getEmailCache();
  const entries = Object.entries(cache);
  const valid   = entries.filter(([, v]) => v.status === "valid").length;
  const invalid = entries.filter(([, v]) => v.status === "invalid").length;
  const disposable = entries.filter(([, v]) => v.status === "disposable").length;

  // Domain breakdown
  const domains = {};
  for (const [, v] of entries) {
    if (!domains[v.domain]) domains[v.domain] = { valid: 0, invalid: 0 };
    if (v.status === "valid") domains[v.domain].valid++;
    else domains[v.domain].invalid++;
  }
  const topDomains = Object.entries(domains)
    .map(([d, c]) => ({ domain: d, ...c, total: c.valid + c.invalid }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  res.json({ total: entries.length, valid, invalid, disposable, topDomains });
});

// Admin: clear email cache
app.post("/api/admin/email-cache/clear", requireAdmin, (req, res) => {
  const { olderThanDays = 0 } = req.body;
  const cleared = clearEmailCache(parseInt(olderThanDays));
  res.json({ ok: true, cleared });
});

// Admin: export valid/invalid emails from cache
app.get("/api/admin/email-cache/export/:type", requireAdmin, (req, res) => {
  const cache = getEmailCache();
  const type  = req.params.type; // 'valid' | 'invalid' | 'all'
  let emails;
  if (type === "valid")   emails = Object.entries(cache).filter(([, v]) => v.status === "valid").map(([e]) => e);
  else if (type === "invalid") emails = Object.entries(cache).filter(([, v]) => v.status !== "valid").map(([e]) => e);
  else emails = Object.keys(cache);
  res.json({ emails, count: emails.length });
});

// ╔══════════════════════════════════════════════════════════════╗
//  LICENSE & SESSION ROUTES
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/license/activate", async (req, res) => {
  const { licenseKey, deviceId, deviceName } = req.body;
  const ip = getIP(req);
  const ua = req.headers["user-agent"] || "";

  const lic = getLicense(licenseKey);
  if (!lic) return res.status(400).json({ success: false, error: "Invalid license key." });
  if (!lic.active) return res.status(403).json({ success: false, error: "This license has been deactivated." });

  // Check trial expiry
  if (lic.expiresAfterDays) {
    const age = (Date.now() - new Date(lic.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (age > lic.expiresAfterDays) {
      return res.status(403).json({ success: false, error: "Trial license expired." });
    }
  }

  const devices = readJSON(DEVICES_FILE);
  if (!devices[licenseKey]) devices[licenseKey] = { list: [] };

  const devList = devices[licenseKey].list;
  let existing  = devList.find(d => d.deviceId === deviceId);

  if (!existing) {
    const activeDevices = devList.filter(d => !d.revoked);
    if (activeDevices.length >= lic.maxDevices) {
      return res.status(403).json({
        success: false,
        error: `Device limit reached (${lic.maxDevices}/${lic.maxDevices}). Revoke another device first.`,
        limitReached: true,
        devices: devList
      });
    }
    const geo = await geoIP(ip);
    const parsedUA = parseUA(ua);
    const newDevice = {
      deviceId,
      deviceName: deviceName || `${parsedUA.os} / ${parsedUA.browser}`,
      ip, geo, os: parsedUA.os, browser: parsedUA.browser,
      flagged: false, revoked: false,
      firstSeen: new Date().toISOString(),
      lastSeen:  new Date().toISOString(),
      ua
    };
    devList.push(newDevice);
    existing = newDevice;
  } else {
    if (existing.revoked) return res.status(403).json({ success: false, error: "This device has been revoked." });
    existing.lastSeen = new Date().toISOString();
    existing.ip = ip;
  }

  devices[licenseKey].list = devList;
  writeJSON(DEVICES_FILE, devices);

  const token = createSession(licenseKey, deviceId, ip, ua);
  const usage = getUsage();
  const creditsUsed     = usage[licenseKey]?.creditsUsed || 0;
  const creditsRemaining = lic.creditsEnabled ? Math.max(0, (lic.creditsTotal || 0) - creditsUsed) : null;

  res.json({
    success: true, token,
    tier: lic.tier, label: lic.label, color: lic.color,
    features: lic.features, maxDevices: lic.maxDevices,
    deviceCount: devList.filter(d => !d.revoked).length,
    creditsEnabled: lic.creditsEnabled,
    creditsRemaining,
    creditsTotal: lic.creditsTotal,
    device: existing
  });
});

app.post("/api/session/verify", (req, res) => {
  const token = req.headers["x-session-token"] || req.body?.token;
  const session = getSession(token);
  if (!session) return res.json({ valid: false });
  const lic = getLicense(session.licenseKey);
  if (!lic || !lic.active) return res.json({ valid: false, error: "License inactive." });

  const devices = readJSON(DEVICES_FILE);
  const dev = devices[session.licenseKey]?.list?.find(d => d.deviceId === session.deviceId);
  if (dev?.revoked) return res.json({ valid: false, error: "Device revoked." });

  const usage = getUsage();
  const creditsUsed      = usage[session.licenseKey]?.creditsUsed || 0;
  const creditsRemaining = lic.creditsEnabled ? Math.max(0, (lic.creditsTotal || 0) - creditsUsed) : null;

  res.json({
    valid: true,
    tier: lic.tier, label: lic.label, color: lic.color,
    features: lic.features, maxDevices: lic.maxDevices,
    creditsEnabled: lic.creditsEnabled,
    creditsRemaining, creditsTotal: lic.creditsTotal,
    session: { createdAt: session.createdAt, lastSeen: session.lastSeen, ip: session.ip }
  });
});

app.post("/api/session/heartbeat", requireAuth, (req, res) => {
  const lic = req.license;
  const usage = getUsage();
  const creditsUsed      = usage[req.session.licenseKey]?.creditsUsed || 0;
  const creditsRemaining = lic.creditsEnabled ? Math.max(0, (lic.creditsTotal || 0) - creditsUsed) : null;
  res.json({ ok: true, ts: new Date().toISOString(), creditsRemaining });
});

app.post("/api/session/logout", (req, res) => {
  const token = req.headers["x-session-token"] || req.body?.token;
  destroySession(token);
  res.json({ ok: true });
});

// ─── Device Management ────────────────────────────────────────
app.get("/api/license/devices", requireAuth, (req, res) => {
  const devices  = readJSON(DEVICES_FILE);
  const sessions = readJSON(SESSIONS_FILE);
  const devList  = devices[req.session.licenseKey]?.list || [];
  const lic      = req.license;

  const onlineDevices = new Set(Object.values(sessions)
    .filter(s => s.licenseKey === req.session.licenseKey && (Date.now() - new Date(s.lastSeen).getTime()) < 60000)
    .map(s => s.deviceId));

  const enriched = devList.map(d => ({
    ...d,
    online: onlineDevices.has(d.deviceId),
    isSelf: d.deviceId === req.session.deviceId
  }));

  res.json({
    devices: enriched,
    total: enriched.length,
    active: enriched.filter(d => !d.revoked).length,
    online: enriched.filter(d => d.online).length,
    maxDevices: lic.maxDevices
  });
});

app.post("/api/license/devices/revoke", requireAuth, (req, res) => {
  const { deviceId } = req.body;
  const devices = readJSON(DEVICES_FILE);
  const devList = devices[req.session.licenseKey]?.list || [];
  const dev = devList.find(d => d.deviceId === deviceId);
  if (!dev) return res.status(404).json({ error: "Device not found." });
  dev.revoked = true;
  writeJSON(DEVICES_FILE, devices);
  const sessions = readJSON(SESSIONS_FILE);
  Object.entries(sessions).forEach(([tok, s]) => {
    if (s.deviceId === deviceId) delete sessions[tok];
  });
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ ok: true });
});

app.post("/api/license/devices/flag", requireAuth, (req, res) => {
  const { deviceId, flagged } = req.body;
  const devices = readJSON(DEVICES_FILE);
  const dev = devices[req.session.licenseKey]?.list?.find(d => d.deviceId === deviceId);
  if (!dev) return res.status(404).json({ error: "Device not found." });
  dev.flagged = flagged;
  writeJSON(DEVICES_FILE, devices);
  res.json({ ok: true });
});

app.post("/api/license/devices/rename", requireAuth, (req, res) => {
  const { deviceId, name } = req.body;
  const devices = readJSON(DEVICES_FILE);
  const dev = devices[req.session.licenseKey]?.list?.find(d => d.deviceId === deviceId);
  if (!dev) return res.status(404).json({ error: "Device not found." });
  dev.deviceName = name;
  writeJSON(DEVICES_FILE, devices);
  res.json({ ok: true });
});

// ╔══════════════════════════════════════════════════════════════╗
//  TEMPLATE MANAGER
// ╚══════════════════════════════════════════════════════════════╝

app.get("/api/templates", requireAuth, (req, res) => {
  const tpls = readJSON(TEMPLATES_FILE);
  res.json({ templates: tpls[req.session.licenseKey] || [] });
});

app.post("/api/templates/save", requireAuth, (req, res) => {
  const { id, name, subject, html, tags } = req.body;
  if (!name || !html) return res.status(400).json({ error: "Name and HTML required." });
  const tpls = readJSON(TEMPLATES_FILE);
  if (!tpls[req.session.licenseKey]) tpls[req.session.licenseKey] = [];
  const list = tpls[req.session.licenseKey];
  const existing = id && list.find(t => t.id === id);
  if (existing) {
    existing.name = name; existing.subject = subject; existing.html = html;
    existing.tags = tags || []; existing.updatedAt = new Date().toISOString();
  } else {
    list.push({ id: crypto.randomUUID(), name, subject, html, tags: tags || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  writeJSON(TEMPLATES_FILE, tpls);
  res.json({ ok: true });
});

app.delete("/api/templates/:id", requireAuth, (req, res) => {
  const tpls = readJSON(TEMPLATES_FILE);
  if (!tpls[req.session.licenseKey]) return res.status(404).json({ error: "Not found." });
  tpls[req.session.licenseKey] = tpls[req.session.licenseKey].filter(t => t.id !== req.params.id);
  writeJSON(TEMPLATES_FILE, tpls);
  res.json({ ok: true });
});

// ╔══════════════════════════════════════════════════════════════╗
//  SMTP TESTER (SSE)
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/smtp/test", requireAuth, requireFeature("smtp_test"), async (req, res) => {
  sseSetup(res);
  const entries = req.body.entries || [];
  if (!entries.length) { sseSend(res, { type:"error", message:"No SMTP entries." }); return res.end(); }

  const working = [], failed = [];

  for (let i = 0; i < entries.length; i++) {
    const { host, user, pass, port } = entries[i];
    const portNum = parseInt(port, 10);
    sseSend(res, { type:"progress", index:i, total:entries.length, user, host, port:portNum });

    const transporter = nodemailer.createTransport({
      host, port: portNum,
      secure: portNum === 465,
      requireTLS: portNum === 587 || portNum === 25,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 12000,
      greetingTimeout: 8000
    });

    try {
      await transporter.verify();
      working.push({ host, user, pass, port: portNum });
      sseSend(res, { type:"result", index:i, status:"ok", host, user, port:portNum });
    } catch (err) {
      failed.push({ host, user, port: portNum, error: err.message });
      sseSend(res, { type:"result", index:i, status:"fail", host, user, port:portNum, error:err.message });
    }
  }

  sseSend(res, { type:"done", working, failed, total:entries.length, workingCount:working.length, failedCount:failed.length });
  res.end();
});

app.post("/api/smtp/parse-file", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file." });
  const lines = req.file.buffer.toString("utf8").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const entries = [], errors = [];
  for (let i=0;i<lines.length;i++) {
    const parts = lines[i].split("|").map(p=>p.trim());
    if (parts.length !== 4 || !parts.every(Boolean) || !parseInt(parts[3])) {
      errors.push({ line: i+1, raw: lines[i] }); continue;
    }
    entries.push({ host: parts[0], user: parts[1], pass: parts[2], port: parts[3] });
  }
  res.json({ entries, errors, count: entries.length });
});

// ╔══════════════════════════════════════════════════════════════╗
//  SEND BULK (SSE)
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/send/bulk", requireAuth, requireFeature("send_bulk"), async (req, res) => {
  sseSetup(res);
  const { smtp, recipients, subject, fromName, htmlBody, replyTo, throttle=5, delayMs=2000 } = req.body;
  if (!smtp||!recipients?.length||!htmlBody||!subject) { sseSend(res,{type:"error",message:"Missing required fields."}); return res.end(); }

  const { host, user, pass, port } = smtp;
  const portNum = parseInt(port);
  const transporter = nodemailer.createTransport({
    host, port:portNum, secure:portNum===465, requireTLS:portNum===587,
    auth:{user,pass}, tls:{rejectUnauthorized:false}, connectionTimeout:12000
  });

  // Fix 1: Server-side dedup — prevent duplicate SMTP calls even if frontend is bypassed
  const uniqueRecipients = [...new Set(recipients.map(r => r.trim().toLowerCase()))];
  const dedupedCount = recipients.length - uniqueRecipients.length;
  if (dedupedCount > 0) console.log(`[bulk] Removed ${dedupedCount} duplicate recipient(s).`);

  const fromAddr = `"${fromName||"Sender"}" <${user}>`;
  const sent=[], failed=[];
  sseSend(res,{type:"start",total:uniqueRecipients.length,dedupedCount});

  for (let i=0;i<uniqueRecipients.length;i++) {
    const email = uniqueRecipients[i];
    try {
      await transporter.sendMail({ from:fromAddr, to:email, subject, html:htmlBody, ...(replyTo?{replyTo}:{}) });
      sent.push(email);
      sseSend(res,{type:"sent",index:i,email,total:uniqueRecipients.length,sentCount:sent.length,failCount:failed.length});
    } catch(err) {
      failed.push({email,error:err.message});
      sseSend(res,{type:"failed",index:i,email,error:err.message,total:uniqueRecipients.length,sentCount:sent.length,failCount:failed.length});
    }
    if (throttle>0&&(i+1)%throttle===0&&(i+1)<uniqueRecipients.length) {
      sseSend(res,{type:"throttle",delayMs}); await sleep(delayMs);
    }
  }

  const elapsed = "0.0";
  sseSend(res,{type:"done",sent,failed,total:uniqueRecipients.length,sentCount:sent.length,failCount:failed.length,elapsed,dedupedCount});
  res.end();
});

// ╔══════════════════════════════════════════════════════════════╗
//  SEND PERSONALIZED (SSE)
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/send/personalized", requireAuth, requireFeature("send_personal"), async (req, res) => {
  sseSetup(res);
  const { smtp, leadsText, subject, fromName, htmlTemplate, replyTo, throttle=5, delayMs=2000 } = req.body;
  if (!smtp||!leadsText||!htmlTemplate||!subject) { sseSend(res,{type:"error",message:"Missing fields."}); return res.end(); }

  const leads = parseLeads(leadsText);
  const { host, user, pass, port } = smtp;
  const portNum = parseInt(port);
  const transporter = nodemailer.createTransport({
    host, port:portNum, secure:portNum===465, requireTLS:portNum===587,
    auth:{user,pass}, tls:{rejectUnauthorized:false}, connectionTimeout:12000
  });

  const fromAddr = `"${fromName||"Sender"}" <${user}>`;
  const sent=[], failed=[];
  sseSend(res,{type:"start",total:leads.length});

  for (let i=0;i<leads.length;i++) {
    const {email,name}=leads[i];
    const html = renderTemplate(htmlTemplate,{name,email,first_name:name.split(" ")[0]});
    const subj = renderTemplate(subject,{name,email,first_name:name.split(" ")[0]});
    try {
      await transporter.sendMail({ from:fromAddr, to:email, subject:subj, html, ...(replyTo?{replyTo}:{}) });
      sent.push({email,name});
      sseSend(res,{type:"sent",index:i,email,name,total:leads.length,sentCount:sent.length,failCount:failed.length});
    } catch(err) {
      failed.push({email,name,error:err.message});
      sseSend(res,{type:"failed",index:i,email,name,error:err.message,total:leads.length,sentCount:sent.length,failCount:failed.length});
    }
    if (throttle>0&&(i+1)%throttle===0&&(i+1)<leads.length) { sseSend(res,{type:"throttle",delayMs}); await sleep(delayMs); }
  }

  sseSend(res,{type:"done",sent,failed,total:leads.length,sentCount:sent.length,failCount:failed.length});
  res.end();
});

// ╔══════════════════════════════════════════════════════════════╗
//  EMAIL VALIDATOR (SSE) — WITH CACHE
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/emails/validate", requireAuth, requireFeature("validate"), async (req, res) => {
  sseSetup(res);
  const licenseKey = req.session.licenseKey;

  // Always guarantee the stream ends — even on unhandled errors.
  // FIX: never include the full valid/invalid arrays in the done payload.
  // Results are already streamed per-item; sending 10k emails in one
  // res.write() call overflows Node's HTTP response buffer and crashes the stream.
  const safeEnd = (extra = {}) => {
    try { sseSend(res, { type: "done", ...extra }); } catch {}
    try { res.end(); } catch {}
  };

  const { emailsText, concurrency = 15 } = req.body;
  if (!emailsText) { return safeEnd({ error: "No emails." }); }

  const emails = emailsText.split(/[\r\n]+/).map(l => l.trim().toLowerCase()).filter(l => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l));
  const unique = [...new Set(emails)];
  if (!unique.length) { return safeEnd({ error: "No valid email addresses found." }); }

  const disposableDomains = new Set(["mailinator.com","guerrillamail.com","tempmail.com","10minutemail.com","throwaway.email","yopmail.com","sharklasers.com","guerrillamailblock.com","grr.la","guerrillamail.info","guerrillamail.biz","guerrillamail.de","guerrillamail.net","guerrillamail.org","spam4.me","trashmail.at","trashmail.io","trashmail.me","trashmail.net","trash-mail.at"]);

  // Count cache hits upfront so the client can show an accurate progress bar.
  const cached    = unique.filter(e => checkEmailCache(e) !== null).length;
  const needsScan = unique.length - cached;

  let validCount = 0, invalidCount = 0;

  sseSend(res, { type: "start", total: unique.length, dedupedFrom: emails.length, cached, needsScan });

  // ── Fast-path: everything is already cached ──────────────────────────────
  // Skip the batch loop entirely and stream results without any DNS work.
  // This also avoids the synchronous-flood problem where 10k cache hits fire
  // thousands of res.write() calls with no event-loop yields.
  if (needsScan === 0) {
    for (let i = 0; i < unique.length; i++) {
      const email  = unique[i];
      const domain = email.split("@")[1] || "";
      const hit    = checkEmailCache(email);
      const status = hit ? hit.status : "invalid";
      if (status === "valid") validCount++; else invalidCount++;
      sseSend(res, { type: "result", index: i, email, status, domain, fromCache: true, total: unique.length });
      // Yield every 200 emails so the TCP buffer can drain between writes.
      if ((i + 1) % 200 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    const validPercent = ((validCount / unique.length) * 100).toFixed(1);
    return safeEnd({ total: unique.length, validCount, invalidCount, validPercent, dedupedFrom: emails.length, cached });
  }

  // ── Normal path: mix of cache hits and live DNS checks ───────────────────
  const mxCache = {};

  try {
    for (let i = 0; i < unique.length; i += concurrency) {
      const batch   = unique.slice(i, i + concurrency);
      const toCache = [];

      await Promise.all(batch.map(async (email, bi) => {
        const idx    = i + bi;
        const domain = email.split("@")[1] || "";

        try {
          // ── Cache hit ──────────────────────────────────────────────────
          const hit = checkEmailCache(email);
          if (hit) {
            if (hit.status === "valid") validCount++; else invalidCount++;
            sseSend(res, { type: "result", index: idx, email, status: hit.status, domain, fromCache: true, total: unique.length });
            return;
          }

          // ── Live DNS check ─────────────────────────────────────────────
          const isDisposable = disposableDomains.has(domain);
          if (mxCache[domain] === undefined) {
            try {
              const mx = await dns.resolveMx(domain);
              mxCache[domain] = mx?.length > 0;
            } catch { mxCache[domain] = false; }
          }

          const hasMX  = mxCache[domain];
          const status = !hasMX ? "invalid" : isDisposable ? "disposable" : "valid";
          const reason = !hasMX ? "no_mx" : "disposable";

          toCache.push({ email, status, reason: status !== "valid" ? reason : null, domain, licenseKey });

          if (status === "valid") validCount++; else invalidCount++;
          sseSend(res, { type: "result", index: idx, email, status, domain, hasMX, isDisposable, fromCache: false, total: unique.length });
        } catch (emailErr) {
          invalidCount++;
          sseSend(res, { type: "result", index: idx, email, status: "invalid", domain, fromCache: false, total: unique.length, error: emailErr.message });
        }
      }));

      // Flush new results to cache in one write.
      if (toCache.length) cacheEmailResults(toCache);

      // Yield the event loop after every batch so the TCP send buffer can
      // drain. Without this, all-cached batches resolve synchronously and
      // thousands of res.write() calls stack up until the stream crashes.
      await new Promise(resolve => setImmediate(resolve));
    }

    const validPercent = ((validCount / unique.length) * 100).toFixed(1);
    safeEnd({ total: unique.length, validCount, invalidCount, validPercent, dedupedFrom: emails.length, cached });

  } catch (fatalErr) {
    const validPercent = unique.length > 0 ? ((validCount / unique.length) * 100).toFixed(1) : "0.0";
    safeEnd({ total: unique.length, validCount, invalidCount, validPercent, dedupedFrom: emails.length, cached, error: fatalErr.message });
  }
});

// ─── User cache export (own token only) ──────────────────────
app.get("/api/emails/cache/my/export", requireAuth, (req, res) => {
  const licenseKey = req.session.licenseKey;
  const type = req.query.type || "all"; // 'valid' | 'invalid' | 'all'
  const cache = getEmailCache();
  const mine  = Object.entries(cache).filter(([, v]) => v.licenseKey === licenseKey);
  let emails;
  if (type === "valid")        emails = mine.filter(([, v]) => v.status === "valid").map(([e]) => e);
  else if (type === "invalid") emails = mine.filter(([, v]) => v.status !== "valid").map(([e]) => e);
  else                         emails = mine.map(([e]) => e);
  res.json({ emails, count: emails.length, type });
});

// ─── User cache view (own token only) ────────────────────────
app.get("/api/emails/cache/my", requireAuth, (req, res) => {
  const licenseKey = req.session.licenseKey;
  const cache  = getEmailCache();
  const mine   = Object.entries(cache).filter(([, v]) => v.licenseKey === licenseKey);
  const valid  = mine.filter(([, v]) => v.status === "valid").map(([e]) => e);
  const invalid = mine.filter(([, v]) => v.status === "invalid").map(([e, v]) => ({ email: e, reason: v.reason, domain: v.domain }));
  const disposable = mine.filter(([, v]) => v.status === "disposable").map(([e]) => e);

  // Domain breakdown
  const domains = {};
  for (const [, v] of mine) {
    if (!domains[v.domain]) domains[v.domain] = { valid: 0, invalid: 0, total: 0 };
    if (v.status === "valid") domains[v.domain].valid++;
    else domains[v.domain].invalid++;
    domains[v.domain].total++;
  }
  const topDomains = Object.entries(domains)
    .map(([d, c]) => ({ domain: d, ...c }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);

  // Most recent entries
  const recent = mine
    .sort((a, b) => new Date(b[1].cachedAt) - new Date(a[1].cachedAt))
    .slice(0, 200)
    .map(([email, v]) => ({ email, status: v.status, domain: v.domain, cachedAt: v.cachedAt }));

  res.json({
    total: mine.length, validCount: valid.length,
    invalidCount: invalid.length + disposable.length,
    disposableCount: disposable.length,
    topDomains, recent, valid, invalid
  });
});

// ╔══════════════════════════════════════════════════════════════╗
//  EMAIL SORTER
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/emails/sort", requireAuth, requireFeature("sort"), (req, res) => {
  const { emailsText } = req.body;
  if (!emailsText) return res.status(400).json({ error: "No emails." });
  const emails = parseEmails(emailsText);
  const buckets = {};
  for (const e of emails) {
    const d = e.split("@")[1] || "unknown";
    if (!buckets[d]) buckets[d]=[];
    buckets[d].push(e);
  }
  const sorted = Object.entries(buckets)
    .sort((a,b)=>b[1].length-a[1].length)
    .map(([domain,list])=>({domain,count:list.length,percent:((list.length/emails.length)*100).toFixed(1),emails:list}));
  res.json({ sorted, total:emails.length, domainCount:sorted.length });
});

// ╔══════════════════════════════════════════════════════════════╗
//  DEDUPLICATOR
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/emails/dedupe", requireAuth, requireFeature("dedupe"), (req, res) => {
  const { emailsText } = req.body;
  if (!emailsText) return res.status(400).json({ error: "No emails." });
  const all = emailsText.split(/[\r\n]+/).map(l=>l.trim().toLowerCase()).filter(l=>l.includes("@"));
  const seen = new Set(), unique=[], dupes=[];
  for (const e of all) {
    if (seen.has(e)) dupes.push(e);
    else { seen.add(e); unique.push(e); }
  }
  res.json({ unique, dupes, total:all.length, uniqueCount:unique.length, dupeCount:dupes.length });
});

// ╔══════════════════════════════════════════════════════════════╗
//  SPF / DKIM CHECKER
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/tools/spf-dkim", requireAuth, requireFeature("spf_dkim"), async (req, res) => {
  const { domains } = req.body;
  if (!domains?.length) return res.status(400).json({ error: "No domains." });

  const results = await Promise.all(domains.map(async domain => {
    const result = { domain, spf: null, dkim: null, dmarc: null, mx: null };
    try {
      const txt  = await dns.resolveTxt(domain);
      const txts = txt.flat();
      const spfRecord = txts.find(t => t.startsWith("v=spf1"));
      result.spf = spfRecord
        ? { found: true, record: spfRecord, pass: !spfRecord.includes("-all") || spfRecord.includes("include:") }
        : { found: false };
      const dmarcTxt = await dns.resolveTxt(`_dmarc.${domain}`).catch(() => null);
      const dmarcRec = dmarcTxt?.flat()?.find(t => t.startsWith("v=DMARC1"));
      result.dmarc = dmarcRec
        ? { found: true, record: dmarcRec, policy: dmarcRec.match(/p=(\w+)/)?.[1] || "none" }
        : { found: false };
    } catch {}

    try {
      const commonSelectors = ["default","google","selector1","selector2","k1","mail","smtp","dkim","s1","s2"];
      for (const sel of commonSelectors) {
        try {
          const txt = await dns.resolveTxt(`${sel}._domainkey.${domain}`);
          const rec = txt.flat().find(t => t.includes("v=DKIM1") || t.includes("k=rsa"));
          if (rec) { result.dkim = { found: true, selector: sel, record: rec.slice(0,80)+"..." }; break; }
        } catch {}
      }
      if (!result.dkim) result.dkim = { found: false };
    } catch {}

    try {
      const mx = await dns.resolveMx(domain);
      result.mx = { found: true, records: mx.sort((a,b)=>a.priority-b.priority).slice(0,3).map(m=>({ host:m.exchange, priority:m.priority })) };
    } catch { result.mx = { found: false }; }

    return result;
  }));

  res.json({ results });
});

// ╔══════════════════════════════════════════════════════════════╗
//  BLACKLIST CHECKER
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/tools/blacklist", requireAuth, requireFeature("blacklist"), async (req, res) => {
  const { domains } = req.body;
  if (!domains?.length) return res.status(400).json({ error: "No domains." });

  const DNSBL_SERVERS = [
    "zen.spamhaus.org","bl.spamcop.net","b.barracudacentral.org",
    "dnsbl.sorbs.net","spam.dnsbl.sorbs.net","dnsbl-1.uceprotect.net",
    "truncate.gbudb.net","dnsbl.dronebl.org","all.s5h.net"
  ];

  const results = await Promise.all(domains.map(async domain => {
    const blacklisted = [], clean = [];
    await Promise.all(DNSBL_SERVERS.map(async bl => {
      try {
        await dns.resolve4(`${domain}.${bl}`);
        blacklisted.push(bl);
      } catch { clean.push(bl); }
    }));
    return { domain, blacklisted, clean, listedCount: blacklisted.length, total: DNSBL_SERVERS.length, isClean: blacklisted.length === 0 };
  }));

  res.json({ results });
});

// ╔══════════════════════════════════════════════════════════════╗
//  INBOX SCANNER (SSE)
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/inbox/scan", requireAuth, requireFeature("inbox_scan"), async (req, res) => {
  sseSetup(res);
  const { accounts, keywords, maxMessages=100, manualImap } = req.body;
  if (!accounts?.length || !keywords?.length) {
    sseSend(res,{type:"error",message:"Accounts and keywords required."}); return res.end();
  }

  const kws = keywords.map(k=>k.trim().toLowerCase()).filter(Boolean);
  const results=[];
  sseSend(res,{type:"start",total:accounts.length});

  for (let ai=0;ai<accounts.length;ai++) {
    const {email,password} = accounts[ai];
    sseSend(res,{type:"account_start",index:ai,email,total:accounts.length});
    try {
      const imapInfo = manualImap || await detectImap(email);
      // Fix 6: Guard against IMAP servers that accept the TCP connection but
      // never respond — without this the SSE stream hangs forever.
      const conn = await Promise.race([
        Imap.connect({
          imap:{ user:email, password, host:imapInfo.host, port:imapInfo.port,
                 tls:imapInfo.tls, autotls:!imapInfo.tls?"required":"never",
                 authTimeout:20000, tlsOptions:{rejectUnauthorized:false} }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("IMAP connect timeout (30s)")), 30000))
      ]);
      await conn.openBox("INBOX");
      const messages = await conn.search(["ALL"],{ bodies:["TEXT","HEADER.FIELDS (FROM TO SUBJECT DATE)"], markSeen:false });
      const limit = Math.min(messages.length, maxMessages);
      sseSend(res,{type:"account_info",email,messageCount:messages.length,scanning:limit});

      for (let mi=0;mi<limit;mi++) {
        const textPart = messages[mi].parts.find(p=>p.which==="TEXT");
        if (!textPart) continue;
        try {
          const parsed  = await simpleParser(textPart.body);
          const content = `${parsed.subject||""} ${parsed.text||""}`.toLowerCase();
          const matched = kws.filter(kw=>content.includes(kw));
          if (matched.length) {
            const match = { account:email, from:parsed.from?.text||"", date:parsed.date?new Date(parsed.date).toLocaleString():"", subject:parsed.subject||"(no subject)", matchedKeywords:matched };
            results.push(match);
            sseSend(res,{type:"match",match});
          }
        } catch {}
      }
      await conn.end();
      sseSend(res,{type:"account_done",email,index:ai,matchCount:results.filter(r=>r.account===email).length});
    } catch(err) {
      sseSend(res,{type:"account_error",email,index:ai,error:err.message});
    }
  }

  sseSend(res,{type:"done",results,totalScanned:accounts.length,matchCount:results.length});
  res.end();
});

// ╔══════════════════════════════════════════════════════════════╗
//  FILE UPLOAD HELPERS
// ╚══════════════════════════════════════════════════════════════╝

app.post("/api/upload/text", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file." });
  res.json({ content: req.file.buffer.toString("utf8"), filename: req.file.originalname });
});

app.post("/api/upload/html", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file." });
  res.json({ content: req.file.buffer.toString("utf8"), filename: req.file.originalname });
});

// ─── Health ───────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status:"ok", version:"3.1.0", ts:new Date().toISOString() }));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  BLUE MAILER v3.1 running → http://localhost:${PORT}`);
  console.log(`  Admin panel           → http://localhost:${PORT}/admin\n`);
});

// Fix 5: Express error middleware — catches anything passed via next(err)
// Must be defined AFTER all routes and have exactly 4 arguments.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error("[express error]", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error.", detail: err.message });
  }
});

// Fix 4: Prevent the process from crashing on unhandled async throws
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

module.exports = app;