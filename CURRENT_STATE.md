# Current State

This file is a practical handoff for resuming Morphy development without relying on prior chat history.

## What Morphy Is

Morphy is an experiment in metamorphic analytical systems: a stable web application shell whose domain-specific analysis surface can be reshaped by AI. The current implementation is a Node.js/Express server with a browser SPA frontend. The system is designed so that:

- domains are defined by config, and can also be generated from prompts
- datasource previews and deterministic local analysis run on the server
- the model is used primarily for planning, archetype selection, interpretation, scaffold generation, and some widget generation
- widgets can be generated, but interactive panels now prefer deterministic local widget templates

The main docs are:

- `README.md`
- `ARCHITECTURE.md`

## Current Architecture

### Server

Main server entry:

- `src/server.js`

Main subsystems:

- `src/services/agent-runtime.js`
- `src/services/data-sources.js`
- `src/services/analysis-tools.js`
- `src/services/widget-service.js`
- `src/services/refresh-coordinator.js`
- `src/services/config-store.js`
- `src/lib/archetypes.js`
- `src/lib/billing.js`
- `src/lib/logger.js`

### Browser

Main client files:

- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `public/runtime/widget-bridge.js`
- `public/runtime/logger.js`

### Persistence

Main persisted config/state locations:

- `config/app.config.json`
- `config/data-sources.json`
- `data/domains/*.json`
- `data/state/live-state.json`
- `data/state/runs/*.json`
- `data/state/workspace-plans.json`
- `data/state/widgets/index.json`
- `data/state/widget-bundles/`
- `data/state/billing-ledger.json`

Runtime artifacts are gitignored.

## Current Model / Tool Behavior

### Models

Current configured model:

- `gpt-5.4` for general agent work
- `gpt-5.4` for codegen/widget generation as well

### Deterministic local tooling

Morphy now has a stable local deterministic analysis substrate in:

- `src/services/analysis-tools.js`

It is recipe-driven rather than panel-hardcoded. Domains define `analysisRecipe`, and Morphy derives:

- deterministic summaries
- derived tool registries
- interaction contracts

### Model-directed tool invocation

This is implemented for:

- workspace planning
- archetype selection
- panel analysis
- widget generation
- domain generation

The model does not yet have an unrestricted tool loop. It can only choose from bounded derived tool registries backed by deterministic local execution.

Tool traces are persisted on plans/runs where applicable.

## Datasource Support

Current datasource types:

- `victoria-metrics`
- `json-file`
- `sql`
- legacy `relational` stub

### SQL support

The real SQL path is `type: "sql"`, with engine dispatch. Live engines implemented:

- `duckdb`
- `sqlite`

The SQL preview path returns:

- schema / tables
- columns
- row counts
- numeric field hints
- sample rows

Important files:

- `src/services/data-sources.js`
- `config/data-sources.json`

### Relational legacy stub

`type: "relational"` still exists only as a sample-row stub for backward compatibility. It is not a live DB connector.

## Domains

### HPCFund domain

Primary working example:

- `data/domains/hpcfund-cluster-observability.json`

This domain is semantically grounded in VictoriaMetrics cluster telemetry and currently includes:

- `fleet-health`
- `scheduler-pressure`
- `gpu-hotspots`
- `fabric-storage`
- `job-correlation`
- `job-explorer`
- `operator-brief`

The HPCFund domain now defines its own domain-scoped archetype library entry:

- `job-detail-sheet`

### Domain generation

Domain creation is now grounded in datasource contents rather than only prompt text:

- prompt -> model-directed datasource discovery tools -> grounded domain scaffold

Generated domains persist:

- `generationPrompt`
- `generationEvidenceSummary`
- `generationToolMode`
- `generationToolDecision`
- `generationToolTrace`

Important note:

- current refresh does not yet regenerate a domain from the original prompt
- `generationPrompt` is stored for provenance and future prompt-aware evolution

## Archetypes

Global/core archetype system is in:

- `src/lib/archetypes.js`

The runtime now supports:

- global/core archetypes
- app-config archetypes
- domain-local archetypes

Important recent change:

- `job-detail-sheet` was removed from the global shared archetype core
- it is now scoped to the HPCFund domain

This cleanup is not yet committed as of this handoff.

## Widgets

### Two widget modes now exist

1. Model-generated widget bundles
2. Deterministic local interactive widget bundles

Interactive panels now prefer deterministic local widget templates instead of model-generated widgets, because:

- they are much faster
- they are cheaper
- they are more stable for filter-driven interaction

### Widget bundle structure

Generated widgets still use the bundle pattern:

- `index.html`
- `styles.css`
- `widget.js`
- `manifest.json`

Widget payloads embed `window.__MORPHY_PAYLOAD__`.

### Interactive widgets

Interactive widgets now support:

- validated controls
- parameterized data refresh without widget regeneration
- optional model-backed reinterpretation of the filtered view

Current example:

- `Job Explorer`

Interactive browser/server path:

- widget calls `window.MorphyBridge.requestData(params)`
- widget may call `window.MorphyBridge.requestInterpretation(params)`
- host brokers those calls back to Morphy
- server returns filtered local results or a filtered reinterpretation

Important routes:

