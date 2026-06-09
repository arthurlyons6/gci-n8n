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

function calcStats(latencies: number[]) {
	const sorted = [...latencies].sort((a, b) => a - b);
	const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
	return {
		avg,
		p50: sorted[Math.floor(sorted.length * 0.5)]!,
		p95: sorted[Math.floor(sorted.length * 0.95)]!,
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
	};
}

function fmt(n: number) {
	return n.toFixed(1) + ' ms';
}

function summaryTable(
	existsS: ReturnType<typeof calcStats>,
	inS: ReturnType<typeof calcStats>,
): string {
	const delta = (e: number, i: number) =>
		e > 0 ? `**${((1 - i / e) * 100).toFixed(0)}% faster**` : '—';
	return `| Metric | EXISTS (before) | IN (after) | Δ |
|--------|----------------|------------|---|
| avg    | ${fmt(existsS.avg)} | ${fmt(inS.avg)} | ${delta(existsS.avg, inS.avg)} |
| p50    | ${fmt(existsS.p50)} | ${fmt(inS.p50)} | ${delta(existsS.p50, inS.p50)} |
| p95    | ${fmt(existsS.p95)} | ${fmt(inS.p95)} | ${delta(existsS.p95, inS.p95)} |
| max    | ${fmt(existsS.max)} | ${fmt(inS.max)} | ${delta(existsS.max, inS.max)} |`;
}

function perIterationTable(existsLatencies: number[], inLatencies: number[]): string {
	return existsLatencies
		.map((e, i) => `| ${i + 1} | ${e.toFixed(1)} ms | ${inLatencies[i]!.toFixed(1)} ms |`)
		.join('\n');
}

function renderMarkdown(
	getManyExists: number[],
	getManyIn: number[],
	countExists: number[],
	countIn: number[],
	setup: { workflows: number; executions: number; iterations: number },
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
		test(`EXISTS vs IN | ${ITERATIONS} cold-cache iterations | ${WORKFLOWS_IN_PROJECT} wf | ${PRESEEDED_EXECUTIONS.toLocaleString()} execs | getMany + COUNT`, async ({
			services,
			n8n,
		}, testInfo) => {
			// 4 × 50 iterations × ~10 s per restart + ~5 min seeding ≈ 40 min total.
			testInfo.setTimeout(90 * 60 * 1000);

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

			// ── Report ────────────────────────────────────────────────────────
			const report = renderMarkdown(getManyExistsLat, getManyInLat, countExistsLat, countInLat, {
				workflows: WORKFLOWS_IN_PROJECT,
				executions: PRESEEDED_EXECUTIONS,
				iterations: ITERATIONS,
			});

			console.log('\n' + report + '\n');

			await testInfo.attach('comparison-report.md', {
				body: report,
				contentType: 'text/markdown',
			});
		});
	},
);
