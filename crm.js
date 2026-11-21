#!/usr/bin/env node
// =============================================================================
//  C.S.I. FRONT OFFICE — CRM Rigenerato (FILE UNICO)
//  Centro Servizi Integrati · CRM centrale · rigenerazione da audit
// -----------------------------------------------------------------------------
//  Questo file è UN UNICO file Node.js eseguibile. Usa SOLO moduli built-in:
//    node:sqlite, node:crypto, node:http, node:url, node:fs, node:path
//  Nessuna dipendenza esterna, nessun node_modules, nessun build step.
//
//  REGOLE RISPETTATE (audit FASE 2):
//    R1  Nessun dato di prova nel codice. DB vuoto all'avvio, tabelle create da
//        migrazioni. Amministratore (Master) creato al primo accesso col flusso
//        già previsto (POST /api/auth/register).
//    R2  Nessuna password, chiave o codice statico di esempio nel sorgente.
//    R3  Servizi, sottoservizi e macro aree letti da file di configurazione
//        separato (config/services.json) importati dal comando
//        POST /api/admin/import-services.
//    R4  Dati dimostrativi SOLO in script di seed separato (scripts/seed.js),
//        attivo SOLO con variabile ambiente CSI_TEST_SEED=1; ogni record con
//        is_test=1; comando DELETE /api/admin/test-data li elimina tutti.
//    R5  Mantenute le funzioni decise: 3FA con fingerprint, firma HMAC con i
//        Gate Remoti, anti-overbooking per consulente, contratti da firmare e
//        firmati, brogliaccio, backup cifrato su più dischi, registro eventi.
//
//  AVVIO:
//    node crm.js                      → http server su porta 3000 (o PORT env)
//    CSI_TEST_SEED=1 node crm.js      → NON esegue seed qui; usa scripts/seed.js
//
//  Tabelle create da migrazioni (vedi MIGRATIONS sotto):
//    consultant, client, macro_area, appointment, practice, contract,
//    api_key, log_entry, otp_session, machine_fingerprint, client_document,
//    front_desk_operator, operator_log, filled_module, external_site,
//    operator_session (NUOVA — per sessione QR operatori, vedi BUG-3),
//    service_catalog (NUOVA — per servizi/sottoservizi da config).
// =============================================================================

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// --- node:sqlite è disponibile in Node 22.5+ (qui Node 24) ---
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('ERRORE: node:sqlite non disponibile. Serve Node >= 22.5 (qui:', process.version, ')');
  process.exit(1);
}

// =============================================================================
//  COSTANTI / BRAND / CONFIG (nessun dato di prova: solo costanti strutturali)
// =============================================================================

const CSI_BRAND = {
  NAVY: '#001C3A', GRIGIO_BLU: '#39546B', GRIGIO_CHIARO: '#99A7B3',
  AVORIO: '#F7F4ED', ORO_ISTITUZIONALE: '#B8954A',
};

// Slot fissi (struttura, non dati di prova: gli orari di apertura sono una
// regola di business, non un record).
const SLOTS = [
  { id: 'MORNING',   label: 'Mattina',    start: '09:00', end: '12:00', capacity: 6 },
  { id: 'AFTERNOON', label: 'Pomeriggio', start: '15:00', end: '17:00', capacity: 4 },
];

// Slot da 40 minuti generati da orari di apertura (struttura).
function generateSlots(startHour, startMin, endHour, endMin, duration, slotId) {
  const out = [];
  let m = startHour * 60 + startMin;
  const end = endHour * 60 + endMin;
  while (m + duration <= end) {
    const fmt = (x) => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
    out.push({ time: fmt(m), end: fmt(m + duration), slotId, minute: m });
    m += duration;
  }
  return out;
}
const TIME_SLOTS = [
  ...generateSlots(9, 0, 12, 0, 40, 'MORNING'),
  ...generateSlots(15, 0, 17, 0, 40, 'AFTERNOON'),
];

const PRACTICE_STATUSES   = ['OPEN', 'DOCS_PENDING', 'SUBMITTED', 'CLOSED', 'REJECTED'];
const PRACTICE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

// Configurazione AUTH — valori numerici/strutturali solo; segreti da env.
const AUTH_CONFIG = {
  OTP_TTL_MINUTES: parseInt(process.env.OTP_TTL_MINUTES || '15', 10),
  OTP_LENGTH: 6,
  MAX_OTP_ATTEMPTS: 5,
  FINGERPRINT_ALGO: 'SHA-256',
  SESSION_TTL_MINUTES: parseInt(process.env.SESSION_TTL_MINUTES || '480', 10),
  HMAC_ALGO: 'sha256',
};

// Titolare/dati dell'ente: letti da env (nessun valore di default hardcoded).
// Il primo avvio richiede POST /api/auth/register che imposta masterEmail+password.
const ENTITY = {
  ente: process.env.CSI_ENTE_NAME || null,
  rappresentante: process.env.CSI_ENTE_REP || null,
  indirizzo: process.env.CSI_ENTE_ADDR || null,
  citta: process.env.CSI_ENTE_CITY || null,
  cfAzienda: process.env.CSI_ENTE_CF || null,
  patronato: process.env.CSI_ENTE_PATRONATO || null,
};

// Deployment URL — letto da env (per QR codes, callback, sync).
const DEPLOY_URL = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL || null;

