#!/usr/bin/env node
// =============================================================================
//  C.S.I. Front Office — Purge test data (CLI helper)
//  Elimina tutti i record con is_test=1 dal DB. NON richiede server avviato.
//  Uso: node scripts/purge-test-data.js [path/to/crm.sqlite]
// =============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');
let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) { console.error('node:sqlite non disponibile. Serve Node >= 22.5.'); process.exit(1); }

const DB_PATH = process.argv[2] ||
  (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:') ? process.env.DATABASE_URL.slice(5) : path.join(process.cwd(), 'crm.sqlite'));

if (!fs.existsSync(DB_PATH)) { console.error('DB non trovato:', DB_PATH); process.exit(1); }
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

const tables = [
  'consultant','client','appointment','practice','contract','api_key',
  'front_desk_operator','filled_module','external_site','machine_fingerprint',
  'service_catalog','operator_session','operator_log'
];
db.exec('BEGIN');
const out = {};
try {
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE is_test = 1`).get();
      db.prepare(`DELETE FROM ${t} WHERE is_test = 1`).run();
      out[t] = r.n;
    } catch (e) { out[t] = -1; }
  }
  try { db.prepare('DELETE FROM test_record').run(); out.test_record = 0; } catch (e) {}
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
db.close();
console.log('Purge completata. Record eliminati (is_test=1):');
console.table(out);