- `GET /api/panels/:domainId/:panelId/interaction`
- `POST /api/panels/:domainId/:panelId/interaction/data`
- `POST /api/panels/:domainId/:panelId/interaction/reinterpret`

Important files:

- `src/services/widget-service.js`
- `public/runtime/widget-bridge.js`
- `public/app.js`

### Current widget regeneration policy

Interactive panels should not regenerate widget code when users simply change filters. Regeneration should happen when the presentation structure changes, for example:

- archetype change
- interaction contract change
- scaffold evolution

### Important interactive widget fixes already made

- in-widget state persistence across host updates
- interaction lock to avoid replacing the active iframe while the user is interacting
- deterministic `Job Explorer` widget template
- serve-time rebuilding of local interactive widgets so renderer fixes apply on reload
- explicit `Apply Filters` and `Reinterpret` paths

## Billing / Spend Tracking

Spend tracking exists and is surfaced in the UI.

Important files:

- `src/lib/billing.js`
- `public/app.js`

The UI can show:

- total spend
- spend by token type
- spend by model
- spend by operation
- spend by panel
- spend by archetype
- current run spend

There is also a spend reset capability.

## Refresh / Scheduling

Current scheduler behavior from `config/app.config.json`:

- scheduler tick: `60s`
- source preview TTL: `60s`
- workspace plan TTL: `5m`
- analysis TTL: `5m`
- panels per sweep: `3`

This means Morphy checks all domains every minute, but does not rerun all panels every minute.

Important implication:

- lower-priority panels can lag if they are not chosen in the bounded sweep

Fairness improvements are still desirable.

## Logging / Diagnostics

Structured diagnostics exist on both server and browser sides.

Server:

- `src/lib/logger.js`

Browser:

- `public/runtime/logger.js`

They can be controlled via app config and URL/localStorage overrides.

## Known Good Outcomes

### Proven working

- model-directed tool use for planning, archetype selection, panel analysis, widget generation, and domain generation
- grounded domain generation against live datasource abstractions
- live DuckDB and SQLite previews
- deterministic interactive `Job Explorer`
- filtered reinterpretation via model call
- billing visibility in UI

### Create-only test results that were already run successfully

Transient create tests were run (not saved as domains) for:

1. FEC DuckDB domain
2. cluster-monitoring domain using the VictoriaMetrics source

These showed that create-time grounding can produce semantically meaningful domains from actual datasource contents.

## Important Current Uncommitted Changes

At the time this file was written, the worktree includes uncommitted cleanup around archetype scoping and generic-runtime de-HPC-ification, including:

- `config/app.config.json`
- `data/domains/hpcfund-cluster-observability.json`
- `public/app.js`
- `src/lib/archetypes.js`
- `src/services/agent-runtime.js`
- `src/services/analysis-tools.js`
- `src/services/widget-service.js`

Check `git status --short` before assuming the worktree is clean.

## Current Open Issues / Risks

### 1. Domain-scoped archetype cleanup is not fully validated yet

`job-detail-sheet` was removed from global config and moved to the HPCFund domain. This is the correct direction.

However, a degraded smoke test showed an important fallback issue:

- when VictoriaMetrics preview failed from this shell
- `job-explorer` fell back to heuristic archetype selection
- it chose `timeline-analysis` instead of the panel’s preferred `job-detail-sheet`

That means:

- domain-local archetype lookup works on the normal path
- but heuristic fallback still needs improvement

Recommended next fix:

- in fallback archetype selection, prefer the panel’s explicit `preferredArchetype` when it is allowed and defined in the domain-local library

### 2. Shell reachability to VictoriaMetrics / localhost is inconsistent

This Codex environment has repeatedly shown intermittent inability to reach:

- `127.0.0.1:9090`
- sometimes `127.0.0.1:3000`

That means:

- browser-based behavior may be fine
- direct shell smoke tests can still fail due to local reachability issues

### 3. Widget generation still dominates latency/cost for non-interactive panels

Interactive panels now avoid this by using deterministic widget templates, but non-interactive generated widgets are still the heaviest part of the pipeline.

### 4. Some generic runtime heuristics are cleaner than before, but the archetype vocabulary may still need further generalization

Current state is better than before:

- shared runtime no longer hardcodes as many HPC assumptions
- but the bounded archetype vocabulary is still influenced by operations/HPC use cases

## Most Immediate Next Recommended Step

If resuming development immediately, the most targeted next task is:

1. fix fallback archetype selection to respect domain-local `preferredArchetype`
2. rerun the HPCFund smoke test for:
   - `job-explorer`
   - `fleet-health`
3. commit the current cleanup batch once that passes

## Useful Smoke-Test Procedure

Good targeted checks:

1. Verify `job-detail-sheet` exists only in `data/domains/hpcfund-cluster-observability.json`
2. Force-run `job-explorer`
3. Confirm:
   - `selectedArchetype === "job-detail-sheet"`
   - widget completes
4. Force-run `fleet-health`
5. Confirm:
   - non-job archetype selection still works

When the localhost HTTP path is flaky from the shell, use direct runtime tests through:

- `ConfigStore`
- `AgentRuntime`
- `WidgetService`
- `BillingTracker`

instead of relying on curl.
