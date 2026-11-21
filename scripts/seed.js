#!/usr/bin/env node
// =============================================================================
//  C.S.I. Front Office — SEED (dati dimostrativi)
// -----------------------------------------------------------------------------
//  REGOLE FASE 2.4:
//    - Attivo SOLO con variabile ambiente CSI_TEST_SEED=1.
//    - Ogni record creato ha is_test = 1.
//    - Comando di eliminazione: DELETE /api/admin/test-data (elimina tutti i
//      record con is_test = 1, su tutte le tabelle, senza toccare il codice).
//    - Non scrive nel codice di produzione: usa le API REST del server in
//      ascolto (o scrive direttamente nel DB se il server non è avviato).
//
//  USO:
//    # Avvia il server in una shell
//    node crm.js
//    # In un'altra shell, con CSI_TEST_SEED=1, esegui il seed
//    CSI_TEST_SEED=1 node scripts/seed.js
//
//  COSA CREA (dati palesemente fittizi, is_test = 1):
//    - 3 consulenti di test
//    - 2 clienti di test
//    - 2 prenotazioni di test
//    - 1 pratica di test
//    - 1 operatore front desk di test (con access code nota)
//    - 1 chiave API di test (mascherata + encrypted_ref)
//    - 1 fingerprint macchina di test
//    - 1 sito esterno di test
//
//  CLEANUP:
//    curl -X DELETE http://localhost:3000/api/admin/test-data \
//         -H "X-Master-Token: <master token>"
//    # Oppure direttamente nel DB:
//    #   DELETE FROM <table> WHERE is_test = 1; (per ogni tabella dati)
// =============================================================================

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

if (process.env.CSI_TEST_SEED !== '1') {
  console.error('ERRORE: questo script crea dati DIMOSTRATIVI. Imposta CSI_TEST_SEED=1 per confermare.');
  console.error('  CSI_TEST_SEED=1 node scripts/seed.js');
  process.exit(2);
}

// Il seed parla con il server via HTTP (porta 3000 di default), così non
// manipola il DB mentre il server ha lock attivi. Richiede che il server
// sia già stato avviato con `node crm.js` e che il setup sia completo.
const BASE = process.env.SEED_BASE_URL || 'http://localhost:3000';
const PORT = process.env.PORT || '3000';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- Connessione diretta al DB (se il server non è avviato) ----
// Usiamo node:sqlite direttamente per scrivere i record di test, marcando
// is_test = 1. Questo evita la dipendenza dal server avviato.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite non disponibile. Serve Node >= 22.5. Qui:', process.version);
  process.exit(1);
}
const DB_PATH = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:')
  ? process.env.DATABASE_URL.slice(5)
  : path.join(process.cwd(), 'crm.sqlite');

