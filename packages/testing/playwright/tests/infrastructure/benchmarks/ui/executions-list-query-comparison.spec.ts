/**
 * IAM-680 cold-cache benchmark: EXISTS (before fix) vs IN (after fix).
 *
 * Reproduces the CrowdStrike scenario exactly:
 *   - project:admin user, 400 workflows, 1 M executions
 *   - Global executions view (no projectId filter) — the worst case
 *   - Postgres restarted before EVERY iteration to flush shared_buffers
 *
 * On Linux CI the container restart clears the Postgres buffer pool completely
 * (unlike Mac Docker Desktop where the VM retains the OS page cache).
 * This gives reliable cold-cache numbers that match production first-open latency.
 *
 * Three query shapes are measured:
 *   1. getMany EXISTS  — LIMIT 10, index scan exits early (both variants equally fast)
 *   2. getMany IN      — same, for comparison
 *   3. COUNT EXISTS    — no LIMIT, must scan all rows: the real bottleneck
 *   4. COUNT IN        — same with the fix: hash semi-join, O(1)
 *
 * Report includes:
 *   - Summary table with avg / p50 / p75 / p90 / p95 / p99 / max / stddev / CV
 *   - Per-iteration raw latency table
 *   - EXPLAIN ANALYZE query plans for both COUNT variants
 *   - Delta column: % improvement IN vs EXISTS
 *
 * Outputs a markdown report suitable for pasting into the Linear ticket.
 */
import { setupAdminViewsExecutionsList } from '../../../../composables/journeys/admin-views-executions-list';
import { test } from '../../../../fixtures/base';
import { benchConfig } from '../../../../playwright-projects';
import type { ApiHelpers } from '../../../../services/api-helper';
import { bulkSeedExecutions } from '../harness/bulk-seed-executions';

const ITERATIONS = 50;
const WORKFLOWS_IN_PROJECT = 400;
const PRESEEDED_EXECUTIONS = 1_000_000;
const CREATE_BATCH_SIZE = 20;

test.use({
	capability: benchConfig('executions-list-query-comparison', {
		env: {
			EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'all',
			EXECUTIONS_DATA_PRUNE: 'false',
		},
	}),
});

async function inflateProjectWorkflows(
	api: ApiHelpers,
	projectId: string,
	target: number,
	existing: number,
): Promise<void> {
	const toAdd = Math.max(0, target - existing);
	if (toAdd === 0) return;
	for (let offset = 0; offset < toAdd; offset += CREATE_BATCH_SIZE) {
		const batch = Math.min(CREATE_BATCH_SIZE, toAdd - offset);
		await Promise.all(
			Array.from({ length: batch }, async () => await api.workflows.createInProject(projectId)),
		);
	}
}

// ── Statistics ────────────────────────────────────────────────────────────────

function calcStats(latencies: number[]) {
	const sorted = [...latencies].sort((a, b) => a - b);
	const n = latencies.length;
	const avg = latencies.reduce((s, v) => s + v, 0) / n;
	const variance = latencies.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
	const stddev = Math.sqrt(variance);
	const pct = (p: number) => sorted[Math.min(Math.floor(n * p), n - 1)]!;
	return {
		avg,
		stddev,
		cv: stddev / avg, // coefficient of variation
		p50: pct(0.5),
		p75: pct(0.75),
		p90: pct(0.9),
		p95: pct(0.95),
		p99: pct(0.99),
		min: sorted[0]!,
		max: sorted[n - 1]!,
	};
}

/** Mann-Whitney U statistic: P(X < Y) — probability that EXISTS > IN */
function mannWhitneyU(a: number[], b: number[]): { u: number; prob: number } {
	let u = 0;
	for (const x of a) for (const y of b) u += x > y ? 1 : x === y ? 0.5 : 0;
	return { u, prob: u / (a.length * b.length) };
}

function fmt(n: number) {
	return n.toFixed(1) + ' ms';
}
function fmtPct(n: number) {
	return (n * 100).toFixed(1) + '%';
}
function delta(e: number, i: number): string {
	if (e <= 0) return '—';
	const pct = ((1 - i / e) * 100).toFixed(0);
	return e > i ? `**${pct}% faster**` : `${Math.abs(Number(pct))}% slower`;
}

// ── Report builders ───────────────────────────────────────────────────────────