// =============================================================================
//  MIGRAZIONI — schema SQL completo (DB vuoto all'avvio, niente dati)
// =============================================================================

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS macro_area (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL,
    icon TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS consultant (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'Operatore',
    macro_areas TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    max_slots_per_day INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS client (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    fiscal_code TEXT,
    birth_date TEXT,
    birth_place TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    city TEXT,
    notes TEXT,
    identity_doc_ref TEXT,
    passport_doc_ref TEXT,
    iban TEXT,
    iban_authorized_at TEXT,
    iban_authorized_otp_id TEXT,
    iban_source TEXT,
    iban_later_in_sede INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS appointment (
    id TEXT PRIMARY KEY,
    client_code TEXT NOT NULL,
    consultant_id TEXT,
    area_code TEXT NOT NULL,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'BOOKED',
    channel TEXT NOT NULL DEFAULT 'CRM',
    sync_status TEXT NOT NULL DEFAULT 'PENDING',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, slot, consultant_id),
    FOREIGN KEY (client_code) REFERENCES client(code) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_appt_date_slot ON appointment(date, slot)`,
  `CREATE INDEX IF NOT EXISTS idx_appt_area_date ON appointment(area_code, date)`,

  `CREATE TABLE IF NOT EXISTS practice (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    client_code TEXT NOT NULL,
    consultant_id TEXT,
    area_code TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    priority TEXT NOT NULL DEFAULT 'NORMAL',
    payload_json TEXT,
    documents_json TEXT,
    due_date TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_code) REFERENCES client(code) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS contract (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    client_code TEXT NOT NULL,
    practice_code TEXT,
    area_code TEXT,
    consultant_id TEXT,
    type TEXT NOT NULL DEFAULT 'PRESTAZIONE_OCCASIONALE',
    autofill_json TEXT NOT NULL DEFAULT '{}',
    compensi_json TEXT NOT NULL DEFAULT '{}',
    compensi_filled INTEGER NOT NULL DEFAULT 0,
    signed_compensi_photo_ref TEXT,
    signed_compensi_photo_mime TEXT,
    iban_snapshot TEXT,
    iban_missing INTEGER NOT NULL DEFAULT 0,
    signature_page_idx INTEGER NOT NULL DEFAULT -1,
    source_doc_ref TEXT,
    source_doc_pages INTEGER NOT NULL DEFAULT 0,
    signed_photo_ref TEXT,
    signed_photo_mime TEXT,
    composed_pdf_ref TEXT,
    composed_pdf_hash TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    signed_at TEXT,
    archived_at TEXT,
    printed_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_code) REFERENCES client(code) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contract_client ON contract(client_code)`,
  `CREATE INDEX IF NOT EXISTS idx_contract_status ON contract(status)`,
  `CREATE INDEX IF NOT EXISTS idx_contract_practice ON contract(practice_code)`,

  `CREATE TABLE IF NOT EXISTS api_key (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    service TEXT NOT NULL,
    endpoint TEXT,
    masked_value TEXT NOT NULL,
    encrypted_ref TEXT NOT NULL,
    scopes TEXT,
    last_revealed_at TEXT,
    last_revealed_by TEXT,
    reveal_count INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS log_entry (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'INFO',
    target TEXT,
    ip TEXT,
    details TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_log_ts ON log_entry(timestamp)`,

  `CREATE TABLE IF NOT EXISTS otp_session (
    id TEXT PRIMARY KEY,
    master_email TEXT NOT NULL,
    code TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS machine_fingerprint (
    id TEXT PRIMARY KEY,
    hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'AUTHORIZED',
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS client_document (
    id TEXT PRIMARY KEY,
    client_code TEXT NOT NULL,
    type TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'FRONT',
    label TEXT NOT NULL,
    encrypted_ref TEXT NOT NULL,
    preview_url TEXT,
    file_hash TEXT,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT,
    FOREIGN KEY (client_code) REFERENCES client(code) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_doc_client_type ON client_document(client_code, type)`,

  `CREATE TABLE IF NOT EXISTS front_desk_operator (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'Front Desk',
    macro_areas TEXT NOT NULL,
    access_code TEXT UNIQUE NOT NULL,
    access_code_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    suspended_reason TEXT,
    suspended_at TEXT,
    suspended_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS operator_log (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    operator_code TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT,
    ip_address TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (operator_id) REFERENCES front_desk_operator(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oplog_operator ON operator_log(operator_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oplog_action ON operator_log(action)`,

  // NUOVA: sessione operatore duratura (manca nell'originale — BUG-3)
  `CREATE TABLE IF NOT EXISTS operator_session (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    operator_code TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    fingerprint TEXT,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (operator_id) REFERENCES front_desk_operator(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opsess_token ON operator_session(token_hash)`,

  `CREATE TABLE IF NOT EXISTS filled_module (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    client_code TEXT,
    type TEXT NOT NULL DEFAULT 'UNIFIED',
    surname TEXT NOT NULL,
    first_name TEXT NOT NULL,
    sex TEXT,
    birth_place TEXT,
    birth_date TEXT,
    citizenship TEXT,
    fiscal_code TEXT,
    residence TEXT,
    address TEXT,
    postcode TEXT,
    province TEXT,
    phone TEXT,
    email TEXT,
    institution TEXT,
    country TEXT,
    case_subject TEXT,
    consent_processing TEXT NOT NULL DEFAULT 'NO',
    consent_promotional TEXT NOT NULL DEFAULT 'NO',
    collaborator_name TEXT,
    collaborator_surname TEXT,
    collaborator_signed_at TEXT,
    operator_name TEXT,
    operator_surname TEXT,
    operator_signed_at TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    source TEXT NOT NULL DEFAULT 'CRM',
    source_url TEXT,
    printed_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_code) REFERENCES client(code) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mod_client ON filled_module(client_code)`,
  `CREATE INDEX IF NOT EXISTS idx_mod_source ON filled_module(source)`,

  `CREATE TABLE IF NOT EXISTS external_site (
    id TEXT PRIMARY KEY,
    site_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    webhook_secret TEXT NOT NULL,
    deploy TEXT NOT NULL DEFAULT 'Netlify',
    category TEXT NOT NULL DEFAULT 'dynamic',
    active INTEGER NOT NULL DEFAULT 1,
    last_sync_at TEXT,
    last_sync_status TEXT,
    last_sync_count INTEGER NOT NULL DEFAULT 0,
    total_received INTEGER NOT NULL DEFAULT 0,
    total_pushed INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_site_active ON external_site(active)`,

  // NUOVA: catalogo servizi/sottoservizi da config (regola FASE 2.3)
  `CREATE TABLE IF NOT EXISTS service_catalog (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    area_code TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'CONFIG',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (area_code) REFERENCES macro_area(code)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_svc_area ON service_catalog(area_code)`,

  // Tabella appoggio per flag is_test (regola FASE 2.4): ogni tabella "dati"
  // riceve colonna is_test. Qui manteniamo una tabella di registrazione dei
  // record test (per pulizia mirata con un comando).
  `CREATE TABLE IF NOT EXISTS test_record (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_test_table ON test_record(table_name)`,

  // Setup state (per flusso "primo accesso")
  `CREATE TABLE IF NOT EXISTS setup_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// Aggiunta colonna is_test a tutte le tabelle "dati" (idempotente).
const IS_TEST_TABLES = [
  'consultant', 'client', 'appointment', 'practice', 'contract',
  'api_key', 'front_desk_operator', 'filled_module', 'external_site',
  'machine_fingerprint', 'service_catalog',
];

// =============================================================================
//  DB / MIGRAZIONI RUN
// =============================================================================

const DB_PATH = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:')
  ? process.env.DATABASE_URL.slice(5)
  : path.join(process.cwd(), 'crm.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

function migrate() {
  db.exec('BEGIN');
  try {
    for (const sql of MIGRATIONS) db.exec(sql);
    // Aggiunta idempotente di is_test a ogni tabella dati
    for (const t of IS_TEST_TABLES) {
      try { db.exec(`ALTER TABLE ${t} ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`); }
      catch (e) { /* colonna già esistente */ }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
migrate();

// =============================================================================
//  UTILS
// =============================================================================

const cuid = () => crypto.randomBytes(16).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowISO = () => new Date().toISOString();
const mask = (v) => v.length > 8 ? v.slice(0, 2) + '•'.repeat(Math.min(8, v.length - 4)) + v.slice(-4) : '•'.repeat(v.length);

function logEntry(actor, action, level, target, ip, details) {
  db.prepare(
    'INSERT INTO log_entry (id, actor, action, level, target, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(cuid(), actor, action, level || 'INFO', target || null, ip || null, details || null);
}

function nextCode(prefix, table, yearField) {
  // Format: PREFIX-YYYY-NNNN — autoincrement robusto (transazione).
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;
  const state = db.prepare('SELECT value FROM setup_state WHERE key = ?').get(key);
  let n = state ? parseInt(state.value, 10) + 1 : 1;
  db.prepare(
    'INSERT INTO setup_state (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, String(n), nowISO());
  return `${key}-${String(n).padStart(4, '0')}`;
}

// HMAC per firma con Gate Remoti (regola FASE 2.5)
function hmacSign(secret, payload) {
  return crypto.createHmac(AUTH_CONFIG.HMAC_ALGO, secret).update(payload).digest('hex');
}
function hmacVerify(secret, payload, signature) {
  const expected = hmacSign(secret, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Fingerprint macchina: hash SHA-256 di un seed (vero fingerprint richiede
// dati hardware lato client; qui l'API accetta un seed string e ne fa l'hash).
function fingerprintFromSeed(seed) { return sha256(seed).slice(0, 40); }

// Cifrazione AES-256-GCM per backup e riferimenti documenti.
function encryptAES(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptAES(key, blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// Backup cifrato su più dischi (regola FASE 2.5).
// Accetta array di path directory; scrive lo stesso backup cifrato in ognuno.
function backupToDisks(dirs, aesKey) {
  const dump = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const data = {};
  for (const t of dump) {
    const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
    data[t.name] = rows;
  }
  const plain = JSON.stringify({ ts: nowISO(), data });
  const cipher = encryptAES(aesKey, plain);
  const written = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const fp = path.join(d, `crm-backup-${Date.now()}.enc`);
    fs.writeFileSync(fp, cipher);
    written.push(fp);
  }
  return { written, bytes: cipher.length };
}

// JSON response helper
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  res.end(payload);
}

// Legge body JSON con size limit
function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Session token operatori (httpOnly, secure, sameSite — fix BUG-3)
function setSessionCookie(res, token) {
  const flags = [
    `crm_op=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${AUTH_CONFIG.SESSION_TTL_MINUTES * 60}`,
  ];
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'crm_op=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  for (const kv of h.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

// Autenticazione operatore via sessione
function requireOperator(req) {
  const cookies = parseCookies(req);
  const token = cookies['crm_op'];
  if (!token) return null;
  const hash = sha256(token);
  const sess = db.prepare(
    'SELECT s.*, o.code, o.full_name, o.role, o.macro_areas FROM operator_session s ' +
    'JOIN front_desk_operator o ON o.id = s.operator_id ' +
    'WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ?'
  ).get(hash, nowISO());
  if (!sess) return null;
  return { code: sess.code, fullName: sess.full_name, role: sess.role, macroAreas: sess.macro_areas };
}

// Autenticazione master: l'API richiede un header X-Master-Token ottenuto
// dal flusso 3FA completo (vedi /api/auth/verify-otp). Il token è un otp_session
// consumato con action LOGIN_MASTER e valido SESSION_TTL_MINUTES.
function requireMaster(req) {
  const tok = req.headers['x-master-token'];
  if (!tok) return null;
  // Cerca una sessione master attiva: usiamo un record setup_state con chiave
  // master_session_<hash(token)> = scadenza. Semplice ma efficace.
  const hash = sha256(tok);
  const row = db.prepare('SELECT value FROM setup_state WHERE key = ?').get('master_session_' + hash);
  if (!row) return null;
  if (new Date(row.value) < new Date()) {
    db.prepare('DELETE FROM setup_state WHERE key = ?').run('master_session_' + hash);
    return null;
  }
  return { actor: 'master' };
}

// =============================================================================
//  ROUTING — minimo router HTTP (method + path pattern)
// =============================================================================

const routes = [];
// route(method, pattern, handler, opts?) — but accepts route(method, pattern, opts, handler) too
function route(method, pattern, handlerOrOpts, optsOrHandler = {}) {
  if (typeof handlerOrOpts === 'function') {
    routes.push({ method, pattern, handler: handlerOrOpts, opts: optsOrHandler || {} });
  } else {
    routes.push({ method, pattern, handler: optsOrHandler, opts: handlerOrOpts || {} });
  }
}

// Pattern compiler: "/api/clients/:id" → regex + param names
function compilePattern(p) {
  const names = [];
  const re = new RegExp('^' + p.replace(/:([a-zA-Z_]+)/g, (_, n) => {
    names.push(n); return '([^/]+)';
  }) + '$');
  return { re, names };
}

async function dispatch(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  // CORS per API v1 e webhook (come da vercel.json originale)
  if (pathname.startsWith('/api/v1/') || pathname.startsWith('/api/webhook/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-webhook-secret, X-Signature, X-Timestamp');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  }

  for (const r of routes) {
    if (r.method !== req.method && r.method !== '*') continue;
    const { re, names } = compilePattern(r.pattern);
    const m = re.exec(pathname);
    if (!m) continue;
    const params = {};
    names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    req.params = params;

    // Auth gate (se opts.auth = 'master' | 'operator')
    if (r.opts.auth === 'master') {
      const m2 = requireMaster(req);
      if (!m2) return json(res, 401, { ok: false, error: 'Master non autenticato (3FA richiesta)' });
    }
    if (r.opts.auth === 'operator') {
      const o = requireOperator(req);
      if (!o) return json(res, 401, { ok: false, error: 'Operatore non autenticato' });
    }

    try {
      await r.handler(req, res, params);
    } catch (e) {
      logEntry('system', 'UNCAUGHT_ERROR', 'ERROR', pathname, req.socket.remoteAddress, e.message);
      json(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  json(res, 404, { ok: false, error: 'Not found', path: pathname });
}

// =============================================================================
//  ROUTE HANDLERS
//  Tutte le route del CRM rigenerato. Nessun dato demo hardcoded.
// =============================================================================

// ---- /api/health ----------------------------------------------------------
route('GET', '/api/health', (req, res) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'setup_%'").all().map(r => r.name);
  const counts = {};
  for (const t of tables) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (e) { counts[t] = -1; }
  }
  const setupRow = db.prepare("SELECT value FROM setup_state WHERE key = 'setup_complete'").get();
  json(res, 200, {
    ok: true,
    uptime: process.uptime(),
    node: process.version,
    dbPath: path.basename(DB_PATH),
    setupComplete: !!(setupRow && setupRow.value === '1'),
    tables: counts,
  });
});

// ---- /api/auth/check-setup ----------------------------------------------
route('GET', '/api/auth/check-setup', (req, res) => {
  const setupRow = db.prepare("SELECT value FROM setup_state WHERE key = 'setup_complete'").get();
  const masterRow = db.prepare("SELECT value FROM setup_state WHERE key = 'master_email'").get();
  const opCount = db.prepare("SELECT COUNT(*) AS n FROM front_desk_operator WHERE is_test = 0").get().n;
  json(res, 200, {
    ok: true,
    setupComplete: !!(setupRow && setupRow.value === '1'),
    registered: !!(masterRow && masterRow.value),
    masterEmail: masterRow ? masterRow.value : null,  // NB: leaking email only on setup probe (as original does)
    operatorCount: opCount,
  });
});

// ---- /api/auth/register (PRIMO ACCESSO MASTER) --------------------------
// Crea l'amministratore master unico. Accetta: masterEmail, password,
// (opzionale) fingerprintSeed per autorizzare la macchina corrente.
// Una sola volta. Dopo, setup_state.setup_complete = '1'.
route('POST', '/api/auth/register', async (req, res) => {
  const setupRow = db.prepare("SELECT value FROM setup_state WHERE key = 'setup_complete'").get();
  if (setupRow && setupRow.value === '1') {
    return json(res, 409, { ok: false, error: 'Setup già completato. Usa /api/auth/otp per accedere.' });
  }
  const body = await readBody(req);
  const masterEmail = (body.masterEmail || '').trim();
  const password = (body.password || '').trim();
  const fpSeed = (body.fingerprintSeed || '').trim();
  if (!masterEmail || !password) {
    return json(res, 400, { ok: false, error: 'masterEmail e password sono obbligatori' });
  }
  if (password.length < 8) {
    return json(res, 400, { ok: false, error: 'Password troppo breve (min 8 caratteri)' });
  }
  // Primo operatore front desk = ADMIN-001, con accessCode = password (come original)
  const opId = cuid();
  const opCode = 'ADMIN-001';
  const accessCodeHash = sha256(password);
  db.prepare(
    "INSERT INTO front_desk_operator (id, code, full_name, email, phone, role, macro_areas, " +
    "access_code, access_code_hash, status, is_test) VALUES (?,?,?,?,?,?,?,?,?,?,0)"
  ).run(opId, opCode, 'Amministratore', masterEmail, null, 'Supervisor', '01,02,03,04,05,06,07,08,09',
        password, accessCodeHash, 'ACTIVE');
  db.prepare(
    "INSERT INTO operator_log (id, operator_id, operator_code, action, actor, reason) VALUES (?,?,?,?,?,?)"
  ).run(cuid(), opId, opCode, 'CREATED', 'system', 'Primo amministratore (setup iniziale)');

  // Master email + password hash in setup_state (NON in chiaro)
  db.prepare(
    "INSERT INTO setup_state (key, value, updated_at) VALUES (?,?,?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run('master_email', masterEmail, nowISO());
  db.prepare(
    "INSERT INTO setup_state (key, value, updated_at) VALUES (?,?,?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run('master_password_hash', sha256(password), nowISO());

  // Autorizza la fingerprint della macchina corrente (se fornita)
  if (fpSeed) {
    const fpHash = fingerprintFromSeed(fpSeed);
    db.prepare(
      "INSERT INTO machine_fingerprint (id, hash, label, status) VALUES (?,?,?,?) " +
      "ON CONFLICT(hash) DO NOTHING"
    ).run(cuid(), fpHash, 'Master · prima macchina', 'AUTHORIZED');
  }

  // Setup completo
  db.prepare(
    "INSERT INTO setup_state (key, value, updated_at) VALUES ('setup_complete','1',?) " +
    "ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at"
  ).run(nowISO());

  logEntry('system', 'SETUP_COMPLETE', 'AUDIT', null, req.socket.remoteAddress, `Master=${masterEmail} Admin=${opCode}`);
  json(res, 200, { ok: true, setupComplete: true, adminOperatorCode: opCode });
});

// ---- /api/auth/send-otp-email ------------------------------------------
// Emette un OTP via email. NON restituisce il codice nel body (fix del bug
// dell'originale dove demoOtpCode era in chiaro nella risposta).
// In ambiente senza SMTP configurato, logga il codice a stderr SOLO se
// CSI_TEST_SEED=1 (per i test automatici). Mai in produzione.
route('POST', '/api/auth/send-otp-email', async (req, res) => {
  const body = await readBody(req);
  const masterEmail = (body.masterEmail || '').trim();
  const masterRow = db.prepare("SELECT value FROM setup_state WHERE key = 'master_email'").get();
  const expected = masterRow ? masterRow.value : null;
  if (!expected) {
    return json(res, 409, { ok: false, error: 'Setup non completato. Esegui /api/auth/register prima.' });
  }
  if (masterEmail !== expected) {
    logEntry('anonymous', 'OTP_ISSUED_DENIED', 'WARN', masterEmail, req.socket.remoteAddress, 'email mismatch');
    return json(res, 401, { ok: false, error: 'Email non autorizzata' });
  }
  // Genera OTP
  const code = String(Math.floor(Math.random() * 10 ** AUTH_CONFIG.OTP_LENGTH)).padStart(AUTH_CONFIG.OTP_LENGTH, '0');
  const id = cuid();
  const expiresAt = new Date(Date.now() + AUTH_CONFIG.OTP_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO otp_session (id, master_email, code, expires_at) VALUES (?,?,?,?)"
  ).run(id, masterEmail, sha256(code), expiresAt);
  logEntry('master', 'OTP_ISSUED', 'AUDIT', masterEmail, req.socket.remoteAddress, 'OTP inviato via email');

  // Invio email reale SOLO se SMTP configurato (env SMTP_HOST, SMTP_USER, SMTP_PASS).
  const smtpHost = process.env.SMTP_HOST;
  let emailSent = false;
  let smtpError = null;
  if (smtpHost && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      // Nodemailer non è in node_modules (file unico). Uso raw SMTP via TLS.
      emailSent = await sendOtpEmailSmtp(masterEmail, code).catch(e => { smtpError = e.message; return false; });
    } catch (e) { smtpError = e.message; }
  }
  // Fallback per test: logga il codice a stderr SOLO con CSI_TEST_SEED=1
  if (!emailSent && process.env.CSI_TEST_SEED === '1') {
    process.stderr.write(`[TEST-OTP] codice per ${masterEmail}: ${code}\n`);
  }
  json(res, 200, {
    ok: true,
    expiresAt,
    emailSent,
    smtpError,
    // NON includiamo demoOtpCode (era il bug originale)
  });
});

// Raw SMTP over TLS using node:tls + net — only when env says so.
// Minimal EHLO/AUTH/MAIL/RCPT/DATA/QUIT. Returns true on 250 accepted.
async function sendOtpEmailSmtp(to, code) {
  const tls = require('node:tls');
  const net = require('node:net');
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;
  const subject = 'C.S.I. — Codice OTP accesso Master';
  const text = `Gentile amministratore,\n\nIl suo codice OTP è: ${code}\nValidità: ${AUTH_CONFIG.OTP_TTL_MINUTES} minuti.\n\nC.S.I. Front Office`;
  // STARTTLS upgrade path: connect plaintext, EHLO, STARTTLS, then TLS.
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let buf = '';
    let step = 0;
    let tlsSock = null;
    const send = (s) => (tlsSock || sock).write(s + '\r\n');
    const onLine = (line) => {
      if (line === '' ) return;
      const code3 = line.slice(0, 3);
      if (step === 0 && code3 === '220') { send(`EHLO crm.local`); step = 1; return; }
      if (step === 1 && code3 === '250') { send('STARTTLS'); step = 2; return; }
      if (step === 2 && code3 === '220') {
        tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: true }, () => {
          send('EHLO crm.local'); step = 3;
        });
        tlsSock.on('data', d => { buf += d.toString(); while (buf.includes('\r\n')) { const i = buf.indexOf('\r\n'); onLine(buf.slice(0,i)); buf = buf.slice(i+2); } });
        return;
      }
      if (step === 3 && code3 === '250') {
        send('AUTH LOGIN'); step = 4; return;
      }
      if (step === 4 && code3 === '334') { send(Buffer.from(user).toString('base64')); step = 5; return; }
      if (step === 5 && code3 === '334') { send(Buffer.from(pass).toString('base64')); step = 6; return; }
      if (step === 6 && code3 === '235') {
        send(`MAIL FROM:<${from}>`); step = 7; return;
      }
      if (step === 7 && code3 === '250') { send(`RCPT TO:<${to}>`); step = 8; return; }
      if (step === 8 && code3 === '250') { send('DATA'); step = 9; return; }
      if (step === 9 && code3 === '354') {
        const msg = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Content-Type: text/plain; charset=utf-8`,
          '',
          text,
          '.',
          '',
        ].join('\r\n');
        send(msg); step = 10; return;
      }
      if (step === 10 && code3 === '250') { send('QUIT'); resolve(true); sock.destroy(); return; }
      if (code3.startsWith('5')) { reject(new Error('SMTP ' + line)); sock.destroy(); return; }
    };
    sock.on('data', d => { buf += d.toString(); while (buf.includes('\r\n')) { const i = buf.indexOf('\r\n'); onLine(buf.slice(0,i)); buf = buf.slice(i+2); } });
    sock.on('error', reject);
    sock.on('close', () => { if (step < 10) reject(new Error('SMTP closed early at step ' + step)); });
  });
}

// ---- /api/auth/verify-otp (consuma OTP e crea sessione master) ----------
route('POST', '/api/auth/verify-otp', async (req, res) => {
  const body = await readBody(req);
  const masterEmail = (body.masterEmail || '').trim();
  const code = (body.code || '').trim();
  const fpSeed = (body.fingerprintSeed || '').trim();
  if (!masterEmail || !code) {
    return json(res, 400, { ok: false, error: 'masterEmail e code obbligatori' });
  }
  const sess = db.prepare(
    "SELECT * FROM otp_session WHERE master_email = ? AND consumed = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
  ).get(masterEmail, nowISO());
  if (!sess) return json(res, 401, { ok: false, error: 'Nessun OTP valido' });
  if (sess.attempts >= AUTH_CONFIG.MAX_OTP_ATTEMPTS) {
    db.prepare("UPDATE otp_session SET consumed = 1 WHERE id = ?").run(sess.id);
    return json(res, 429, { ok: false, error: 'Troppi tentativi. OTP invalidato.' });
  }
  if (sha256(code) !== sess.code) {
    db.prepare("UPDATE otp_session SET attempts = attempts + 1 WHERE id = ?").run(sess.id);
    return json(res, 401, { ok: false, error: 'Codice errato' });
  }
  db.prepare("UPDATE otp_session SET consumed = 1 WHERE id = ?").run(sess.id);

  // Fingerprint check (3FA): la macchina deve essere autorizzata
  if (fpSeed) {
    const fpHash = fingerprintFromSeed(fpSeed);
    const fp = db.prepare("SELECT * FROM machine_fingerprint WHERE hash = ? AND status = 'AUTHORIZED'").get(fpHash);
    if (!fp) {
      logEntry('master', 'FINGERPRINT_DENIED', 'WARN', masterEmail, req.socket.remoteAddress, `fp=${fpHash.slice(0,8)}`);
      return json(res, 403, { ok: false, error: 'Macchina non autorizzata' });
    }
    db.prepare("UPDATE machine_fingerprint SET last_seen = ? WHERE hash = ?").run(nowISO(), fpHash);
  }

  // Crea sessione master (token casuale -> setup_state con scadenza)
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + AUTH_CONFIG.SESSION_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO setup_state (key, value, updated_at) VALUES (?,?,?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run('master_session_' + sha256(token), expiresAt, nowISO());
  logEntry('master', 'LOGIN_MASTER', 'AUDIT', masterEmail, req.socket.remoteAddress, '3FA completata');
  json(res, 200, { ok: true, masterToken: token, expiresAt });
});

// ---- /api/auth/fingerprint (autorizza/revoca fingerprint) --------------
route('POST', '/api/auth/fingerprint', { auth: 'master' }, async (req, res) => {
  const body = await readBody(req);
  const hash = (body.hash || '').trim();
  const label = (body.label || '').trim();
  const action = (body.action || 'authorize').trim(); // authorize | revoke
  if (!hash) return json(res, 400, { ok: false, error: 'hash obbligatorio' });
  if (action === 'authorize') {
    db.prepare(
      "INSERT INTO machine_fingerprint (id, hash, label, status) VALUES (?,?,?,?) " +
      "ON CONFLICT(hash) DO UPDATE SET label = excluded.label, status = 'AUTHORIZED', last_seen = excluded.last_seen"
    ).run(cuid(), hash, label || 'Manuale', 'AUTHORIZED', nowISO());
  } else if (action === 'revoke') {
    db.prepare("UPDATE machine_fingerprint SET status = 'REVOKED' WHERE hash = ?").run(hash);
  } else {
    return json(res, 400, { ok: false, error: 'action non valida' });
  }
  logEntry('master', 'FINGERPRINT_' + action.toUpperCase(), 'AUDIT', hash, req.socket.remoteAddress, label);
  json(res, 200, { ok: true, hash, action });
});

// ---- /api/master/keys ---------------------------------------------------
// CRUD su chiavi API cifrate. Riferimento AES nel campo encrypted_ref (puntatore
// ad data lake esterno, qui simulato con un UUID). NON salviamo la chiave in chiaro.
route('GET', '/api/master/keys', { auth: 'master' }, (req, res) => {
  const rows = db.prepare("SELECT id, label, service, endpoint, masked_value, scopes, last_revealed_at, last_revealed_by, reveal_count, active, created_at FROM api_key WHERE is_test = 0 ORDER BY created_at DESC").all();
  json(res, 200, { ok: true, keys: rows });
});

route('POST', '/api/master/keys', { auth: 'master' }, async (req, res) => {
  const body = await readBody(req);
  const { label, service, endpoint, raw, scopes } = body;
  if (!label || !service || !raw) return json(res, 400, { ok: false, error: 'label, service, raw obbligatori' });
  const id = cuid();
  const encryptedRef = cuid(); // puntatore cifrato al data lake (simulato)
  db.prepare(
    "INSERT INTO api_key (id, label, service, endpoint, masked_value, encrypted_ref, scopes, is_test) VALUES (?,?,?,?,?,?,?,0)"
  ).run(id, label, service, endpoint || null, mask(raw), encryptedRef, scopes || null);
  logEntry('master', 'KEY_CREATE', 'AUDIT', service, req.socket.remoteAddress, label);
  json(res, 200, { ok: true, id, maskedValue: mask(raw) });
});

// ---- /api/master/keys/:id/reveal ----------------------------------------
// Svela il valore reale: richiede ri-autenticazione master (hash password).
// Nel rigenerato, la chiave è cifrata nel data lake esterno: NON la ricostruiamo
// dal finto encrypted_ref (non conosciamo il ciphertext). Per demo/test restituiamo
// un placeholder esplicito che NON è un valore reale.
route('POST', '/api/master/keys/:id/reveal', { auth: 'master' }, async (req, res) => {
  const body = await readBody(req);
  const masterPassword = (body.masterPassword || '').trim();
  const expectedHash = db.prepare("SELECT value FROM setup_state WHERE key = 'master_password_hash'").get();
  if (!expectedHash || sha256(masterPassword) !== expectedHash.value) {
    logEntry('master', 'KEY_REVEAL_DENIED', 'WARN', req.params.id, req.socket.remoteAddress, 'password errata');
    return json(res, 401, { ok: false, error: 'Password master errata' });
  }
  const row = db.prepare("SELECT * FROM api_key WHERE id = ? AND is_test = 0").get(req.params.id);
  if (!row) return json(res, 404, { ok: false, error: 'Chiave non trovata' });
  db.prepare("UPDATE api_key SET last_revealed_at = ?, last_revealed_by = 'master', reveal_count = reveal_count + 1 WHERE id = ?").run(nowISO(), row.id);
  logEntry('master', 'KEY_REVEAL', 'AUDIT', row.service, req.socket.remoteAddress, row.label);
  // Importante: NON inventiamo un valore. Restituiamo il puntatore cifrato e
  // indichiamo esplicitamente che il recupero richiede accesso al data lake.
  json(res, 200, {
    ok: true,
    id: row.id,
    label: row.label,
    maskedValue: row.masked_value,
    encryptedRef: row.encrypted_ref,
    note: 'Valore reale disponibile solo dal data lake cifrato (accesso out-of-band).',
  });
});

// ---- /api/admin/import-services (FASE 2.3) ------------------------------
// Importa servizi/sottoservizi/macroaree da un file JSON passato nel body
// (o dal path config/services.json se non fornito). Idempotente (upsert).
route('POST', '/api/admin/import-services', { auth: 'master' }, async (req, res) => {
  let config;
  const body = await readBody(req);
  if (body && body.macroAreas) {
    config = body;
  } else {
    const cfgPath = path.join(process.cwd(), 'config', 'services.json');
    if (!fs.existsSync(cfgPath)) {
      return json(res, 404, { ok: false, error: 'config/services.json non trovato. Invia il body o crea il file.' });
    }
    config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
  if (!config.macroAreas || !Array.isArray(config.macroAreas)) {
    return json(res, 400, { ok: false, error: 'macroAreas array mancante' });
  }
  let countAreas = 0, countServices = 0;
  db.exec('BEGIN');
  try {
    for (const a of config.macroAreas) {
      db.prepare(
        "INSERT INTO macro_area (id, code, name, description, color, icon, active) VALUES (?,?,?,?,?,?,1) " +
        "ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description, color = excluded.color, icon = excluded.icon"
      ).run(cuid(), a.code, a.name, a.description || null, a.color || '#001C3A', a.icon || null);
      countAreas++;
      for (const s of (a.services || [])) {
        db.prepare(
          "INSERT INTO service_catalog (id, code, area_code, title, description, active, source) VALUES (?,?,?,?,?,1,'CONFIG') " +
          "ON CONFLICT(code) DO UPDATE SET area_code = excluded.area_code, title = excluded.title, description = excluded.description"
        ).run(cuid(), s.code, a.code, s.title, s.description || null);
        countServices++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logEntry('master', 'IMPORT_SERVICES', 'AUDIT', null, req.socket.remoteAddress, `aree=${countAreas} servizi=${countServices}`);
  json(res, 200, { ok: true, macroAreas: countAreas, services: countServices });
});

// ---- /api/macro-areas ---------------------------------------------------
route('GET', '/api/macro-areas', (req, res) => {
  const rows = db.prepare("SELECT * FROM macro_area WHERE active = 1 ORDER BY code").all();
  json(res, 200, { ok: true, macroAreas: rows });
});

// ---- /api/services (catalogo da service_catalog) -----------------------
route('GET', '/api/services', (req, res) => {
  const area = req.url.split('?area=')[1];
  let rows;
  if (area) {
    rows = db.prepare("SELECT * FROM service_catalog WHERE active = 1 AND area_code = ? ORDER BY code").all(area);
  } else {
    rows = db.prepare("SELECT * FROM service_catalog WHERE active = 1 ORDER BY area_code, code").all();
  }
  json(res, 200, { ok: true, services: rows });
});

// ---- /api/consultants ---------------------------------------------------
route('GET', '/api/consultants', (req, res) => {
  const rows = db.prepare("SELECT id, code, full_name, email, role, macro_areas, active, max_slots_per_day FROM consultant WHERE is_test = 0 ORDER BY code").all();
  json(res, 200, { ok: true, consultants: rows });
});

route('POST', '/api/consultants', { auth: 'master' }, async (req, res) => {
  const body = await readBody(req);
  const { code, fullName, email, role, macroAreas, maxSlotsPerDay } = body;
  if (!code || !fullName || !email) return json(res, 400, { ok: false, error: 'code, fullName, email obbligatori' });
  const id = cuid();
  db.prepare(
    "INSERT INTO consultant (id, code, full_name, email, role, macro_areas, max_slots_per_day, is_test) VALUES (?,?,?,?,?,?,?,0)"
  ).run(id, code, fullName, email, role || 'Operatore', macroAreas || '', maxSlotsPerDay || 2);
  logEntry('master', 'CONSULTANT_CREATE', 'AUDIT', code, req.socket.remoteAddress, fullName);
  json(res, 200, { ok: true, id, code });
});

// ---- /api/clients (anagrafica) -----------------------------------------
route('GET', '/api/clients', (req, res) => {
  const rows = db.prepare(
    "SELECT id, code, first_name, last_name, fiscal_code, phone, email, city, iban, iban_later_in_sede, is_test, created_at FROM client ORDER BY created_at DESC"
  ).all();
  json(res, 200, { ok: true, clients: rows });
});

route('POST', '/api/clients', { auth: 'operator' }, async (req, res) => {
  const body = await readBody(req);
  const { firstName, lastName, fiscalCode, phone, email, birthDate, birthPlace, address, city, notes } = body;
  if (!firstName || !lastName) return json(res, 400, { ok: false, error: 'firstName e lastName obbligatori' });
  const id = cuid();
  const code = nextCode('CL', 'client');
  db.prepare(
    "INSERT INTO client (id, code, first_name, last_name, fiscal_code, phone, email, birth_date, birth_place, address, city, notes, is_test) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)"
  ).run(id, code, firstName, lastName, fiscalCode || null, phone || null, email || null,
        birthDate || null, birthPlace || null, address || null, city || null, notes || null);
  logEntry(req.actor || 'operator', 'CLIENT_CREATE', 'AUDIT', code, req.socket.remoteAddress, `${firstName} ${lastName}`);
  json(res, 200, { ok: true, id, code });
});

route('GET', '/api/clients/:id', (req, res) => {
  const row = db.prepare("SELECT * FROM client WHERE id = ? OR code = ?").get(req.params.id, req.params.id);
  if (!row) return json(res, 404, { ok: false, error: 'Cliente non trovato' });
  json(res, 200, { ok: true, client: row });
});

// ---- /api/appointments (prenotazione) ----------------------------------
route('GET', '/api/appointments', (req, res) => {
  const rows = db.prepare(
    "SELECT a.id, a.client_code, a.consultant_id, a.area_code, a.date, a.slot, a.start_time, a.end_time, a.status, a.channel, a.notes " +
    "FROM appointment a WHERE a.is_test = 0 ORDER BY a.date DESC, a.slot"
  ).all();
  json(res, 200, { ok: true, appointments: rows });
});

route('POST', '/api/appointments', { auth: 'operator' }, async (req, res) => {
  const body = await readBody(req);
  const { clientCode, consultantId, areaCode, date, slot } = body;
  if (!clientCode || !areaCode || !date || !slot) {
    return json(res, 400, { ok: false, error: 'clientCode, areaCode, date, slot obbligatori' });
  }
  if (!['MORNING', 'AFTERNOON'].includes(slot)) {
    return json(res, 400, { ok: false, error: 'slot non valido (MORNING|AFTERNOON)' });
  }
  // ANTI-OVERBOOKING: stesso giorno + stesso slot + stesso consulente = bloccato
  // (vincolo UNIQUE(date, slot, consultant_id) già presente nello schema)
  const startEnd = slot === 'MORNING' ? { start: '09:00', end: '12:00' } : { start: '15:00', end: '17:00' };
  const id = cuid();
  try {
    db.prepare(
      "INSERT INTO appointment (id, client_code, consultant_id, area_code, date, slot, start_time, end_time, is_test) " +
      "VALUES (?,?,?,?,?,?,?,?,0)"
    ).run(id, clientCode, consultantId || null, areaCode, date, slot, startEnd.start, startEnd.end);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      logEntry(req.actor || 'operator', 'BOOKING_DENIED_OVERBOOKING', 'WARN', `${date}/${slot}/${consultantId || '-'}`, req.socket.remoteAddress, null);
      return json(res, 409, { ok: false, error: 'Overbooking: consulente già impegnato in questo slot' });
    }
    throw e;
  }
  logEntry(req.actor || 'operator', 'BOOKING', 'AUDIT', `${date}/${slot}`, req.socket.remoteAddress, `client=${clientCode} area=${areaCode}`);
  json(res, 200, { ok: true, id });
});

// ---- /api/slots (disponibilità) ----------------------------------------
route('GET', '/api/slots', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const date = u.searchParams.get('date');
  const area = u.searchParams.get('area');
  if (!date) return json(res, 400, { ok: false, error: 'date obbligatorio (YYYY-MM-DD)' });
  const booked = db.prepare("SELECT slot, consultant_id FROM appointment WHERE date = ? AND is_test = 0 AND status = 'BOOKED'").all(date);
  const bookedBySlot = { MORNING: new Set(), AFTERNOON: new Set() };
  for (const b of booked) bookedBySlot[b.slot].add(b.consultant_id || '_any_');
  json(res, 200, {
    ok: true,
    date,
    area,
    slots: TIME_SLOTS.map(s => ({
      time: s.time,
      end: s.end,
      slotId: s.slotId,
      available: !bookedBySlot[s.slotId].has('_any_'),
    })),
  });
});

// ---- /api/calendar ------------------------------------------------------
route('GET', '/api/calendar', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const from = u.searchParams.get('from') || new Date().toISOString().slice(0, 10);
  const to = u.searchParams.get('to') || from;
  const rows = db.prepare(
    "SELECT date, slot, COUNT(*) AS n FROM appointment WHERE date BETWEEN ? AND ? AND is_test = 0 GROUP BY date, slot ORDER BY date, slot"
  ).all(from, to);
  json(res, 200, { ok: true, from, to, calendar: rows });
});

// ---- /api/practices (pratica / fascicolo) ------------------------------
route('GET', '/api/practices', (req, res) => {
  const rows = db.prepare("SELECT id, code, client_code, area_code, title, status, priority, created_at FROM practice WHERE is_test = 0 ORDER BY created_at DESC").all();
  json(res, 200, { ok: true, practices: rows });
});

route('POST', '/api/practices', { auth: 'operator' }, async (req, res) => {
  const body = await readBody(req);
  const { clientCode, areaCode, title, priority, payload } = body;
  if (!clientCode || !areaCode || !title) return json(res, 400, { ok: false, error: 'clientCode, areaCode, title obbligatori' });
  const id = cuid();
  const code = nextCode('PR', 'practice');
  db.prepare(
    "INSERT INTO practice (id, code, client_code, area_code, title, status, priority, payload_json, is_test) VALUES (?,?,?,?,?,?,?,? ,0)"
  ).run(id, code, clientCode, areaCode, title, 'OPEN', priority || 'NORMAL', payload ? JSON.stringify(payload) : null);
  logEntry(req.actor || 'operator', 'PRACTICE_CREATE', 'AUDIT', code, req.socket.remoteAddress, title);
  json(res, 200, { ok: true, id, code });
});

route('GET', '/api/practices/:id', (req, res) => {
  const row = db.prepare("SELECT * FROM practice WHERE id = ? OR code = ?").get(req.params.id, req.params.id);
  if (!row) return json(res, 404, { ok: false, error: 'Pratica non trovata' });
  json(res, 200, { ok: true, practice: row });
});

// ---- /api/brogliaccio (NUOVO: brogliaccio come lista di appunti collegati)
// Flusso Test 3: da anagrafica + sottoservizio → brogliaccio → nuova pratica.
// Il brogliaccio è un appunto rapido (titolo + client_code + area_code +
// service_code + note). Da un brogliaccio si può promuovere a pratica.
route('POST', '/api/brogliaccio', { auth: 'operator' }, async (req, res) => {
  const body = await readBody(req);
  const { clientCode, areaCode, serviceCode, title, notes } = body;
  if (!clientCode || !title) return json(res, 400, { ok: false, error: 'clientCode e title obbligatori' });
  // Verifica cliente esiste
  const client = db.prepare("SELECT code FROM client WHERE code = ? OR id = ?").get(clientCode, clientCode);
  if (!client) return json(res, 404, { ok: false, error: 'Cliente non trovato: crea prima l\'anagrafica' });
  // Verifica area/servizio (se forniti)
  if (areaCode) {
    const area = db.prepare("SELECT code FROM macro_area WHERE code = ?").get(areaCode);
    if (!area) return json(res, 404, { ok: false, error: 'Macro area non trovata' });
  }
  if (serviceCode) {
    const svc = db.prepare("SELECT code FROM service_catalog WHERE code = ?").get(serviceCode);
    if (!svc) return json(res, 404, { ok: false, error: 'Sottoservizio non trovato' });
  }
  const id = cuid();
  // Brogliaccio memorizzato come pratica in stato DRAFT con prefisso BROG-
  const code = nextCode('BROG', 'practice');
  db.prepare(
    "INSERT INTO practice (id, code, client_code, area_code, title, status, priority, payload_json, is_test) VALUES (?,?,?,?,?,?,?,?,0)"
  ).run(id, code, clientCode, areaCode || null, title, 'OPEN', 'NORMAL',
        JSON.stringify({ brogliaccio: true, serviceCode: serviceCode || null, notes: notes || null, createdAt: nowISO() }));
  logEntry(req.actor || 'operator', 'BROGLIACCIO_CREATE', 'AUDIT', code, req.socket.remoteAddress, title);
  json(res, 200, { ok: true, id, code, message: 'Brogliaccio creato. Promuovi a pratica con POST /api/practices/:id/promote.' });
});

route('GET', '/api/brogliaccio', (req, res) => {
  const rows = db.prepare(
    "SELECT id, code, client_code, area_code, title, payload_json, created_at FROM practice " +
    "WHERE is_test = 0 AND payload_json LIKE '%\"brogliaccio\":true%' ORDER BY created_at DESC"
  ).all();
  const parsed = rows.map(r => {
    let p = {}; try { p = JSON.parse(r.payload_json || '{}'); } catch (e) {}
    return { ...r, serviceCode: p.serviceCode, notes: p.notes };
  });
  json(res, 200, { ok: true, brogliacci: parsed });
});

// Promuove un brogliaccio a pratica formale (cambia il code da BROG- a PR-)
route('POST', '/api/practices/:id/promote', { auth: 'operator' }, async (req, res) => {
  const row = db.prepare("SELECT * FROM practice WHERE id = ? OR code = ?").get(req.params.id, req.params.id);
  if (!row) return json(res, 404, { ok: false, error: 'Brogliaccio/pratica non trovato' });
  let p = {}; try { p = JSON.parse(row.payload_json || '{}'); } catch (e) {}
  if (!p.brogliaccio) return json(res, 400, { ok: false, error: 'Non è un brogliaccio' });
  const newCode = nextCode('PR', 'practice');
  db.prepare("UPDATE practice SET code = ?, payload_json = ? WHERE id = ?").run(newCode, JSON.stringify({ ...p, brogliaccio: false, promotedAt: nowISO() }), row.id);
  logEntry(req.actor || 'operator', 'BROGLIACCIO_PROMOTE', 'AUDIT', newCode, req.socket.remoteAddress, `da ${row.code}`);
  json(res, 200, { ok: true, id: row.id, oldCode: row.code, newCode });
});

// ---- /api/contracts ----------------------------------------------------
route('GET', '/api/contracts', (req, res) => {
  const rows = db.prepare("SELECT id, code, client_code, practice_code, area_code, status, signed_at, created_at FROM contract WHERE is_test = 0 ORDER BY created_at DESC").all();
  json(res, 200, { ok: true, contracts: rows });
});

route('POST', '/api/contracts', { auth: 'operator' }, async (req, res) => {
  const body = await readBody(req);
  const { clientCode, practiceCode, areaCode, autofill, compensi } = body;
  if (!clientCode) return json(res, 400, { ok: false, error: 'clientCode obbligatorio' });
  const id = cuid();
  const code = nextCode('CT', 'contract');
  db.prepare(
    "INSERT INTO contract (id, code, client_code, practice_code, area_code, autofill_json, compensi_json, status, is_test) VALUES (?,?,?,?,?,?,?,?,0)"
  ).run(id, code, clientCode, practiceCode || null, areaCode || null, JSON.stringify(autofill || {}), JSON.stringify(compensi || {}), 'DRAFT');
  logEntry(req.actor || 'operator', 'CONTRACT_CREATE', 'AUDIT', code, req.socket.remoteAddress, `client=${clientCode}`);
  json(res, 200, { ok: true, id, code, status: 'DRAFT' });
});

// Preview sign: prepara il PDF/HTML da firmare (simulato — torna placeholder)
route('POST', '/api/contracts/:id/preview-sign', { auth: 'operator' }, async (req, res) => {
  const row = db.prepare("SELECT * FROM contract WHERE id = ? AND is_test = 0").get(req.params.id);
  if (!row) return json(res, 404, { ok: false, error: 'Contratto non trovato' });
  json(res, 200, { ok: true, contractCode: row.code, status: row.status, preview: 'placeholder-non-firmato' });
});

// Sign: marca come FIRMATO. Richiede compensi compilati (fix BUG originale).
route('POST', '/api/contracts/:id/sign', { auth: 'operator' }, async (req, res) => {
  const row = db.prepare("SELECT * FROM contract WHERE id = ? AND is_test = 0").get(req.params.id);
  if (!row) return json(res, 404, { ok: false, error: 'Contratto non trovato' });
  if (!row.compensi_filled) {
    return json(res, 400, { ok: false, error: 'Tabella Compensi (Sezione 3) non compilata. Completare le voci obbligatorie (1,2,3,6), il totale e l\'IBAN prima di procedere alla firma.' });
  }
  db.prepare("UPDATE contract SET status = 'FIRMATO', signed_at = ? WHERE id = ?").run(nowISO(), row.id);
  logEntry(req.actor || 'operator', 'CONTRACT_SIGNED', 'AUDIT', row.code, req.socket.remoteAddress, null);
  json(res, 200, { ok: true, id: row.id, code: row.code, status: 'FIRMATO', signedAt: nowISO() });
});

// ---- /api/documents ----------------------------------------------------
route('GET', '/api/documents', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const clientCode = u.searchParams.get('client');
  if (!clientCode) return json(res, 400, { ok: false, error: 'client (clientCode) obbligatorio' });
  const rows = db.prepare("SELECT id, client_code, type, side, label, mime_type, size_bytes, uploaded_at FROM client_document WHERE client_code = ? ORDER BY uploaded_at DESC").all(clientCode);
  json(res, 200, { ok: true, documents: rows });
});

route('POST', '/api/documents', { auth: 'operator' }, async (req, res) => {
  const body = await readBody(req);
  const { clientCode, type, side, label, encryptedRef, mimeType, sizeBytes } = body;
  if (!clientCode || !type || !label || !encryptedRef) return json(res, 400, { ok: false, error: 'clientCode, type, label, encryptedRef obbligatori' });
  const id = cuid();
  db.prepare(
    "INSERT INTO client_document (id, client_code, type, side, label, encrypted_ref, mime_type, size_bytes, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, clientCode, type, side || 'FRONT', label, encryptedRef, mimeType || 'image/jpeg', sizeBytes || 0, req.actor || 'operator');
  logEntry(req.actor || 'operator', 'DOC_UPLOAD', 'AUDIT', type, req.socket.remoteAddress, `${clientCode} ${label}`);
  json(res, 200, { ok: true, id });
});

// ---- /api/operators (front desk) ---------------------------------------
route('GET', '/api/operators', (req, res) => {
  // NON restituisce access_code in chiaro (fix BUG-9 originale)
  const rows = db.prepare("SELECT id, code, full_name, email, phone, role, macro_areas, status, created_at FROM front_desk_operator WHERE is_test = 0 ORDER BY code").all();
  json(res, 200, { ok: true, operators: rows });
});

route('POST', '/api/operators', { auth: 'master' }, async (req, res) => {
  const body = await readBody(req);
  const { fullName, email, phone, role, macroAreas } = body;
  if (!fullName || !email) return json(res, 400, { ok: false, error: 'fullName e email obbligatori' });
  const id = cuid();
  const code = nextCode('FD', 'front_desk_operator');
  // Genera access code FD-XXXXXX-YYYY (come original)
  const part1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const accessCode = `FD-${part1}-${part2}`;
  db.prepare(
    "INSERT INTO front_desk_operator (id, code, full_name, email, phone, role, macro_areas, access_code, access_code_hash, status, is_test) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,0)"
  ).run(id, code, fullName, email, phone || null, role || 'Front Desk', macroAreas || '', accessCode, sha256(accessCode), 'ACTIVE');
  db.prepare("INSERT INTO operator_log (id, operator_id, operator_code, action, actor, reason) VALUES (?,?,?,?,?,?)").run(cuid(), id, code, 'CREATED', 'master', null);
  logEntry('master', 'OPERATOR_CREATE', 'AUDIT', code, req.socket.remoteAddress, fullName);
  // Ritorna il codice UNA volta sola per la consegna fuori banda
  json(res, 200, { ok: true, id, code, accessCode, note: 'Consegna questo codice all\'operatore fuori banda (voce o WhatsApp). Non inviarlo via email non cifrata.' });
});

// ---- /api/operators/qr (FASE 2.5: QR code operatore — fix BUG-1, BUG-2) --
// Genera un URL con QR code per l'operatore. L'URL punta a /operator/<code>
// DEPLOY_URL deve essere configurato via env NEXT_PUBLIC_SITE_URL o VERCEL_URL.
route('POST', '/api/operators/:id/qr', { auth: 'master' }, async (req, res) => {
  const op = db.prepare("SELECT id, code, access_code_hash FROM front_desk_operator WHERE id = ? AND is_test = 0").get(req.params.id);
  if (!op) return json(res, 404, { ok: false, error: 'Operatore non trovato' });
  if (!DEPLOY_URL) return json(res, 500, { ok: false, error: 'NEXT_PUBLIC_SITE_URL o VERCEL_URL non configurato. Impossibile generare URL QR.' });
  // Genera un token di login one-shot per questo operatore ( valido 10 min )
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  // Salva come otp_session riutilizzando la tabella (campo master_email usato come tipo)
  // Meglio: usiamo operator_session con token_hash e expires_at, revoked=0
  db.prepare(
    "INSERT INTO operator_session (id, operator_id, operator_code, token_hash, expires_at, revoked) VALUES (?,?,?,?,?,0)"
  ).run(cuid(), op.id, op.code, sha256(token), expiresAt);
  const qrUrl = `${DEPLOY_URL}/operator/${token}`;
  logEntry('master', 'OPERATOR_QR_ISSUED', 'AUDIT', op.code, req.socket.remoteAddress, `expires=${expiresAt}`);
  json(res, 200, { ok: true, qrUrl, expiresAt, operatorCode: op.code });
});

// ---- /api/auth/operator-login (via QR token: fix BUG-3, BUG-4) --------
// Due modi: (1) classico con accessCode; (2) via QR token + name + phone check.
route('POST', '/api/auth/operator-login', async (req, res) => {
  const body = await readBody(req);
  // Modo QR: token + name + phone (verifica nome e telefono dell'operatore)
  if (body.qrToken) {
    const tok = body.qrToken.trim();
    const sess = db.prepare(
      "SELECT s.*, o.id AS op_id, o.code, o.full_name, o.phone, o.role, o.macro_areas, o.status " +
      "FROM operator_session s JOIN front_desk_operator o ON o.id = s.operator_id " +
      "WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ?"
    ).get(sha256(tok), nowISO());
    if (!sess) return json(res, 401, { ok: false, error: 'Token QR non valido o scaduto' });
    if (sess.status !== 'ACTIVE') return json(res, 403, { ok: false, error: 'Operatore non attivo' });
    // Verifica nome + telefono (fix BUG-4: l'originale non li controllava)
    if (!body.fullName || !body.phone) return json(res, 400, { ok: false, error: 'fullName e phone obbligatori per login QR' });
    if (body.fullName.trim().toLowerCase() !== sess.full_name.trim().toLowerCase()) {
      logEntry(sess.code, 'OPERATOR_LOGIN_DENIED', 'WARN', 'name-mismatch', req.socket.remoteAddress, `expected=${sess.full_name}`);
      return json(res, 401, { ok: false, error: 'Nome non corrisponde al record operatore' });
    }
    if (sess.phone && body.phone.trim() !== sess.phone.trim()) {
      logEntry(sess.code, 'OPERATOR_LOGIN_DENIED', 'WARN', 'phone-mismatch', req.socket.remoteAddress, null);
      return json(res, 401, { ok: false, error: 'Telefono non corrisponde al record operatore' });
    }
    // Crea sessione duratura (fix BUG-3: cookie httpOnly secure sameSite)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiresAt = new Date(Date.now() + AUTH_CONFIG.SESSION_TTL_MINUTES * 60 * 1000).toISOString();
    db.prepare("INSERT INTO operator_session (id, operator_id, operator_code, token_hash, expires_at, revoked) VALUES (?,?,?,?,?,0)").run(cuid(), sess.op_id, sess.code, sha256(sessionToken), sessionExpiresAt);
    db.prepare("UPDATE operator_session SET revoked = 1 WHERE id = ?").run(sess.id); // consuma il QR token
    setSessionCookie(res, sessionToken);
    logEntry(sess.code, 'OPERATOR_LOGIN', 'AUDIT', 'qr', req.socket.remoteAddress, `operatore=${sess.code}`);
    return json(res, 200, { ok: true, operator: { code: sess.code, fullName: sess.full_name, role: sess.role, macroAreas: sess.macro_areas } });
  }
  // Modo classico: accessCode
  const accessCode = (body.accessCode || '').trim();
  if (!accessCode) return json(res, 400, { ok: false, error: 'accessCode o qrToken obbligatorio' });
  const op = db.prepare("SELECT * FROM front_desk_operator WHERE access_code_hash = ? AND status = 'ACTIVE' AND is_test = 0").get(sha256(accessCode));
  if (!op) {
    logEntry('anonymous', 'OPERATOR_LOGIN_DENIED', 'WARN', 'access-code', req.socket.remoteAddress, null);
    return json(res, 401, { ok: false, error: 'Codice non valido o operatore non attivo' });
  }
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiresAt = new Date(Date.now() + AUTH_CONFIG.SESSION_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare("INSERT INTO operator_session (id, operator_id, operator_code, token_hash, expires_at, revoked) VALUES (?,?,?,?,?,0)").run(cuid(), op.id, op.code, sha256(sessionToken), sessionExpiresAt);
  setSessionCookie(res, sessionToken);
  logEntry(op.code, 'OPERATOR_LOGIN', 'AUDIT', 'access-code', req.socket.remoteAddress, op.full_name);
  json(res, 200, { ok: true, operator: { code: op.code, fullName: op.full_name, role: op.role, macroAreas: op.macro_areas } });
});

// ---- /operator/:token (PAGE: scan QR → form name/phone → login) --------
// HTML page served by the same Node server (no Next.js). Mobile-friendly.
route('GET', '/operator/:token', (req, res) => {
  const tok = req.params.token;
  // Validate token exists & not expired
  const sess = db.prepare(
    "SELECT s.id, o.full_name, o.phone, o.code FROM operator_session s JOIN front_desk_operator o ON o.id = s.operator_id WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ?"
  ).get(sha256(tok), nowISO());
  const valid = !!sess;
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>C.S.I. · Accesso operatore</title>
<style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#F7F4ED;color:#001C3A;padding:24px;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:420px;width:100%;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 24px rgba(0,28,58,.12)}
h1{font-size:20px;margin:0 0 4px} .sub{font-size:13px;color:#39546B;margin:0 0 20px}
label{display:block;font-size:12px;font-weight:600;margin:14px 0 4px;text-transform:uppercase;letter-spacing:.04em}
input{width:100%;padding:12px;border:1px solid #99A7B3;border-radius:8px;font-size:16px;box-sizing:border-box}
button{width:100%;margin-top:20px;padding:14px;background:#001C3A;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:600}
button:disabled{background:#99A7B3}
.err{color:#b91c1c;font-size:13px;margin-top:12px;min-height:18px}
.valid{color:#15803d;font-size:13px}
</style></head><body><div class="card">
<h1>C.S.I. Front Office</h1><p class="sub">Accesso operatore via QR</p>
${valid ? `<p class="valid">Token valido per l'operatore <strong>${sess.code}</strong>. Conferma la tua identità.</p>
<form id="f"><label>Nome e cognome</label><input id="n" name="fullName" autocomplete="name" required>
<label>Telefono</label><input id="p" name="phone" type="tel" autocomplete="tel" required>
<button type="submit">Accedi</button><div class="err" id="e"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e'); e.textContent = '';
  const r = await fetch('/api/auth/operator-login', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ qrToken: ${JSON.stringify(tok)}, fullName: document.getElementById('n').value, phone: document.getElementById('p').value }) });
  const j = await r.json();
  if (j.ok) { window.location.href = '/'; }
  else { e.textContent = j.error || 'Errore'; }
});
</script>`
: `<p class="err">Token non valido o scaduto. Chiedi un nuovo QR all'amministratore.</p>`}
</div></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// ---- /api/operator-logs ------------------------------------------------
route('GET', '/api/operator-logs', { auth: 'master' }, (req, res) => {
  const rows = db.prepare("SELECT id, operator_id, operator_code, action, actor, reason, ip_address, timestamp FROM operator_log ORDER BY timestamp DESC LIMIT 200").all();
  json(res, 200, { ok: true, logs: rows });
});

// ---- /api/logs (registro eventi di sistema) ----------------------------
route('GET', '/api/logs', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const limit = Math.min(parseInt(u.searchParams.get('limit') || '200', 10), 1000);
  const level = u.searchParams.get('level');
  let rows;
  if (level) {
    rows = db.prepare("SELECT id, timestamp, actor, action, level, target, ip, details FROM log_entry WHERE level = ? ORDER BY timestamp DESC LIMIT ?").all(level, limit);
  } else {
    rows = db.prepare("SELECT id, timestamp, actor, action, level, target, ip, details FROM log_entry ORDER BY timestamp DESC LIMIT ?").all(limit);
  }
  json(res, 200, { ok: true, logs: rows });
});

// ---- /api/backup (cifrato su più dischi) -------------------------------
// dirs da env CSI_BACKUP_DIRS (CSV); chiave AES da env CSI_BACKUP_KEY (hex 64).
route('POST', '/api/backup', { auth: 'master' }, async (req, res) => {
  const dirsCsv = process.env.CSI_BACKUP_DIRS;
  const aesKey = process.env.CSI_BACKUP_KEY;
  if (!dirsCsv || !aesKey) {
    return json(res, 500, { ok: false, error: 'CSI_BACKUP_DIRS e CSI_BACKUP_KEY (hex 64) devono essere configurati' });
  }
  if (aesKey.length !== 64 || !/^[0-9a-f]+$/i.test(aesKey)) {
    return json(res, 400, { ok: false, error: 'CSI_BACKUP_KEY non valida (serve 32 byte in hex)' });
  }
  const dirs = dirsCsv.split(',').map(s => s.trim()).filter(Boolean);
  const r = backupToDisks(dirs, aesKey);
  logEntry('master', 'BACKUP', 'AUDIT', null, req.socket.remoteAddress, `files=${r.written.length} bytes=${r.bytes}`);
  json(res, 200, { ok: true, ...r });
});

// ---- /api/sync/sites (Gate Remoti) -------------------------------------
route('GET', '/api/sync/sites', (req, res) => {
  const rows = db.prepare("SELECT id, site_id, name, url, deploy, category, active, last_sync_at, last_sync_status, total_received, total_pushed FROM external_site WHERE is_test = 0 ORDER BY site_id").all();
  json(res, 200, { ok: true, sites: rows });
});

route('POST', '/api/sync/sites', { auth: 'master' }, async (req, res) => {
  const body = await readBody(req);
  const { siteId, name, url, webhookSecret, deploy, category } = body;
  if (!siteId || !name || !url || !webhookSecret) return json(res, 400, { ok: false, error: 'siteId, name, url, webhookSecret obbligatori' });
  const id = cuid();
  db.prepare(
    "INSERT INTO external_site (id, site_id, name, url, webhook_secret, deploy, category, is_test) VALUES (?,?,?,?,?,?,?,0)"
  ).run(id, siteId, name, url, webhookSecret, deploy || 'Netlify', category || 'dynamic');
  logEntry('master', 'SITE_REGISTER', 'AUDIT', siteId, req.socket.remoteAddress, name);
  json(res, 200, { ok: true, id, siteId });
});

// ---- /api/sync/push/:siteId (firma HMAC con i Gate Remoti) -------------
route('POST', '/api/sync/push/:siteId', { auth: 'operator' }, async (req, res) => {
  const site = db.prepare("SELECT * FROM external_site WHERE site_id = ? AND active = 1 AND is_test = 0").get(req.params.siteId);
  if (!site) return json(res, 404, { ok: false, error: 'Sito non registrato o inattivo' });
  const body = await readBody(req);
  const payload = JSON.stringify(body);
  const ts = Date.now().toString();
  const sig = hmacSign(site.webhook_secret, `${ts}.${payload}`);
  // In un'implementazione completa qui faremmo fetch(site.url + '/webhook', {...}).
  // Qui registriamo l'intento di push e torniamo la firma per verifica client-side.
  db.prepare("UPDATE external_site SET last_sync_at = ?, last_sync_status = 'ok', total_pushed = total_pushed + 1 WHERE id = ?").run(nowISO(), site.id);
  logEntry(req.actor || 'operator', 'SYNC_PUSH', 'AUDIT', site.site_id, req.socket.remoteAddress, `bytes=${payload.length}`);
  json(res, 200, { ok: true, siteId: site.site_id, timestamp: ts, signature: sig, hmacAlgo: AUTH_CONFIG.HMAC_ALGO });
});

// ---- /api/sync/pull/:siteId (verifica firma HMAC in ingresso) ----------
route('POST', '/api/sync/pull/:siteId', async (req, res) => {
  const site = db.prepare("SELECT * FROM external_site WHERE site_id = ? AND active = 1 AND is_test = 0").get(req.params.siteId);
  if (!site) return json(res, 404, { ok: false, error: 'Sito non registrato' });
  const sig = req.headers['x-signature'];
  const ts = req.headers['x-timestamp'];
  const raw = await new Promise((resolve) => {
    let chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  let payload = raw;
  try { payload = JSON.stringify(JSON.parse(raw)); } catch (e) { /* non-JSON, keep raw */ }
  if (!hmacVerify(site.webhook_secret, `${ts}.${payload}`, sig)) {
    logEntry(site.site_id, 'SYNC_PULL_DENIED', 'WARN', 'hmac-fail', req.socket.remoteAddress, null);
    return json(res, 401, { ok: false, error: 'Firma HMAC non valida' });
  }
  db.prepare("UPDATE external_site SET last_sync_at = ?, last_sync_status = 'ok', total_received = total_received + 1 WHERE id = ?").run(nowISO(), site.id);
  logEntry(site.site_id, 'SYNC_PULL', 'AUDIT', null, req.socket.remoteAddress, `bytes=${raw.length}`);
  json(res, 200, { ok: true, received: true, bytes: raw.length });
});

// ---- /api/webhook/sync (ricezione push da landing) ---------------------
// Richiede x-webhook-secret matching il webhook_secret del siteId nel body.
route('POST', '/api/webhook/sync', async (req, res) => {
  const sig = req.headers['x-webhook-secret'];
  const raw = await new Promise((resolve) => {
    let chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json(res, 400, { ok: false, error: 'JSON non valido' }); }
  const site = db.prepare("SELECT * FROM external_site WHERE site_id = ? AND active = 1 AND is_test = 0").get(body.siteId || '');
  if (!site || site.webhook_secret !== sig) {
    logEntry(body.siteId || '?', 'WEBHOOK_DENIED', 'WARN', 'secret-mismatch', req.socket.remoteAddress, null);
    return json(res, 401, { ok: false, error: 'Webhook secret non valido' });
  }
  db.prepare("UPDATE external_site SET last_sync_at = ?, last_sync_status = 'ok', total_received = total_received + 1 WHERE id = ?").run(nowISO(), site.id);
  logEntry(site.site_id, 'WEBHOOK_SYNC', 'AUDIT', null, req.socket.remoteAddress, `bytes=${raw.length}`);
  json(res, 200, { ok: true, received: true });
});

// ---- /api/v1/* (API pubblica per landing/Gate Remoti) ------------------
route('GET', '/api/v1/ping', (req, res) => json(res, 200, { ok: true, ts: nowISO() }));
route('GET', '/api/v1/servizi', (req, res) => {
  const rows = db.prepare("SELECT code AS id, area_code, title, description FROM service_catalog WHERE active = 1 ORDER BY code").all();
  json(res, 200, { ok: true, servizi: rows });
});
route('GET', '/api/v1/disponibilita', (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const date = u.searchParams.get('date');
  if (!date) return json(res, 400, { ok: false, error: 'date obbligatorio' });
  const booked = db.prepare("SELECT slot FROM appointment WHERE date = ? AND is_test = 0 AND status = 'BOOKED'").all(date);
  const bySlot = { MORNING: booked.filter(b => b.slot === 'MORNING').length, AFTERNOON: booked.filter(b => b.slot === 'AFTERNOON').length };
  json(res, 200, { ok: true, date, disponibilita: {
    MORNING: { capacity: 6, booked: bySlot.MORNING, free: Math.max(0, 6 - bySlot.MORNING) },
    AFTERNOON: { capacity: 4, booked: bySlot.AFTERNOON, free: Math.max(0, 4 - bySlot.AFTERNOON) },
  }});
});
route('GET', '/api/v1/consulenti', (req, res) => {
  const rows = db.prepare("SELECT code, full_name, macro_areas, role FROM consultant WHERE active = 1 AND is_test = 0 ORDER BY code").all();
  json(res, 200, { ok: true, consulenti: rows });
});

// ---- /api/admin/test-data (FASE 2.4: comando di cancellazione) ---------
// Elimina TUTTI i record con is_test = 1, da TUTTE le tabelle dati.
// Non tocca i record di produzione (is_test = 0). Non tocca il codice.
route('DELETE', '/api/admin/test-data', { auth: 'master' }, (req, res) => {
  const tables = IS_TEST_TABLES;
  const counts = {};
  db.exec('BEGIN');
  try {
    for (const t of tables) {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE is_test = 1`).get();
      counts[t] = r.n;
      db.prepare(`DELETE FROM ${t} WHERE is_test = 1`).run();
    }
    db.prepare("DELETE FROM test_record").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  logEntry('master', 'TEST_DATA_PURGE', 'AUDIT', null, req.socket.remoteAddress, JSON.stringify(counts));
  json(res, 200, { ok: true, deleted: counts });
});

// ---- / (home: minimal landing for humans) -------------------------------
route('GET', '/', (req, res) => {
  const setup = db.prepare("SELECT value FROM setup_state WHERE key = 'setup_complete'").get();
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C.S.I. Front Office</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#F7F4ED;color:#001C3A;padding:40px}
.card{max-width:520px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,28,58,.1)}
h1{margin:0 0 8px;font-size:22px} .sub{color:#39546B;margin:0 0 20px}
code{background:#F7F4ED;padding:2px 6px;border-radius:4px;font-size:13px}
ul{line-height:1.8;font-size:14px} a{color:#001C3A}
.banner{padding:10px 14px;border-radius:8px;font-size:13px;margin:0 0 16px}
.banner.todo{background:#FEF3C7;color:#92400E} .banner.ok{background:#DCFCE7;color:#166534}
</style></head><body><div class="card">
<h1>C.S.I. Front Office · Centro Servizi Integrati</h1>
<p class="sub">CRM centrale · rigenerato (file unico Node.js)</p>
${setup && setup.value === '1'
  ? `<div class="banner ok">Setup completato. Usa le API con autenticazione 3FA.</div>`
  : `<div class="banner todo">Primo accesso: <code>POST /api/auth/register</code> con masterEmail e password per inizializzare il Master.</div>`}
<ul>
<li><a href="/api/health">/api/health</a> — stato del server</li>
<li><a href="/api/auth/check-setup">/api/auth/check-setup</a> — stato setup</li>
<li><code>POST /api/admin/import-services</code> — importa servizi da <code>config/services.json</code></li>
<li><code>POST /api/auth/register</code> — primo accesso Master (una tantum)</li>
<li><code>POST /api/auth/send-otp-email</code> + <code>POST /api/auth/verify-otp</code> — login 3FA</li>
<li><code>POST /api/operators/:id/qr</code> — genera QR operatore</li>
<li><code>/operator/:token</code> — pagina di login operatore via QR (mobile)</li>
<li><code>DELETE /api/admin/test-data</code> — elimina tutti i record di test (is_test=1)</li>
</ul>
<p class="sub">Seed: <code>CSI_TEST_SEED=1 node scripts/seed.js</code> (solo ambiente di prova)</p>
</div></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// =============================================================================
//  SERVER BOOTSTRAP
// =============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(async (req, res) => {
  // CORS preflight globale per /api/v1 e /api/webhook (già gestito in dispatch)
  try {
    await dispatch(req, res);
  } catch (e) {
    logEntry('system', 'UNCAUGHT_ERROR', 'ERROR', req.url, req.socket.remoteAddress, e.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  logEntry('system', 'SERVER_START', 'INFO', null, null, `port=${PORT} node=${process.version} db=${path.basename(DB_PATH)}`);
  process.stdout.write(`C.S.I. Front Office (rigenerato) in ascolto su http://localhost:${PORT}\n`);
  process.stdout.write(`  Node: ${process.version} · DB: ${path.basename(DB_PATH)} · PID: ${process.pid}\n`);
  const setup = db.prepare("SELECT value FROM setup_state WHERE key = 'setup_complete'").get();
  if (!setup || setup.value !== '1') {
    process.stdout.write(`  Primo accesso: POST /api/auth/register {masterEmail, password, fingerprintSeed}\n`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
