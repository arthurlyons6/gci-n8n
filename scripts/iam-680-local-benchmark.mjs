#!/usr/bin/env node
/**
 * IAM-680 local benchmark: EXISTS vs IN — SQL + HTTP E2E
 *
 * Runs 100 iterations of each query variant against a local Postgres,
 * then hits GET /rest/executions 100 times against a running n8n instance.
 *
 * Usage:
 *   PG_HOST=localhost PG_PORT=5432 PG_USER=n8n PG_PASS=n8n PG_DB=n8n \
 *   N8N_BASE_URL=http://localhost:5678 \
 *   N8N_EMAIL=admin@example.com N8N_PASSWORD=yourpassword \
 *   node scripts/iam-680-local-benchmark.mjs
 */

import pg from 'pg';

const { Client } = pg;

const ITERATIONS = 100;

const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = Number(process.env.PG_PORT ?? 5432);
const PG_USER = process.env.PG_USER ?? 'n8n';
const PG_PASS = process.env.PG_PASS ?? 'n8n';
const PG_DB   = process.env.PG_DB   ?? 'n8n';

const N8N_BASE_URL = process.env.N8N_BASE_URL ?? 'http://localhost:5678';
const N8N_EMAIL    = process.env.N8N_EMAIL    ?? 'admin@n8n.io';
const N8N_PASSWORD = process.env.N8N_PASSWORD ?? 'password';

// ── helpers ───────────────────────────────────────────────────────────────────

async function measure(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

function calcStats(lat) {
  const sorted = [...lat].sort((a, b) => a - b);
  const n = lat.length;
  const avg = lat.reduce((s, v) => s + v, 0) / n;
  const variance = lat.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const pct = (p) => sorted[Math.min(Math.floor(n * p), n - 1)];
  return { avg, stddev, cv: stddev / avg, p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), min: sorted[0], max: sorted[n - 1] };
}

/** Mann-Whitney U: P(EXISTS > IN) */
function mannWhitneyU(a, b) {
  let u = 0;
  for (const x of a) for (const y of b) u += x > y ? 1 : x === y ? 0.5 : 0;
  return { u, prob: u / (a.length * b.length) };
}

function fmt(n) { return n.toFixed(1) + ' ms'; }
function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
function delta(e, i) {
  if (e <= 0) return '—';
  const pct = ((1 - i / e) * 100).toFixed(0);
  return e > i ? `**${pct}% faster**` : `${Math.abs(Number(pct))}% slower`;
}

function summaryTable(es, is_) {
  const rows = [
    ['avg',    es.avg,    is_.avg],
    ['p50',    es.p50,    is_.p50],
    ['p75',    es.p75,    is_.p75],
    ['p90',    es.p90,    is_.p90],
    ['p95',    es.p95,    is_.p95],
    ['p99',    es.p99,    is_.p99],
    ['max',    es.max,    is_.max],
    ['min',    es.min,    is_.min],
    ['stddev', es.stddev, is_.stddev],
  ];
  return [
    '| Metric | Version 1 (actual master, EXISTS) | Version 2 (fix, IN) | Δ |',
    '|--------|----------------------------------|---------------------|---|',
    ...rows.map(([l, e, i]) => `| ${l}   | ${fmt(e)} | ${fmt(i)} | ${delta(e, i)} |`),
  ].join('\n');
}

function perIter(a, b, colA, colB) {
  return [
    `| # | ${colA} | ${colB} |`,
    `|---|${'-'.repeat(colA.length + 2)}|${'-'.repeat(colB.length + 2)}|`,
    ...a.map((v, i) => `| ${i + 1} | ${v.toFixed(1)} ms | ${b[i].toFixed(1)} ms |`),
  ].join('\n');
}

