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

function stats(latencies: number[]) {
	const sorted = [...latencies].sort((a, b) => a - b);
	const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
	const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
	const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
	const min = sorted[0]!;
	const max = sorted[sorted.length - 1]!;
	return { avg, p50, p95, min, max };
}

function fmt(n: number) {
	return n.toFixed(1) + ' ms';
}

function renderMarkdown(
	existsStats: ReturnType<typeof stats>,
	inStats: ReturnType<typeof stats>,
	existsLatencies: number[],
	inLatencies: number[],
	setup: { workflows: number; executions: number; iterations: number },
): string {
	const avgImprovement = ((existsStats.avg - inStats.avg) / existsStats.avg) * 100;
	const p95improvement = ((existsStats.p95 - inStats.p95) / existsStats.p95) * 100;
	const maxImprovement = ((existsStats.max - inStats.max) / existsStats.max) * 100;

	const rows = Array.from({ length: setup.iterations }, (_, i) => {
		const e = existsLatencies[i]!.toFixed(1);
		const n = inLatencies[i]!.toFixed(1);
		return `| ${i + 1} | ${e} ms | ${n} ms |`;
	}).join('\n');

	return `
## Benchmark: \`executions getMany\` — EXISTS vs IN (cold cache, ${setup.iterations} iterations)

**Setup:** ${setup.workflows} workflows · ${setup.executions.toLocaleString()} executions · project:admin scope · **global view (no projectId filter)**
**Method:** Postgres container restarted before every iteration — flushes shared_buffers completely (Linux CI only, reproduces cold first-open latency)

### Summary

| Metric | EXISTS (before) | IN (after) | Δ |
|--------|----------------|------------|---|
| avg    | ${fmt(existsStats.avg)} | ${fmt(inStats.avg)} | **${avgImprovement.toFixed(0)}% faster** |
| p50    | ${fmt(existsStats.p50)} | ${fmt(inStats.p50)} | ${(((existsStats.p50 - inStats.p50) / existsStats.p50) * 100).toFixed(0)}% faster |
| p95    | ${fmt(existsStats.p95)} | ${fmt(inStats.p95)} | **${p95improvement.toFixed(0)}% faster** |
| max    | ${fmt(existsStats.max)} | ${fmt(inStats.max)} | **${maxImprovement.toFixed(0)}% faster** |

### Per-iteration latencies (cold cache)

| # | EXISTS | IN |
|---|--------|----|
${rows}

### Fix

\`packages/@n8n/db/src/repositories/execution.repository.ts\`

\`\`\`diff
- // Correlated subquery — Postgres re-evaluates for every row in execution_entity
- subquery.andWhere('"sw"."workflowId" = execution."workflowId"');
- qb.where(\`EXISTS (\${subquery.getQuery()})\`);
+ // Non-correlated IN subquery — Postgres computes accessible workflow IDs once
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
		test(`EXISTS vs IN | ${ITERATIONS} cold-cache iterations each | ${WORKFLOWS_IN_PROJECT} wf | ${PRESEEDED_EXECUTIONS.toLocaleString()} execs | global view`, async ({
			services,
			n8n,
		}, testInfo) => {
			// 50 iterations × ~10 s per Postgres restart + ~5 min seeding ≈ 15-20 min total.
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

			// Resolve admin user ID needed in the WHERE clause
			const adminIdRaw = await services.postgres.exec(
				`SELECT id FROM "user" WHERE email = '${ctx.admin.email}' LIMIT 1;`,
			);
			const adminId = adminIdRaw.trim();

			// ── SQL variants ─────────────────────────────────────────────────
			const workflowRoles = `'workflow:owner','workflow:editor'`;
			const projectRoles = `'project:admin','project:editor','project:viewer'`;

			// ── SQL variants ─────────────────────────────────────────────────────
			// Both variants mirror toQueryBuilder() for a project:admin user on
			// the GLOBAL executions view (no projectId filter in the outer query).
			//
			// The global view is the worst case: EXISTS must evaluate once per row
			// across ALL 1 M execution_entity rows. projectId-scoped views are
			// faster because Postgres can use the projectId index first.
			//
			// Roles mirror isSharingEnabled() === true (the path taken when the
			// enterprise sharing feature is licensed — as at CrowdStrike).

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

			// Outer wrapper mirrors toQueryBuilderWithAnnotations (annotation left-joins).
			const wrap = (inner: string) => `
					SELECT e.*, ate.id AS annotation_tags_id, ate.name AS annotation_tags_name
					FROM (${inner}) e
					LEFT JOIN annotation_tag_mapping atm ON atm."annotationId" = e.id
					LEFT JOIN annotation_tag ate ON ate.id = atm."tagId"
					ORDER BY e.id DESC;
				`;

			// No projectId filter — global executions view, the worst case.
			const innerExists = `
					SELECT execution.id, execution."workflowId", execution.mode,
					       execution.status, execution."createdAt", execution."startedAt",
					       execution."stoppedAt", execution."retryOf", execution."retrySuccessId",
					       execution."waitTill", workflow.name AS "workflowName"
					FROM execution_entity execution
					INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
					WHERE EXISTS (${accessSubqueryExists})
					ORDER BY execution.id DESC
					LIMIT 10
				`;

			const innerIn = `
					SELECT execution.id, execution."workflowId", execution.mode,
					       execution.status, execution."createdAt", execution."startedAt",
					       execution."stoppedAt", execution."retryOf", execution."retrySuccessId",
					       execution."waitTill", workflow.name AS "workflowName"
					FROM execution_entity execution
					INNER JOIN workflow_entity workflow ON workflow.id = execution."workflowId"
					WHERE execution."workflowId" IN (${accessSubqueryIn})
					ORDER BY execution.id DESC
					LIMIT 10
				`;

			const sqlExists = wrap(innerExists);
			const sqlIn = wrap(innerIn);

			// ── Cold-cache measurement ────────────────────────────────────────
			const existsLatencies: number[] = [];
			const inLatencies: number[] = [];

			console.log(`[MEASURE] ${ITERATIONS} cold-cache iterations — EXISTS variant`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart(); // flush shared_buffers
				const t0 = performance.now();
				await services.postgres.exec(sqlExists);
				existsLatencies.push(performance.now() - t0);
				console.log(`  [EXISTS ${i + 1}/${ITERATIONS}] ${existsLatencies[i]!.toFixed(1)} ms`);
			}

			console.log(`[MEASURE] ${ITERATIONS} cold-cache iterations — IN variant`);
			for (let i = 0; i < ITERATIONS; i++) {
				await services.postgres.restart(); // flush shared_buffers
				const t0 = performance.now();
				await services.postgres.exec(sqlIn);
				inLatencies.push(performance.now() - t0);
				console.log(`  [IN ${i + 1}/${ITERATIONS}] ${inLatencies[i]!.toFixed(1)} ms`);
			}

			// ── Report ───────────────────────────────────────────────────────
			const existsS = stats(existsLatencies);
			const inS = stats(inLatencies);

			const report = renderMarkdown(existsS, inS, existsLatencies, inLatencies, {
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
