# Instance AI Eval Research Loop

Date: 2026-06-08

## Metric

Primary metric: `summary.passHatK` from `eval-results.json` with `eval:instance-ai --iterations 3`.

Secondary metrics:

- `summary.passAtK`
- `summary.passRatePerIter`
- number of scenarios with `passHatK < 1`
- number of scenarios with `passAtK < 1`
- failure categories/root causes for those scenarios

Target: match or approach the 2026-05-21 report result of `32/35` scenarios (`91%`) while preserving reliability across repeated runs.

## Protocol

1. Start from clean `master` plus the research-loop tooling.
2. Run a 3-iteration baseline with no migrated prompt/KB changes.
3. Add one hypothesis batch at a time.
4. Run the same 3-iteration eval after each batch.
5. Accept a batch only if it improves the primary metric or removes a failure cluster without creating a larger regression.
6. If a batch has mixed results, split it into smaller rules and retest.
7. Keep eval artifacts under `.data/research/<timestamp>-<label>/`.

## Runner

From `packages/@n8n/instance-ai`:

```bash
dotenvx run -f ../../../.env.local -- pnpm eval:research-loop \
  --label baseline-master \
  --hypothesis "Current master before migrated rule changes"
```

The runner disables LangSmith by default to avoid polluting shared experiments. Pass `--use-langsmith` only for runs intended to be tracked in LangSmith.

## Candidate Batches

Batch A: no-behavior tooling only

- Add this research-loop runner and protocol doc.
- Expected metric movement: none.

Batch B: planner contract shape

- Migrate structured `purpose` and checkpoint verification shape into the current skills/guidance surface.
- Hypothesis: improves requirement retention and verifier alignment.

Batch C: builder craft guardrails

- Migrate the active N001/N002/N007/N008/N009/N011/N012 rules into current runtime skills, knowledge base, and/or workflow-builder guidance.
- Hypothesis: improves data preservation, branch-local validation, empty/error distinction, and list handling.

Batch D: Code node source safety

- Migrate N010 into builder guidance for the current tool path, accounting for the current parser behavior.
- Hypothesis: reduces execution-time Code node syntax failures.

Batch E: runtime recovery

- Assess whether the current skills-migrated builder still needs the old "builder finished without submitting main workflow" recovery path.
- Hypothesis: only implement if current traces still show missing build outcomes.

## Runs

### Baseline: `baseline-worktree-current-master-projectid`

Path:
`packages/@n8n/instance-ai/.data/research/2026-06-08T14-05-58-108Z-baseline-worktree-current-master-projectid/`

Metric:

- `passHatK`: `44.4%`
- `passAtK`: `76.2%`
- per iteration: `62% / 52% / 57%`
- aggregate trials: `72/126 = 57.1%`
- builds: `19/19`

Top observed failure clusters:

- Source-data loss after side-effect nodes changed item shape.
- Independent side effects blocked by another action's failure.
- Empty or zero-item paths silently ended despite requested fallback behavior.
- Downstream logic depended on fields not fetched from external APIs.
- List responses under `data` or other arrays were not split into itemized records.
- Final required effect nodes were missing or disconnected.
- Code nodes used invalid item context such as an undeclared `item` variable.

### Treatment 1: `workflow-builder-guardrails-batch1`

Patch:
`packages/@n8n/instance-ai/skills/workflow-builder/SKILL.md`

Hypothesis:

Migrating the fork's highest-leverage workflow-construction rules to the current
workflow-builder skill will improve `passHatK` by reducing repeated data-flow,
branching, empty-state, list-shape, and field-completeness failures without
requiring planner/runtime changes.

Path:
`packages/@n8n/instance-ai/.data/research/2026-06-08T14-29-32-296Z-workflow-builder-guardrails-batch1/`

Metric:

- `passHatK`: `36.2%`
- `passAtK`: `66.7%`
- per iteration: `50% / 57% / 40%`
- aggregate trials: `62/126 = 49.2%`
- builds: `17/19`

Decision: reject as a batch and split. The broad guidance reduced build
reliability and lowered the primary metric, even though it improved several
data-preservation scenarios.