if (!fs.existsSync(DB_PATH)) {
  console.error('DB non trovato:', DB_PATH);
  console.error('Avvia prima il server con `node crm.js` per creare le tabelle, poi rilancia il seed.');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

const cuid = () => crypto.randomBytes(16).toString('hex');
const nowISO = () => new Date().toISOString();

// ---- Verifica setup completo ----
const setup = db.prepare("SELECT value FROM setup_state WHERE key = 'setup_complete'").get();
if (!setup || setup.value !== '1') {
  console.error('Setup non completato. Esegui prima:');
  console.error('  curl -X POST http://localhost:' + PORT + '/api/auth/register \\');
  console.error('       -H "Content-Type: application/json" \\');
  console.error('       -d \'{"masterEmail":"test@example.invalid","password":"test-master-pw","fingerprintSeed":"test-fp-seed"}\'');
  process.exit(1);
}

// ---- Helper di insert con is_test = 1 ----
function ins(table, cols, row) {
  const colsList = cols.join(', ');
  const ph = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${colsList}, is_test) VALUES (${ph}, 1)`).run(...cols.map(c => row[c]));
}

// ---- Cleanup preventivo (rimuove vecchi test record se presenti) ----
const tables = [
  'consultant', 'client', 'appointment', 'practice', 'contract',
  'api_key', 'front_desk_operator', 'filled_module', 'external_site',
  'machine_fingerprint', 'service_catalog', 'operator_session', 'operator_log'
];
for (const t of tables) {
  try { db.prepare(`DELETE FROM ${t} WHERE is_test = 1`).run(); } catch (e) { /* col mancante? */ }
}
// Cleanup anche test_record
try { db.prepare('DELETE FROM test_record').run(); } catch (e) { }

// ---- MACRO AREE + SERVIZI (se vuoti, importo dal config) ----
let nAreas = db.prepare('SELECT COUNT(*) AS n FROM macro_area').get().n;
if (nAreas === 0) {
  const cfgPath = path.join(process.cwd(), 'config', 'services.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    for (const a of cfg.macroAreas) {
      db.prepare(
        "INSERT INTO macro_area (id, code, name, description, color, icon, active, is_test) " +
        "VALUES (?,?,?,?,?,?,1,1)"
      ).run(cuid(), a.code, a.name, a.description, a.color, a.icon);
      for (const s of (a.services || [])) {
        db.prepare(
          "INSERT INTO service_catalog (id, code, area_code, title, description, active, source, is_test) " +
          "VALUES (?,?,?,?,?,1,'CONFIG',1)"
        ).run(cuid(), s.code, a.code, s.title, s.description);
      }
    }
    console.log('Importate macro aree e servizi di test (is_test=1).');
  } else {
    console.error('config/services.json non trovato. Le macro aree di test NON create.');
  }
}

// ---- CONSULENTI DI TEST ----
const consultants = [
  { code: 'C-TEST-001', fullName: 'Mario Rossi (test)', email: 'test-cons-1@example.invalid', macroAreas: '01,02,06', role: 'Senior', maxSlots: 2 },
  { code: 'C-TEST-002', fullName: 'Anna Verdi (test)', email: 'test-cons-2@example.invalid', macroAreas: '03,04,09', role: 'Operatore', maxSlots: 2 },
  { code: 'C-TEST-003', fullName: 'Luca Bianchi (test)', email: 'test-cons-3@example.invalid', macroAreas: '07,08', role: 'Coordinatore', maxSlots: 2 },
];
for (const c of consultants) {
  ins('consultant', ['id', 'code', 'full_name', 'email', 'role', 'macro_areas', 'active', 'max_slots_per_day'],
    { id: cuid(), code: c.code, full_name: c.fullName, email: c.email, role: c.role, macro_areas: c.macroAreas, active: 1, max_slots_per_day: c.maxSlots });
  db.prepare('UPDATE consultant SET is_test = 1 WHERE code = ?').run(c.code);
}
console.log(`Create ${consultants.length} consulenti di test.`);

// ---- CLIENTI DI TEST ----
const year = new Date().getFullYear();
const clients = [
  {
    code: `CL-${year}-TEST-0001`, firstName: 'Maria', lastName: 'Esposito (test)',
    fiscalCode: 'TESTMR000X00X000X', phone: '+39 333 0000001',
    email: 'test-client-1@example.invalid', city: 'Città Test', address: 'Via Test 1', notes: 'Record di test (is_test=1)'
  },
  {
    code: `CL-${year}-TEST-0002`, firstName: 'Giovanni', lastName: 'Russo (test)',
    fiscalCode: 'TESTGV000X00X000X', phone: '+39 333 0000002',
    email: 'test-client-2@example.invalid', city: 'Città Test', address: 'Via Test 2', notes: 'Record di test (is_test=1)'
  },
];
const clientCodes = [];
for (const c of clients) {
  ins('client', ['id', 'code', 'first_name', 'last_name', 'fiscal_code', 'phone', 'email', 'address', 'city', 'notes', 'iban_later_in_sede'],
    { id: cuid(), code: c.code, first_name: c.firstName, last_name: c.lastName, fiscal_code: c.fiscalCode, phone: c.phone, email: c.email, address: c.address, city: c.city, notes: c.notes, iban_later_in_sede: 0 });
  clientCodes.push(c.code);
}
console.log(`Creati ${clients.length} clienti di test.`);

// ---- PRENOTAZIONI DI TEST ----
const cons1 = db.prepare("SELECT id FROM consultant WHERE code = 'C-TEST-001'").get();
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const appts = [
  { clientCode: clientCodes[0], consultantId: cons1.id, areaCode: '01', date: tomorrow, slot: 'MORNING', start: '09:00', end: '12:00' },
  { clientCode: clientCodes[1], consultantId: cons1.id, areaCode: '02', date: tomorrow, slot: 'AFTERNOON', start: '15:00', end: '17:00' },
];
for (const a of appts) {
  ins('appointment', ['id', 'client_code', 'consultant_id', 'area_code', 'date', 'slot', 'start_time', 'end_time', 'status', 'channel'],
    { id: cuid(), client_code: a.clientCode, consultant_id: a.consultantId, area_code: a.areaCode, date: a.date, slot: a.slot, start_time: a.start, end_time: a.end, status: 'BOOKED', channel: 'CRM' });
}
console.log(`Create ${appts.length} prenotazioni di test.`);

// ---- PRATICA DI TEST ----
ins('practice', ['id', 'code', 'client_code', 'area_code', 'title', 'status', 'priority', 'payload_json'],
  { id: cuid(), code: `PR-${year}-TEST-0001`, client_code: clientCodes[0], area_code: '01', title: 'Pratica test (passaporto)', status: 'OPEN', priority: 'NORMAL', payload_json: JSON.stringify({ brogliaccio: false, test: true }) });
console.log('Creata 1 pratica di test.');

// ---- OPERATORE FRONT DESK DI TEST ----
// L'access code è nota qui nel seed perché il seed è uno script di test.
// In produzione, /api/operators genera un access code casuale restituito UNA
// volta sola. Qui lo generiamo deterministico per i test.
const testAccessCode = 'FD-TEST01-0001';
ins('front_desk_operator', ['id', 'code', 'full_name', 'email', 'phone', 'role', 'macro_areas', 'access_code', 'access_code_hash', 'status'],
  { id: cuid(), code: 'FD-TEST-0001', full_name: 'Operatore Test', email: 'test-op@example.invalid', phone: '+39 333 0000003', role: 'Front Desk', macro_areas: '01,02', access_code: testAccessCode, access_code_hash: sha256(testAccessCode), status: 'ACTIVE' });
console.log('Creato 1 operatore front desk di test (access code: ' + testAccessCode + ')');

// ---- CHIAVE API DI TEST ----
// Non salvo la chiave in chiaro: solo il puntatore cifrato al data lake (simulato).
ins('api_key', ['id', 'label', 'service', 'endpoint', 'masked_value', 'encrypted_ref', 'scopes', 'active'],
  { id: cuid(), label: 'Servizio Test (test)', service: 'test', endpoint: 'https://test.example.invalid', masked_value: 'tt••••••••••••test', encrypted_ref: cuid(), scopes: 'read', active: 1 });
console.log('Creata 1 chiave API di test (valore mascherato, encrypted_ref casuale).');

// ---- FINGERPRINT MACCHINA DI TEST ----
// Usa un seed DIVERSO da quello del master registrato per evitare collisioni
// UNIQUE(hash). In test usiamo "test-fp-seed-extra".
const fpHash = sha256('test-fp-seed-extra').slice(0, 40);
// Idempotente: se già esiste, salta.
const existFp = db.prepare("SELECT id FROM machine_fingerprint WHERE hash = ?").get(fpHash);
if (!existFp) {
  ins('machine_fingerprint', ['id', 'hash', 'label', 'status'],
    { id: cuid(), hash: fpHash, label: 'Macchina test (is_test=1)', status: 'AUTHORIZED' });
  console.log('Creata 1 fingerprint macchina di test.');
} else {
  console.log('Fingerprint macchina di test già esistente, saltata.');
}

// ---- SITO ESTERNO DI TEST ----
ins('external_site', ['id', 'site_id', 'name', 'url', 'webhook_secret', 'deploy', 'category', 'active'],
  { id: cuid(), site_id: 'test-site', name: 'Sito Test', url: 'https://test.example.invalid', webhook_secret: 'test-webhook-secret', deploy: 'Netlify', category: 'dynamic', active: 1 });
console.log('Creato 1 sito esterno di test.');

// ---- Riepilogo ----
console.log('');
console.log('=== SEED COMPLETATO (tutti i record con is_test = 1) ===');
const summary = {};
for (const t of ['consultant', 'client', 'appointment', 'practice', 'api_key', 'front_desk_operator', 'machine_fingerprint', 'external_site', 'service_catalog']) {
  try { summary[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE is_test = 1`).get().n; } catch (e) { summary[t] = -1; }
}
console.table(summary);
console.log('');
console.log('Cleanup: curl -X DELETE http://localhost:' + PORT + '/api/admin/test-data -H "X-Master-Token: <token>"');
console.log('Oppure: CSI_TEST_SEED=1 node scripts/seed.js --purge');
db.close();