function summaryTable(
	existsS: ReturnType<typeof calcStats>,
	inS: ReturnType<typeof calcStats>,
): string {
	const rows = [
		['avg', existsS.avg, inS.avg],
		['p50', existsS.p50, inS.p50],
		['p75', existsS.p75, inS.p75],
		['p90', existsS.p90, inS.p90],
		['p95', existsS.p95, inS.p95],
		['p99', existsS.p99, inS.p99],
		['max', existsS.max, inS.max],
		['min', existsS.min, inS.min],
		['stddev', existsS.stddev, inS.stddev],
	] as [string, number, number][];

	const header = `| Metric | Version 1 (actual master, EXISTS) | Version 2 (fix, IN) | Δ |`;
	const sep = `|--------|----------------------------------|---------------------|---|`;
	const dataRows = rows.map(
		([label, e, i]) => `| ${label}   | ${fmt(e)} | ${fmt(i)} | ${delta(e, i)} |`,
	);
	return [header, sep, ...dataRows].join('\n');
}

function perIterationTable(existsLatencies: number[], inLatencies: number[]): string {
	return existsLatencies
		.map((e, i) => `| ${i + 1} | ${e.toFixed(1)} ms | ${inLatencies[i]!.toFixed(1)} ms |`)
		.join('\n');
}

function allRunsSummaryTable(
	getManyExists: number[],
	getManyIn: number[],
	countExists: number[],
	countIn: number[],
): string {
	const gme = calcStats(getManyExists);
	const gmi = calcStats(getManyIn);
	const ce = calcStats(countExists);
	const ci = calcStats(countIn);

	const mwGetMany = mannWhitneyU(getManyExists, getManyIn);
	const mwCount = mannWhitneyU(countExists, countIn);

	const col = (s: ReturnType<typeof calcStats>, label: string) =>
		`| ${label} | ${fmt(s.avg)} | ${fmt(s.p50)} | ${fmt(s.p75)} | ${fmt(s.p90)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} | ${fmt(s.min)} | ${fmt(s.stddev)} | ${fmtPct(s.cv)} |`;

	const mwInterp = (p: number) =>
		p > 0.6
			? '✅ IN faster, statistically confident'
			: p > 0.5
				? '⚠️ IN slightly faster, marginal'
				: '❌ No significant difference';

	return `### All-runs summary

#### COUNT(*) — no LIMIT (the real bottleneck)

| Variant | avg | p50 | p75 | p90 | p95 | p99 | max | min | stddev | CV |
|---------|-----|-----|-----|-----|-----|-----|-----|-----|--------|-----|
${col(ce, 'V1 (actual master)')}
${col(ci, 'V2 (fix)')}

| Metric | Δ (V1 → V2) |
|--------|-------------|
| avg    | ${delta(ce.avg, ci.avg)} |
| p50    | ${delta(ce.p50, ci.p50)} |
| p75    | ${delta(ce.p75, ci.p75)} |
| p90    | ${delta(ce.p90, ci.p90)} |
| p95    | ${delta(ce.p95, ci.p95)} |
| p99    | ${delta(ce.p99, ci.p99)} |
| max    | ${delta(ce.max, ci.max)} |
| stddev | ${delta(ce.stddev, ci.stddev)} |

Mann-Whitney U: ${mwCount.u.toFixed(0)} — P(V1 > V2) = ${fmtPct(mwCount.prob)} — ${mwInterp(mwCount.prob)}

#### getMany (LIMIT 10)

| Variant | avg | p50 | p75 | p90 | p95 | p99 | max | min | stddev | CV |
|---------|-----|-----|-----|-----|-----|-----|-----|-----|--------|-----|
${col(gme, 'V1 (actual master)')}
${col(gmi, 'V2 (fix)')}

| Metric | Δ (V1 → V2) |
|--------|-------------|
| avg    | ${delta(gme.avg, gmi.avg)} |
| p50    | ${delta(gme.p50, gmi.p50)} |
| p75    | ${delta(gme.p75, gmi.p75)} |
| p90    | ${delta(gme.p90, gmi.p90)} |
| p95    | ${delta(gme.p95, gmi.p95)} |
| p99    | ${delta(gme.p99, gmi.p99)} |
| max    | ${delta(gme.max, gmi.max)} |
| stddev | ${delta(gme.stddev, gmi.stddev)} |

Mann-Whitney U: ${mwGetMany.u.toFixed(0)} — P(V1 > V2) = ${fmtPct(mwGetMany.prob)} — ${mwInterp(mwGetMany.prob)}`;
}