Improved scenario clusters:

- Contact form happy path and missing/empty field variants.
- Weather no-alert case where all readings still needed to be logged.
- One no-cross-team Linear report iteration.
- One workflow-metadata data-array handling iteration.

Regressed scenario clusters:

- Webhook audio workflow builds failed in all three iterations.
- Notion chat-agent workflow builds failed in all three iterations.
- Telegram chatbot sometimes configured an agent without a usable prompt.
- Slack digest workflows used Code for LLM calls or mishandled aggregated
  `data` arrays.
- PDF and simple per-item workflows used more Code nodes than needed.

### Treatment 2: `workflow-builder-surgical-dataflow-batch2`

Patch:
`packages/@n8n/instance-ai/skills/workflow-builder/SKILL.md`

Hypothesis:

Keep only the empirically supported pieces from Treatment 1 and make them more
specific: source-item preservation as graph topology, branch-local gating,
resource-locator value preservation, field-complete fetches, safe HTTP JSON
bodies, and Code-node constraints that discourage Code for simple node-native
work. This should preserve the Treatment 1 wins while reducing build and
craftsmanship regressions.

Path:
`packages/@n8n/instance-ai/.data/research/2026-06-08T14-52-23-846Z-workflow-builder-surgical-dataflow-batch2/`

Metric:

- `passHatK`: `51.0%`
- `passAtK`: `78.6%`
- per iteration: `69% / 62% / 60%`
- aggregate trials: `80/126 = 63.5%`
- builds: `19/19`

Decision: accept as a net improvement over baseline. It improves the primary
metric by `+6.6pp`, `passAtK` by `+2.4pp`, and aggregate trial pass rate by
`+6.4pp`, while recovering build reliability.

Improved scenario clusters versus baseline:

- Slack digest happy path, empty-channel, and high-volume scenarios.
- Telegram chatbot dynamic prompt wiring.
- Linear cross-team happy path, multi-team creator, and unknown creator.
- Notion chat-agent build recovery.
- Lead capture happy path.
- PDF download stability.

Regressed or still fragile clusters:

- Contact form fan-out sometimes used invented Webhook output ports.
- Slack file upload sometimes used a binary object expression instead of the
  binary property key.
- Empty-result branches still often relied on zero-item termination.
- Erroring independent branches still lacked concrete `onError` wiring.
- API digest still posted per item instead of one count+titles summary.
- Rain warning and weather alert workflows still missed final action wiring.
- Workflow metadata still failed on Data Table schema/upsert and nested `data`
  array handling.

### Treatment 3: `workflow-builder-fanout-error-empty-batch3`

Patch:
`packages/@n8n/instance-ai/skills/workflow-builder/SKILL.md`

Hypothesis:

Clarify the ambiguities exposed by Treatment 2 without adding broad new
behavior: single-output fan-out uses multiple `.add(source.to(...))`
connections, binary file parameters take literal property names, webhook payload
fields must match the payload exactly, no-results logic must be reachable before
zero-item collapse, Data Table upserts require a created/known schema, and
fragile independent actions need explicit `onError` wiring. This should preserve
Treatment 2's gains while recovering the avoidable fan-out/config regressions.

Path:
`packages/@n8n/instance-ai/.data/research/2026-06-08T15-16-24-540Z-workflow-builder-fanout-error-empty-batch3/`

Metric:

- `passHatK`: `38.1%`
- `passAtK`: `73.8%`
- per iteration: `50% / 52% / 55%`
- aggregate trials: `66/126 = 52.4%`
- builds: `18/19`

Decision: reject as a batch. It improved a few no-results and rain-warning
cases, but caused larger regressions in build reliability and previously stable
workflow families.

Major regressions versus Treatment 2:

- PDF download: `3/3 -> 0/3`
- Linear cross-team happy path: `3/3 -> 0/3`
- Slack digest high-volume: `3/3 -> 1/3`
- Telegram chatbot: `3/3 -> 2/3`

Observed reason:

The batch mixed safe factual clarifications with too much speculative graph
shape guidance. The broad independent-effect and error-output wording pushed
the builder toward unsupported or poorly configured error branches in some
workflows.

### Treatment 4: `workflow-builder-surgical-cleanup-batch4`

Patch:
`packages/@n8n/instance-ai/skills/workflow-builder/SKILL.md`

Hypothesis:

Keep Treatment 2 plus only low-risk factual clarifications from Treatment 3:
literal binary properties, exact webhook fields, reachable no-results logic,
Data Table schema before upsert, and single-output fan-out. Remove the broad
error-output example.

Path:
`packages/@n8n/instance-ai/.data/research/2026-06-08T15-39-28-539Z-workflow-builder-surgical-cleanup-batch4/`

Metric:

- `passHatK`: `49.6%`
- `passAtK`: `73.8%`
- per iteration: `57% / 62% / 62%`
- aggregate trials: `76/126 = 60.3%`
- builds: `19/19`

Decision: reject against Treatment 2. It recovered build reliability but still
lowered the primary metric and `passAtK`.

Useful retained observations:

- Factual node-config reminders improved binary upload, Notion agent, API
  happy path, and some weather/rain cases.
- Linear, Slack high-volume, and Telegram chatbot remained fragile.
- The recurring root causes were now concrete: missing final action nodes,
  source-item shape loss after side effects, aggregate wrappers under `data`,
  and independent branches stopping after one branch failure.

### Treatment 5: `workflow-builder-source-retention-batch5`

Patch:

- `packages/@n8n/instance-ai/skills/workflow-builder/SKILL.md`
- `packages/@n8n/instance-ai/skills/planning/SKILL.md`

Hypothesis:

Port the old fork's structured planner requirement-retention contract into the
current planning skill, and add targeted builder rules for ranking/sorted-count
workflows, environment-free node expressions, exact node-name references, and
post-agent source references for reply nodes. This should recover several
high-value cases without reintroducing the broad Treatment 3 regressions.

Path:
`packages/@n8n/instance-ai/.data/research/2026-06-08T16-02-06-368Z-workflow-builder-source-retention-batch5/`

Metric:

- `passHatK`: `55.7%`
- `passAtK`: `83.3%`
- per iteration: `71% / 64% / 69%`
- aggregate trials: `86/126 = 68.3%`
- builds: `19/19`

Decision: accept as the current best treatment. It improves over baseline by
`+11.3pp` primary metric, `+7.1pp` passAtK, and `+11.2pp` aggregate pass rate.
It also improves over Treatment 2 by `+4.7pp` primary metric, `+4.8pp` passAtK,
and `+4.8pp` aggregate pass rate.

Largest improvements versus Treatment 2:

- n8n workflow metadata Data Table sync: `0/3 -> 3/3`
- API-to-Slack happy path: `1/3 -> 3/3`
- rain warning happy path: `0/3 -> 2/3`
- contact-form invalid email: `0/3 -> 2/3`
- Notion chat agent, Slack binary upload, Airtable-to-Slack, notification
  high-priority, weather no-alerts, and GitHub-to-Notion each gained one pass.

Largest regressions versus Treatment 2:

- Linear cross-team happy path: `3/3 -> 0/3`
- Linear multi-team creator: `3/3 -> 0/3`
- Slack digest high-volume: `3/3 -> 1/3`
- engagement-ranking happy path: `1/3 -> 0/3`
- Telegram chatbot distinct chat: `3/3 -> 2/3`

Why accept despite regressions:

The primary metric and passAtK both moved materially upward, all builds
succeeded, and the regressions are now concentrated in a smaller number of
well-described mechanics that should be addressed with validators or repair
logic rather than broader skill text.

## Old Fork Porting Accounting

Fork ref inspected:
`refs/remotes/oleg/tevfik-instance-ai-review` at
`3ed02e39fbc66e0f9e2c96fbe15fb080764fb102`.

Associated local report:
`/Users/albertalises/Downloads/workflow-eval-2026-05-21T16-04-56 (4).html`
reported `32/35` scenarios passing (`91%`).