function allRunsSummary(countExists, countIn, getManyExists, getManyIn) {
  const ce = calcStats(countExists), ci = calcStats(countIn);
  const gme = calcStats(getManyExists), gmi = calcStats(getManyIn);
  const mwC = mannWhitneyU(countExists, countIn);
  const mwG = mannWhitneyU(getManyExists, getManyIn);

  const col = (s, label) =>
    `| ${label} | ${fmt(s.avg)} | ${fmt(s.p50)} | ${fmt(s.p75)} | ${fmt(s.p90)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} | ${fmt(s.min)} | ${fmt(s.stddev)} | ${fmtPct(s.cv)} |`;

  const mwInterp = (p) => p > 0.6 ? '✅ IN faster, statistically confident' : p > 0.5 ? '⚠️ IN slightly faster, marginal' : '❌ No significant difference';

  return `### All-runs summary

| Variant | avg | p50 | p75 | p90 | p95 | p99 | max | min | stddev | CV |
|---------|-----|-----|-----|-----|-----|-----|-----|-----|--------|-----|
${col(ce,  'COUNT EXISTS (V1)')}
${col(ci,  'COUNT IN (V2)')}
${col(gme, 'getMany EXISTS (V1)')}
${col(gmi, 'getMany IN (V2)')}

**Delta (V1 → V2):**

| Metric | COUNT Δ | getMany Δ |
|--------|---------|-----------|
| avg    | ${delta(ce.avg, ci.avg)} | ${delta(gme.avg, gmi.avg)} |
| p50    | ${delta(ce.p50, ci.p50)} | ${delta(gme.p50, gmi.p50)} |
| p75    | ${delta(ce.p75, ci.p75)} | ${delta(gme.p75, gmi.p75)} |
| p90    | ${delta(ce.p90, ci.p90)} | ${delta(gme.p90, gmi.p90)} |
| p95    | ${delta(ce.p95, ci.p95)} | ${delta(gme.p95, gmi.p95)} |
| p99    | ${delta(ce.p99, ci.p99)} | ${delta(gme.p99, gmi.p99)} |
| max    | ${delta(ce.max, ci.max)} | ${delta(gme.max, gmi.max)} |
| stddev | ${delta(ce.stddev, ci.stddev)} | ${delta(gme.stddev, gmi.stddev)} |

**Mann-Whitney U — P(EXISTS > IN):**

| Query | U | P(EXISTS > IN) | Interpretation |
|-------|---|----------------|----------------|
| COUNT(*) | ${mwC.u.toFixed(0)} | ${fmtPct(mwC.prob)} | ${mwInterp(mwC.prob)} |
| getMany  | ${mwG.u.toFixed(0)} | ${fmtPct(mwG.prob)} | ${mwInterp(mwG.prob)} |`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const client = new Client({ host: PG_HOST, port: PG_PORT, user: PG_USER, password: PG_PASS, database: PG_DB });
  await client.connect();
  console.log(`Connected to ${PG_HOST}:${PG_PORT}/${PG_DB}`);

  // Discover admin user
  let adminId, adminEmail;
  for (const q of [
    `SELECT id, email FROM "user" WHERE "roleSlug" = 'global:owner' LIMIT 1`,
    `SELECT id, email FROM "user" LIMIT 1`,
  ]) {
    const { rows } = await client.query(q);
    if (rows.length > 0) { adminId = rows[0].id; adminEmail = rows[0].email; console.log(`Admin: ${adminEmail} (${adminId})`); break; }
  }
  if (!adminId) throw new Error('No user found in DB');

  const { rows: [{ count: execCount }] } = await client.query('SELECT COUNT(*)::text as count FROM execution_entity');
  console.log(`Executions in DB: ${Number(execCount).toLocaleString()}\n`);

  // ── SQL variants ──────────────────────────────────────────────────────────
  const wfRoles  = `'workflow:owner','workflow:editor'`;
  const prjRoles = `'project:admin','project:editor','project:viewer','project:personalOwner'`;

  const subExists = `
    SELECT sw."workflowId"
    FROM shared_workflow sw
    INNER JOIN project p ON p.id = sw."projectId"
    INNER JOIN project_relation pr ON pr."projectId" = p.id
    WHERE sw.role IN (${wfRoles})
      AND pr."userId" = '${adminId}'
      AND pr.role IN (${prjRoles})
      AND sw."workflowId" = execution."workflowId"`;

  const subIn = `
    SELECT sw."workflowId"
    FROM shared_workflow sw
    INNER JOIN project p ON p.id = sw."projectId"
    INNER JOIN project_relation pr ON pr."projectId" = p.id
    WHERE sw.role IN (${wfRoles})
      AND pr."userId" = '${adminId}'
      AND pr.role IN (${prjRoles})`;

  const sqlExistsCount = `
    SELECT COUNT(*) FROM execution_entity execution
    INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
    WHERE EXISTS (${subExists})`;

  const sqlInCount = `
    SELECT COUNT(*) FROM execution_entity execution
    INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
    WHERE execution."workflowId" IN (${subIn})`;

  const sqlExistsGetMany = `
    SELECT execution.id, execution."workflowId", execution.mode,
           execution.status, execution."createdAt", execution."startedAt",
           execution."stoppedAt", workflow.name AS "workflowName"
    FROM execution_entity execution
    INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
    WHERE EXISTS (${subExists})
    ORDER BY execution.id DESC LIMIT 10`;

  const sqlInGetMany = `
    SELECT execution.id, execution."workflowId", execution.mode,
           execution.status, execution."createdAt", execution."startedAt",
           execution."stoppedAt", workflow.name AS "workflowName"
    FROM execution_entity execution
    INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
    WHERE execution."workflowId" IN (${subIn})
    ORDER BY execution.id DESC LIMIT 10`;

  // ── EXPLAIN ANALYZE ───────────────────────────────────────────────────────
  let explainExists = '', explainIn = '';
  try {
    const { rows: eRows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlExistsCount}`);
    explainExists = eRows.map(r => r['QUERY PLAN']).join('\n');
    const { rows: iRows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlInCount}`);
    explainIn = iRows.map(r => r['QUERY PLAN']).join('\n');
    console.log('[EXPLAIN] Plans captured');
  } catch (e) {
    console.warn('EXPLAIN ANALYZE failed:', e.message);
  }

  // ── Measure SQL ───────────────────────────────────────────────────────────
  const run = async (label, sql) => {
    const lats = [];
    process.stdout.write(`[SQL] ${label} (${ITERATIONS} iters):`);
    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measure(() => client.query(sql));
      lats.push(ms);
      if ((i + 1) % 10 === 0) process.stdout.write(` ${ms.toFixed(0)}[${i+1}]`);
      else process.stdout.write(` ${ms.toFixed(0)}`);
    }
    const s = calcStats(lats);
    console.log(`\n  → avg=${fmt(s.avg)} p50=${fmt(s.p50)} p95=${fmt(s.p95)} stddev=${fmt(s.stddev)}`);
    return lats;
  };

  const existsCountLat   = await run('EXISTS COUNT(*)', sqlExistsCount);
  const inCountLat       = await run('IN     COUNT(*)', sqlInCount);
  const existsGetManyLat = await run('EXISTS getMany ', sqlExistsGetMany);
  const inGetManyLat     = await run('IN     getMany ', sqlInGetMany);

  // ── HTTP E2E ──────────────────────────────────────────────────────────────
  let httpSection = '';
  try {
    const loginRes = await fetch(`${N8N_BASE_URL}/rest/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrLdapLoginId: N8N_EMAIL, password: N8N_PASSWORD }),
    });
    if (!loginRes.ok) throw new Error(`Login HTTP ${loginRes.status}`);
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!cookie) throw new Error('No session cookie in login response');
    console.log(`\n[HTTP] Logged in as ${N8N_EMAIL}`);

    const httpLat = [];
    process.stdout.write(`[HTTP] GET /rest/executions (${ITERATIONS} iters):`);
    for (let i = 0; i < ITERATIONS; i++) {
      const ms = await measure(async () => {
        const res = await fetch(`${N8N_BASE_URL}/rest/executions?limit=10&includeData=false`, {
          headers: { Cookie: cookie },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.json();
      });
      httpLat.push(ms);
      if ((i + 1) % 10 === 0) process.stdout.write(` ${ms.toFixed(0)}[${i+1}]`);
      else process.stdout.write(` ${ms.toFixed(0)}`);
    }
    const hs = calcStats(httpLat);
    console.log(`\n  → avg=${fmt(hs.avg)} p50=${fmt(hs.p50)} p95=${fmt(hs.p95)} stddev=${fmt(hs.stddev)}`);

    httpSection = `
---

### HTTP E2E (Version 2, fix applied) — full stack: HTTP → Express → TypeORM → Postgres

n8n: \`${N8N_BASE_URL}\`

\`GET /rest/executions?limit=10\` internally calls \`findRangeWithCount()\` — runs
both getMany (LIMIT 10) and COUNT(*) in a single request, exactly as the executions
list page does on every load.

| Metric | Latency |
|--------|---------|
| avg    | ${fmt(hs.avg)} |
| p50    | ${fmt(hs.p50)} |
| p75    | ${fmt(hs.p75)} |
| p90    | ${fmt(hs.p90)} |
| p95    | ${fmt(hs.p95)} |
| p99    | ${fmt(hs.p99)} |
| max    | ${fmt(hs.max)} |
| min    | ${fmt(hs.min)} |
| stddev | ${fmt(hs.stddev)} |
| CV     | ${fmtPct(hs.cv)} |

<details><summary>Per-iteration</summary>

| # | GET /rest/executions |
|---|---------------------|
${httpLat.map((ms, i) => `| ${i + 1} | ${ms.toFixed(1)} ms |`).join('\n')}
</details>`;
  } catch (e) {
    console.warn(`\n[HTTP] Skipped — ${e.message}`);
    console.warn(`        Set N8N_BASE_URL, N8N_EMAIL, N8N_PASSWORD to enable HTTP E2E`);
    httpSection = `
---

### HTTP E2E — skipped

n8n not reachable at \`${N8N_BASE_URL}\`. Re-run with:
\`\`\`
N8N_BASE_URL=http://localhost:5678 N8N_EMAIL=... N8N_PASSWORD=... node scripts/iam-680-local-benchmark.mjs
\`\`\``;
  }

  await client.end();

  // ── Build report ──────────────────────────────────────────────────────────
  const report = `## IAM-680 Local Benchmark: EXISTS vs IN (${ITERATIONS} iterations, warm cache)

**Setup:** ${PG_HOST}:${PG_PORT}/${PG_DB} · ${Number(execCount).toLocaleString()} executions
**Note:** warm cache (no Postgres restart between iterations). Cold-cache CI numbers are in the Playwright benchmark.

---

${allRunsSummary(existsCountLat, inCountLat, existsGetManyLat, inGetManyLat)}

---

### COUNT(*) — no LIMIT (the real bottleneck)

${summaryTable(calcStats(existsCountLat), calcStats(inCountLat))}

<details><summary>Per-iteration</summary>

${perIter(existsCountLat, inCountLat, 'EXISTS COUNT', 'IN COUNT')}
</details>

---

### getMany (LIMIT 10)

${summaryTable(calcStats(existsGetManyLat), calcStats(inGetManyLat))}

<details><summary>Per-iteration</summary>

${perIter(existsGetManyLat, inGetManyLat, 'EXISTS getMany', 'IN getMany')}
</details>

---

### EXPLAIN ANALYZE — COUNT(*) query plans

<details><summary>Version 1 (actual master, EXISTS)</summary>

\`\`\`
${explainExists || 'not available'}
\`\`\`
</details>

<details><summary>Version 2 (fix, IN)</summary>

\`\`\`
${explainIn || 'not available'}
\`\`\`
</details>
${httpSection}
`;

  console.log('\n' + report);

  const { writeFileSync } = await import('fs');
  const out = 'iam-680-local-benchmark-report.md';
  writeFileSync(out, report);
  console.log(`\nReport saved to ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
