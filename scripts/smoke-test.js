'use strict';
// =============================================================================
//  C.S.I. Front Office — Smoke test (post-deploy)
//  Esegue 6 controlli contro l'URL specificato. Non muta stato se non richiesto.
//  Uso:  node scripts/smoke-test.js https://crm.tuo-dominio.it
//        (oppure imposta NEXT_PUBLIC_SITE_URL e lancia senza argomenti)
// =============================================================================


const target = process.argv[2] || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
if (!target || !/^https?:\/\//.test(target)) {
  console.error('Uso: node scripts/smoke-test.js <url>');
  console.error('  Esempio: node scripts/smoke-test.js https://crm.tuo-dominio.it');
  process.exit(2);
}

const checks = [];
function ok(name, detail) { checks.push({ name, ok: true, detail }); console.log(`  ✓ ${name}: ${detail || ''}`); }
function ko(name, detail) { checks.push({ name, ok: false, detail }); console.error(`  ✗ ${name}: ${detail || ''}`); }

async function get(path, opts = {}) {
  const u = target.replace(/\/+$/, '') + path;
  const r = await fetch(u, { method: 'GET', headers: opts.headers || {} });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: r.status, body, headers: r.headers, text };
}
async function post(path, payload, opts = {}) {
  const u = target.replace(/\/+$/, '') + path;
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: JSON.stringify(payload) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: r.status, body, headers: r.headers, text };
}

(async () => {
  console.log(`\n=== Smoke test contro ${target} ===\n`);

  // 1. /api/health
  try {
    const r = await get('/api/health');
    if (r.status === 200 && r.body && r.body.ok) {
      ok('/api/health', `node=${r.body.node} setupComplete=${r.body.setupComplete}`);
    } else {
      ko('/api/health', `status=${r.status}`);
    }
  } catch (e) { ko('/api/health', e.message); }

  // 2. /api/auth/check-setup
  try {
    const r = await get('/api/auth/check-setup');
    if (r.status === 200 && r.body && typeof r.body.setupComplete === 'boolean') {
      ok('/api/auth/check-setup', `setupComplete=${r.body.setupComplete} operatorCount=${r.body.operatorCount}`);
    } else { ko('/api/auth/check-setup', `status=${r.status}`); }
  } catch (e) { ko('/api/auth/check-setup', e.message); }

  // 3. /api/macro-areas (vuoto se setup non completato, 9 se importato)
  try {
    const r = await get('/api/macro-areas');
    const n = (r.body && Array.isArray(r.body.macroAreas)) ? r.body.macroAreas.length : -1;
    if (r.status === 200 && n >= 0) ok('/api/macro-areas', `${n} aree`);
    else ko('/api/macro-areas', `status=${r.status} n=${n}`);
  } catch (e) { ko('/api/macro-areas', e.message); }

  // 4. /api/services
  try {
    const r = await get('/api/services');
    const n = (r.body && Array.isArray(r.body.services)) ? r.body.services.length : -1;
    if (r.status === 200 && n >= 0) ok('/api/services', `${n} servizi`);
    else ko('/api/services', `status=${r.status} n=${n}`);
  } catch (e) { ko('/api/services', e.message); }

  // 5. Home page HTML (deve contenere il titolo)
  try {
    const r = await get('/');
    const isHtml = typeof r.body === 'string';
    const hasTitle = isHtml && r.body.includes('C.S.I. Front Office');
    if (hasTitle) ok('GET /', 'HTML con titolo corretto');
    else ko('GET /', 'manca il titolo');
  } catch (e) { ko('GET /', e.message); }

  // 6. /operator/:invalid-token → HTML con errore (deve rispondere, non 404)
  try {
    const r = await get('/operator/invalid-token-for-smoke-test-1234');
    const isHtml = typeof r.body === 'string';
    if (r.status === 200 && isHtml) ok('/operator/<token>', 'route esiste, ritorna HTML');
    else ko('/operator/<token>', `status=${r.status} isHtml=${isHtml}`);
  } catch (e) { ko('/operator/<token>', e.message); }

  const passed = checks.filter(c => c.ok).length;
  const total = checks.length;
  console.log(`\n=== ${passed}/${total} controlli superati ===\n`);
  process.exit(passed === total ? 0 : 1);
})().catch(e => { console.error('Fatal:', e); process.exit(2); });