Important comparability caveat:

The current suite is not the same measurement. It has `42` scenarios and this
research loop scores three iterations per scenario (`126` total trials). The
primary metric here is strict reliability across repeated runs (`passHatK`),
not the old single-report pass rate.

Ported into the current skills/guidance architecture:

- Structured planner requirement retention into
  `skills/planning/SKILL.md`: outcome, trigger mode, external systems,
  required effects, required branches, required data, explicit constraints,
  empty/invalid behavior, and done-when checks.
- Concrete resource/value preservation into workflow-builder guidance.
- Source-data preservation, branch-local gating, empty/error distinction,
  field-complete fetches, list itemization, aggregate wrapper handling, and
  no-Code-for-simple-node-native-work rules into
  `skills/workflow-builder/SKILL.md`.
- Code node safety rules for `$input.all()`, no undeclared `item`, no
  unavailable modules, no raw LLM API calls from Code, and no `String.raw`.
- Node config safety for binary property names, webhook payload field names,
  HTTP JSON bodies, Google Sheets schema mapping, no `$env` in node
  expressions, MCP registry tool usage, exact node-name references, and
  post-agent reply source references.
- Ranking/leaderboard guidance for one row per entity and sorting by the
  requested score/count.

Not ported:

- Old report UI, trace viewer, sandbox/workspace refactors, and eval-reporting
  changes. They do not directly affect the builder success metric.
- Old prompt files and workflow-loop code paths that no longer match the
  current skills/KB migration architecture.
- The old Code-node JavaScript syntax validator. The current failing clusters
  are mostly graph topology, schema, data-shape, and merge semantics rather
  than JavaScript parse errors, so this was left as a lower-priority follow-up.

## Current Blockers To 91%

Skills-only migration improved the strict repeated-run metric from `44.4%` to
`55.7%`, but did not reproduce the old `91%` report. The evidence points to
mechanical builder/validator gaps rather than missing prose.

Most important remaining blocker clusters:

- Independent side-effect isolation: one failing Telegram, Slack, Sheets, or
  Data Table branch can still fail the whole workflow and skip unrelated
  required effects.
- Source-item shape after side effects: conditions often read the original API
  shape after Airtable/Sheets/Data Table nodes have replaced the item shape.
- Aggregate wrapper handling: builders aggregate into `{ data: [...] }` and
  downstream Code/Set nodes still read top-level fields or `$json.map(...)`.
- Join/merge semantics: engagement ranking used cartesian merge or missed one
  input entirely instead of joining Linear and BigQuery data by user.
- Schema contracts: Google Sheets and Data Table nodes still invent or omit
  required column schemas, producing hard runtime failures.
- Empty-result handling: workflows often rely on zero-item termination instead
  of an intentional fallback/no-op or empty summary path.
- Exact expression references: one Telegram memory node still used
  `$('telegramTrigger')` instead of the displayed node name
  `$('Telegram Trigger')`.
- Final effect omission: rain/weather workflows sometimes identify the matching
  branch but omit the email/Telegram node or leave the branch terminal.

Evaluator/mock noise also limits interpretability:

- Gmail action-items scenarios repeatedly failed as `mock_issue` because the
  mocked Gmail response shape did not match the real node's expected paginated
  message/detail flow.
- GitHub-to-Notion sometimes failed because repeated Notion mock responses made
  distinct created pages indistinguishable.
- Occasional `fetch failed` errors appeared in otherwise unrelated scenarios.

Recommended next engineering steps:

- Add builder validation or repair for Aggregate -> Code/Set shape mismatches:
  if a node uses `aggregateAllItemData`, downstream code must read
  `$json.data` or avoid the Aggregate node.
- Add validation for exact `$('<node name>')` references before execution and
  route failures back through repair.
- Add a reusable pattern or validator for independent side effects that need
  branch-local error isolation.
- Add schema-aware checks for Google Sheets and Data Table mappings before
  submitting a workflow.
- Add merge/join guidance with validation for multi-source ranking/reporting
  workflows, especially "join by user/name/id" versus cartesian `combineAll`.
