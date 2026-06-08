#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type StringArgKey =
	| 'baseUrl'
	| 'concurrency'
	| 'exclude'
	| 'experimentName'
	| 'filter'
	| 'hypothesis'
	| 'label'
	| 'notes'
	| 'outputRoot'
	| 'tier'
	| 'timeoutMs';

type CliArgs = Partial<Record<StringArgKey, string>> & {
	iterations?: number;
	passthrough: string[];
	useLangsmith?: boolean;
};

type EvalRun = {
	failureCategory?: string;
	rootCause?: string;
};

type EvalScenario = {
	name: string;
	passAtK: number;
	passCount: number;
	passHatK: number;
	runs?: EvalRun[];
	totalRuns: number;
};

type EvalTestCase = {
	name: string;
	scenarios?: EvalScenario[];
};

type EvalSummary = {
	built?: number;
	passAtK?: number;
	passHatK?: number;
	passRatePerIter?: string;
	testCases?: number;
};

type EvalReport = {
	durationMs?: number;
	summary?: EvalSummary;
	testCases?: EvalTestCase[];
	totalRuns?: number;
};

type ScenarioRow = {
	failureCategories: string[];
	passAtK: number;
	passCount: number;
	passHatK: number;
	rootCauses: string[];
	scenario: string;
	testCase: string;
	totalRuns: number;
};

type ResearchSummary =
	| {
			durationMs?: number;
			impossibleScenarioCount: number;
			impossibleScenarios: ScenarioRow[];
			summary?: EvalSummary;
			totalRuns?: number;
			unreliableScenarioCount: number;
			unreliableScenarios: ScenarioRow[];
	  }
	| {
			error: string;
	  };

const scriptDir = dirname(resolve(process.argv[1] ?? 'evaluations/research-loop.ts'));
const packageRoot = resolve(scriptDir, '..');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
	cwd: packageRoot,
	encoding: 'utf8',
}).trim();

const args = parseArgs(process.argv.slice(2));
const label = sanitizeLabel(args.label ?? `run-${new Date().toISOString()}`);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputRoot = resolve(packageRoot, args.outputRoot ?? '.data/research');
const runDir = join(outputRoot, `${timestamp}-${label}`);
mkdirSync(runDir, { recursive: true });

const evalArgs = [
	'eval:instance-ai',
	'--iterations',
	String(args.iterations ?? 3),
	'--output-dir',
	runDir,
	'--experiment-name',
	args.experimentName ?? `research-${label}`,
	...flagArg('--filter', args.filter),
	...flagArg('--exclude', args.exclude),
	...flagArg('--tier', args.tier),
	...flagArg('--concurrency', args.concurrency),
	...flagArg('--timeout-ms', args.timeoutMs),
	...flagArg('--base-url', args.baseUrl),
	...args.passthrough,
];

const startedAt = new Date().toISOString();
const metadata = {
	command: ['pnpm', ...evalArgs],
	git: gitMetadata(),
	hypothesis: args.hypothesis ?? null,
	label,
	langsmith: args.useLangsmith ? 'enabled' : 'disabled',
	metric: {
		primary: 'summary.passHatK',
		secondary: ['summary.passAtK', 'summary.passRatePerIter', 'scenario pass counts'],
		target: 'Match or approach 0.91 on the 35-scenario full suite while improving reliability.',
	},
	notes: args.notes ?? null,
	startedAt,
};
writeFileSync(join(runDir, 'research-input.json'), `${JSON.stringify(metadata, null, 2)}\n`);

const env = { ...process.env };
if (!args.useLangsmith) {
	env.LANGSMITH_API_KEY = '';
}

const result = spawnSync('pnpm', evalArgs, {
	cwd: packageRoot,
	env,
	stdio: 'inherit',
});

const finishedAt = new Date().toISOString();
const evalResultsPath = join(runDir, 'eval-results.json');
const summary = existsSync(evalResultsPath)
	? summarizeEvalResults(readEvalReport(evalResultsPath))
	: { error: 'eval-results.json was not written' };

const reportPath = latestWorkflowReportPath();
if (reportPath) {
	copyFileSync(reportPath, join(runDir, 'workflow-eval-report.html'));
}

const researchRun = {
	...metadata,
	artifacts: {
		evalResults: existsSync(evalResultsPath) ? evalResultsPath : null,
		htmlReport: reportPath ? join(runDir, 'workflow-eval-report.html') : null,
		prComment: existsSync(join(runDir, 'eval-pr-comment.md'))
			? join(runDir, 'eval-pr-comment.md')
			: null,
		runDir,
	},
	exitCode: result.status,
	finishedAt,
	signal: result.signal,
	summary,
};

writeFileSync(join(runDir, 'research-run.json'), `${JSON.stringify(researchRun, null, 2)}\n`);
printSummary(researchRun);

process.exit(result.status ?? 1);

function parseArgs(argv: string[]): CliArgs {
	const parsed: CliArgs = { passthrough: [] };
	const valueOptions: Record<string, StringArgKey | 'iterations'> = {
		'--base-url': 'baseUrl',
		'--concurrency': 'concurrency',
		'--exclude': 'exclude',
		'--experiment-name': 'experimentName',
		'--filter': 'filter',
		'--hypothesis': 'hypothesis',
		'--iterations': 'iterations',
		'--label': 'label',
		'--notes': 'notes',
		'--output-root': 'outputRoot',
		'--tier': 'tier',
		'--timeout-ms': 'timeoutMs',
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--') {
			parsed.passthrough.push(...argv.slice(i + 1));
			break;
		}
		if (arg === '--use-langsmith') {
			parsed.useLangsmith = true;
			continue;
		}
		const key = valueOptions[arg];
		if (!key) {
			parsed.passthrough.push(arg);
			continue;
		}
		const value = argv[i + 1];
		if (!value || value.startsWith('--')) {
			throw new Error(`${arg} requires a value`);
		}
		if (key === 'iterations') {
			parsed.iterations = Number(value);
		} else {
			parsed[key] = value;
		}
		i++;
	}
	return parsed;
}