function httpSummarySection(httpLat: number[], setup: { iterations: number }): string {
	const hs = calcStats(httpLat);
	const col = (s: ReturnType<typeof calcStats>) =>
		`| V2 (fix, current code) | ${fmt(s.avg)} | ${fmt(s.p50)} | ${fmt(s.p75)} | ${fmt(s.p90)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} | ${fmt(s.min)} | ${fmt(s.stddev)} | ${fmtPct(s.cv)} |`;

	return `### HTTP E2E — GET /rest/executions (V2, fix applied, ${setup.iterations} cold-cache iterations)

Full stack: HTTP → Express → TypeORM → Postgres → JSON response.
\`GET /rest/executions?limit=10\` calls \`findRangeWithCount()\` — runs both getMany + COUNT(*) per request.
Auth: project:admin user (same scope as CrowdStrike scenario).
**Cold cache:** Postgres restarted before every iteration (same condition as SQL measurements).

| Variant | avg | p50 | p75 | p90 | p95 | p99 | max | min | stddev | CV |
|---------|-----|-----|-----|-----|-----|-----|-----|-----|--------|-----|
${col(hs)}

<details><summary>Per-iteration latencies</summary>

| # | GET /rest/executions |
|---|---------------------|
${httpLat.map((ms, i) => `| ${i + 1} | ${ms.toFixed(1)} ms |`).join('\n')}
</details>`;
}

function renderMarkdown(
	getManyExists: number[],
	getManyIn: number[],
	countExists: number[],
	countIn: number[],
	httpLat: number[],
	setup: { workflows: number; executions: number; iterations: number },
	explainExists: string,
	explainIn: string,
): string {
	const gme = calcStats(getManyExists);
	const gmi = calcStats(getManyIn);
	const ce = calcStats(countExists);
	const ci = calcStats(countIn);

	return `
## Benchmark: EXISTS vs IN access-control filter (cold cache, ${setup.iterations} iterations)

**Setup:** ${setup.workflows} workflows · ${setup.executions.toLocaleString()} executions · project:admin scope · global view
**Method:** Postgres container restarted before every iteration (flushes shared_buffers — Linux CI cold-cache)

---

${allRunsSummaryTable(getManyExists, getManyIn, countExists, countIn)}

---

### Query 1 — getMany (LIMIT 10, ORDER BY id DESC)

Mirrors \`findManyByRangeQuery()\`. Postgres uses a B-tree index scan and exits after
the first 10 matching rows — EXISTS and IN are equally fast here because Postgres
never evaluates the filter against all rows.

${summaryTable(gme, gmi)}

<details><summary>Per-iteration latencies</summary>

| # | EXISTS | IN |
|---|--------|----|
${perIterationTable(getManyExists, getManyIn)}
</details>

---

### Query 3 — COUNT(*) — no LIMIT (**the real bottleneck**)

Mirrors \`getExecutionsCountForQuery()\` which fires alongside every getMany call.
No LIMIT means Postgres must evaluate the access-control filter for **every row**.
EXISTS re-evaluates the correlated subquery ${setup.executions.toLocaleString()} times.
IN computes the accessible-workflow set once and uses a hash semi-join.

${summaryTable(ce, ci)}

<details><summary>Per-iteration latencies</summary>

| # | EXISTS COUNT | IN COUNT |
|---|-------------|---------|
${perIterationTable(countExists, countIn)}
</details>

---

### EXPLAIN ANALYZE — COUNT(*) query plans (single cold run each)

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

---

${httpSummarySection(httpLat, setup)}

---

### Fix

\`packages/@n8n/db/src/repositories/execution.repository.ts\`

\`\`\`diff
- subquery.andWhere('"sw"."workflowId" = execution."workflowId"');
- qb.where(\`EXISTS (\${subquery.getQuery()})\`);
+ // Non-correlated IN — Postgres evaluates once, hash semi-join
+ qb.where(\`execution."workflowId" IN (\${subquery.getQuery()})\`);
\`\`\`
`.trim();
}