function flagArg(flag: string, value: string | undefined) {
	return value === undefined || value === '' ? [] : [flag, value];
}

function sanitizeLabel(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function git(gitArgs: string[]) {
	return execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8' });
}

function gitMetadata() {
	return {
		branch: safeGit(['branch', '--show-current']).trim(),
		changedFiles: unique([
			...safeGit(['diff', '--name-only']).trim().split('\n').filter(Boolean),
			...safeGit(['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean),
		]),
		sha: safeGit(['rev-parse', 'HEAD']).trim(),
		status: safeGit(['status', '--short']).trim().split('\n').filter(Boolean),
	};
}

function safeGit(gitArgs: string[]) {
	try {
		return git(gitArgs);
	} catch {
		return '';
	}
}

function unique<T>(values: T[]) {
	return [...new Set(values)];
}

function summarizeEvalResults(report: EvalReport): ResearchSummary {
	const unreliableScenarios: ScenarioRow[] = [];
	const impossibleScenarios: ScenarioRow[] = [];
	for (const testCase of report.testCases ?? []) {
		for (const scenario of testCase.scenarios ?? []) {
			const row = {
				failureCategories: unique(
					(scenario.runs ?? []).flatMap((run) =>
						run.failureCategory ? [run.failureCategory] : [],
					),
				),
				passAtK: scenario.passAtK,
				passCount: scenario.passCount,
				passHatK: scenario.passHatK,
				rootCauses: unique(
					(scenario.runs ?? []).flatMap((run) => (run.rootCause ? [run.rootCause] : [])),
				),
				scenario: scenario.name,
				testCase: testCase.name,
				totalRuns: scenario.totalRuns,
			};
			if (scenario.passHatK < 1) unreliableScenarios.push(row);
			if (scenario.passAtK < 1) impossibleScenarios.push(row);
		}
	}
	return {
		durationMs: report.durationMs,
		impossibleScenarioCount: impossibleScenarios.length,
		impossibleScenarios,
		summary: report.summary,
		totalRuns: report.totalRuns,
		unreliableScenarioCount: unreliableScenarios.length,
		unreliableScenarios,
	};
}

function readEvalReport(path: string): EvalReport {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	return {
		durationMs: readNumber(parsed.duration),
		summary: readSummary(parsed.summary),
		testCases: Array.isArray(parsed.testCases)
			? parsed.testCases.flatMap((testCase) => readTestCase(testCase))
			: [],
		totalRuns: readNumber(parsed.totalRuns),
	};
}

function readSummary(value: unknown): EvalSummary | undefined {
	if (!isRecord(value)) return undefined;
	return {
		built: readNumber(value.built),
		passAtK: readNumber(value.passAtK),
		passHatK: readNumber(value.passHatK),
		passRatePerIter: readString(value.passRatePerIter),
		testCases: readNumber(value.testCases),
	};
}

function readTestCase(value: unknown): EvalTestCase[] {
	if (!isRecord(value)) return [];
	const name = readString(value.name);
	if (!name) return [];
	return [
		{
			name,
			scenarios: Array.isArray(value.scenarios)
				? value.scenarios.flatMap((scenario) => readScenario(scenario))
				: [],
		},
	];
}

function readScenario(value: unknown): EvalScenario[] {
	if (!isRecord(value)) return [];
	const name = readString(value.name);
	const passAtK = readNumber(value.passAtK);
	const passCount = readNumber(value.passCount);
	const passHatK = readNumber(value.passHatK);
	const totalRuns = readNumber(value.totalRuns);
	if (!name || passAtK === undefined || passCount === undefined || passHatK === undefined) {
		return [];
	}
	return [
		{
			name,
			passAtK,
			passCount,
			passHatK,
			runs: Array.isArray(value.runs) ? value.runs.flatMap((run) => readRun(run)) : [],
			totalRuns: totalRuns ?? 0,
		},
	];
}

function readRun(value: unknown): EvalRun[] {
	if (!isRecord(value)) return [];
	return [
		{
			failureCategory: readString(value.failureCategory),
			rootCause: readString(value.rootCause),
		},
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown) {
	return typeof value === 'number' ? value : undefined;
}

function readString(value: unknown) {
	return typeof value === 'string' ? value : undefined;
}

function latestWorkflowReportPath() {
	const reportDir = join(packageRoot, '.data');
	if (!existsSync(reportDir)) return null;
	const reports = readdirSync(reportDir)
		.filter((name) => /^workflow-eval-.*\.html$/.test(name))
		.map((name) => join(reportDir, name))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return reports[0] ?? null;
}

function printSummary(researchRun: { artifacts: { runDir: string }; summary: ResearchSummary }) {
	console.log('\nResearch run written to:', researchRun.artifacts.runDir);
	if ('error' in researchRun.summary) {
		console.log('No eval summary was produced.');
		return;
	}
	const { summary } = researchRun.summary;
	if (!summary) {
		console.log('No eval summary was produced.');
		return;
	}
	console.log(
		[
			`pass^k=${formatPct(summary.passHatK)}`,
			`pass@k=${formatPct(summary.passAtK)}`,
			`perIter=${summary.passRatePerIter}`,
			`built=${summary.built}/${summary.testCases}`,
			`unreliable=${researchRun.summary.unreliableScenarioCount}`,
			`impossible=${researchRun.summary.impossibleScenarioCount}`,
		].join(' | '),
	);
}

function formatPct(value: number | undefined) {
	return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : 'n/a';
}