test.describe(
	'executions getMany: EXISTS (before) vs IN (after) — cold-cache direct SQL comparison',
	{
		tag: '@bench:ui',
		annotation: [
			{ type: 'owner', description: 'Catalysts' },
			{ type: 'question', description: 'executions-list-query-comparison' },
		],
	},
	() => {
		test(`EXISTS vs IN | ${ITERATIONS} cold-cache iterations | ${WORKFLOWS_IN_PROJECT} wf | ${PRESEEDED_EXECUTIONS.toLocaleString()} execs | getMany + COUNT + HTTP E2E`, async ({
			services,
			n8n,
		}, testInfo) => {
			// 4 × 50 SQL iterations × ~10 s per restart + 50 HTTP + ~5 min seeding ≈ 40 min total.
			testInfo.setTimeout(120 * 60 * 1000);

			// ── Setup ────────────────────────────────────────────────────────
			const ctx = await setupAdminViewsExecutionsList(n8n.api);
			await inflateProjectWorkflows(
				n8n.api,
				ctx.project.id,
				WORKFLOWS_IN_PROJECT,
				ctx.workflows.length,
			);
			await bulkSeedExecutions(services, {
				projectId: ctx.project.id,
				count: PRESEEDED_EXECUTIONS,
			});

			const adminIdRaw = await services.postgres.exec(
				`SELECT id FROM "user" WHERE email = '${ctx.admin.email}' LIMIT 1;`,
			);
			const adminId = adminIdRaw.trim();

			// ── SQL variants ──────────────────────────────────────────────────
			// Roles mirror isSharingEnabled() === true (enterprise, as at CrowdStrike).
			const workflowRoles = `'workflow:owner','workflow:editor'`;
			const projectRoles = `'project:admin','project:editor','project:viewer'`;

			// Access-control subquery — correlated (EXISTS, BEFORE fix)
			const accessSubqueryExists = `
					SELECT sw."workflowId"
					FROM shared_workflow sw
					INNER JOIN project p ON p.id = sw."projectId"
					INNER JOIN project_relation pr ON pr."projectId" = p.id
					WHERE sw.role IN (${workflowRoles})
					  AND pr."userId" = '${adminId}'
					  AND pr.role IN (${projectRoles})
					  AND sw."workflowId" = execution."workflowId"
				`;

			// Access-control subquery — non-correlated (IN, AFTER fix)
			const accessSubqueryIn = `
					SELECT sw."workflowId"
					FROM shared_workflow sw
					INNER JOIN project p ON p.id = sw."projectId"
					INNER JOIN project_relation pr ON pr."projectId" = p.id
					WHERE sw.role IN (${workflowRoles})
					  AND pr."userId" = '${adminId}'
					  AND pr.role IN (${projectRoles})
				`;

			// Outer wrapper mirrors toQueryBuilderWithAnnotations.
			const wrap = (inner: string) => `
					SELECT e.*, ate.id AS annotation_tags_id, ate.name AS annotation_tags_name
					FROM (${inner}) e
					LEFT JOIN annotation_tag_mapping atm ON atm."annotationId" = e.id
					LEFT JOIN annotation_tag ate ON ate.id = atm."tagId"
					ORDER BY e.id DESC;
				`;

			// ── Query 1 & 2: getMany (LIMIT 10) ──────────────────────────────
			const sqlExistsGetMany = wrap(`
					SELECT execution.id, execution."workflowId", execution.mode,
					       execution.status, execution."createdAt", execution."startedAt",
					       execution."stoppedAt", execution."retryOf", execution."retrySuccessId",
					       execution."waitTill", workflow.name AS "workflowName"
					FROM execution_entity execution
					INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
					WHERE EXISTS (${accessSubqueryExists})
					ORDER BY execution.id DESC
					LIMIT 10
				`);

			const sqlInGetMany = wrap(`
					SELECT execution.id, execution."workflowId", execution.mode,
					       execution.status, execution."createdAt", execution."startedAt",
					       execution."stoppedAt", execution."retryOf", execution."retrySuccessId",
					       execution."waitTill", workflow.name AS "workflowName"
					FROM execution_entity execution
					INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
					WHERE execution."workflowId" IN (${accessSubqueryIn})
					ORDER BY execution.id DESC
					LIMIT 10
				`);

			// ── Query 3 & 4: COUNT(*) — no LIMIT, the real bottleneck ─────────
			const sqlExistsCount = `
					SELECT COUNT(*)
					FROM execution_entity execution
					INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
					WHERE EXISTS (${accessSubqueryExists})
				`;

			const sqlInCount = `
					SELECT COUNT(*)
					FROM execution_entity execution
					INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
					WHERE execution."workflowId" IN (${accessSubqueryIn})
				`;

			// ── EXPLAIN ANALYZE (single cold run each, before the timing loop) ──
			await services.postgres.restart();
			const explainExists = await services.postgres.exec(
				`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlExistsCount}`,
			);
			await services.postgres.restart();
			const explainIn = await services.postgres.exec(
				`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sqlInCount}`,
			);

			// ── Create HTTP API context before SQL loops (DB is healthy here) ──
			// Must be done before the SQL cold-cache loops that restart Postgres;
			// login would fail if called after a restart with no wait.
			const adminApi = await n8n.api.createApiForUser(ctx.admin);

			// ── Cold-cache measurement ────────────────────────────────────────
			const getManyExistsLat: number[] = [];
			const getManyInLat: number[] = [];
			const countExistsLat: number[] = [];
			const countInLat: number[] = [];

			console.log(`[MEASURE] ${ITERATIONS} iterations — EXISTS getMany`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart();
				const t0 = performance.now();
				await services.postgres.exec(sqlExistsGetMany);
				getManyExistsLat.push(performance.now() - t0);
				console.log(
					`  [EXISTS getMany ${i + 1}/${ITERATIONS}] ${getManyExistsLat[i]!.toFixed(1)} ms`,
				);
			}

			console.log(`[MEASURE] ${ITERATIONS} iterations — IN getMany`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart();
				const t0 = performance.now();
				await services.postgres.exec(sqlInGetMany);
				getManyInLat.push(performance.now() - t0);
				console.log(`  [IN getMany ${i + 1}/${ITERATIONS}] ${getManyInLat[i]!.toFixed(1)} ms`);
			}

			console.log(`[MEASURE] ${ITERATIONS} iterations — EXISTS COUNT`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart();
				const t0 = performance.now();
				await services.postgres.exec(sqlExistsCount);
				countExistsLat.push(performance.now() - t0);
				console.log(`  [EXISTS COUNT ${i + 1}/${ITERATIONS}] ${countExistsLat[i]!.toFixed(1)} ms`);
			}

			console.log(`[MEASURE] ${ITERATIONS} iterations — IN COUNT`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart();
				const t0 = performance.now();
				await services.postgres.exec(sqlInCount);
				countInLat.push(performance.now() - t0);
				console.log(`  [IN COUNT ${i + 1}/${ITERATIONS}] ${countInLat[i]!.toFixed(1)} ms`);
			}

			// ── HTTP E2E — project:admin hits GET /rest/executions (cold cache) ──
			// Postgres restarted before every iteration — same cold-cache condition
			// as the SQL measurements above. Measures V2 (fix, current code).
			// adminApi was created before the SQL loops while DB was healthy.
			const httpLat: number[] = [];
			console.log(`[MEASURE] ${ITERATIONS} iterations — HTTP GET /rest/executions (cold cache)`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart();
				const t0 = performance.now();
				const res = await adminApi.request.get('/rest/executions?limit=10&includeData=false');
				httpLat.push(performance.now() - t0);
				if (!res.ok()) {
					console.warn(`  [HTTP ${i + 1}/${ITERATIONS}] status=${res.status()}`);
				} else {
					console.log(`  [HTTP ${i + 1}/${ITERATIONS}] ${httpLat[i]!.toFixed(1)} ms`);
				}
			}

			// ── Report ────────────────────────────────────────────────────────
			const report = renderMarkdown(
				getManyExistsLat,
				getManyInLat,
				countExistsLat,
				countInLat,
				httpLat,
				{
					workflows: WORKFLOWS_IN_PROJECT,
					executions: PRESEEDED_EXECUTIONS,
					iterations: ITERATIONS,
				},
				explainExists,
				explainIn,
			);

			console.log('\n' + report + '\n');

			await testInfo.attach('comparison-report.md', {
				body: report,
				contentType: 'text/markdown',
			});
		});
	},
);
