# Morphy

Morphy is a config-driven analytical web application for projecting domain-specific operator workspaces over heterogeneous data sources. The goal is to keep a stable host application while allowing an embedded server-side agent to analyze data, adapt the workspace within bounded limits, and generate browser-executable visualization artifacts for individual panels.

The current prototype is built with Node.js and Express and is centered on a shared server-side runtime rather than per-browser ad hoc analysis. That makes it suitable for monitoring and analysis domains where multiple users should see the same current operational picture without duplicating expensive model calls.

## What Morphy Is Trying To Do

Morphy is designed around a few core ideas:

- One web app can support many analytical domains.
- Domain identity and baseline scaffolding come from config files.
- The server-side agent decides what is analytically relevant right now.
- The browser UI can adapt within bounded rules without becoming unstable.
- Generated visual artifacts can run in the browser, but only inside a controlled host runtime.

In practice, that means Morphy can be aimed at:

- cluster observability
- GPU fleet operations
- scheduler and capacity monitoring
- warehouse or logistics KPI analysis
- other data-heavy domains that need a mix of fixed structure and adaptive analysis

## Current Example Domain

The main concrete example in this repo is `hpcfund-cluster-observability`, backed by a historical March 2026 VictoriaMetrics dataset for a GPU cluster.

That dataset includes signals such as:

- Slurm queue and partition state
- ROCm GPU telemetry
- host metrics
- InfiniBand counters
- SMART/storage health
- job and workload correlation signals

The domain scaffolding for that dataset lives in [data/domains/hpcfund-cluster-observability.json](data/domains/hpcfund-cluster-observability.json).

## Architecture

### Stable Host Shell

The host application owns:

- routing and page structure
- datasource configuration
- domain registry
- refresh scheduling
- privileged server-side access to databases and APIs
- safe embedding of generated browser widgets

The outer shell is intentionally stable. Morphy does not allow arbitrary model-driven mutation of the whole application UI.

### Domain Scaffolding

Domain scaffolding is pre-generated or authored in JSON config. A domain defines:

- domain metadata
- which data sources it depends on
- its baseline panel list
- per-panel analysis prompts
- preferred chart types

This scaffolding gives the UI a dependable starting shape even before any analysis has run.

### Server-Side Agent Runtime

The server runtime in [src/services/agent-runtime.js](src/services/agent-runtime.js) is responsible for:

- gathering datasource preview context
- planning the workspace
- running per-panel analyses
- persisting analysis state
- optionally delegating widget generation

If `OPENAI_API_KEY` is present, Morphy uses OpenAI through the Node SDK. If no key is present, it falls back to local synthesized output so the app remains explorable.

### Shared Refresh Model

Morphy no longer assumes that every browser should kick off its own analysis work. Instead, a background coordinator in [src/services/refresh-coordinator.js](src/services/refresh-coordinator.js) refreshes shared state on a cadence.

That shared refresh loop:

- updates datasource previews
- refreshes workspace plans
- refreshes selected panel analyses
- deduplicates equivalent work across users
- persists the latest domain snapshot

Browsers connect as subscribers. On load they get the latest shared state, and then they receive updates over SSE.

### Workspace Planner

Morphy has a bounded workspace planner. The planner can change:

- focus panel
- visible panel subset
- panel grouping
- collapsed secondary sections
- recommended operator actions

It cannot arbitrarily rewrite the whole frontend. The planner output is structured JSON, and the client interprets that JSON directly. Freeform rationale text is informational only.

### Generated Browser Widgets

Completed runs can produce browser-executable widget bundles stored under `data/state/widget-bundles`.

Each widget bundle contains:

- `index.html`
- `styles.css`
- `widget.js`
- `manifest.json`

These widgets are served into sandboxed iframes and receive scoped payloads from the host runtime. They never get datasource credentials directly.

The current model is:

- server-side agent decides what panel analysis is needed
- a report is produced first
- widget generation is a follow-on enhancement step
- the native chart remains available as the guaranteed fallback

## Runtime Data Model

Important persisted state includes:

- domain configs in `data/domains`
- datasource configs in `config/data-sources.json`
- runs in `data/state/runs`
- session metadata in `data/state/agent-sessions.json`
- workspace plans in `data/state/workspace-plans.json`
- shared live state in `data/state/live-state.json`
- widget metadata in `data/state/widgets/index.json`

This persistence lets Morphy recover state across server restarts and serve a current view immediately to newly connected browsers.

## Browser Experience

The browser UI is designed around a focused workspace instead of showing every panel at once.

Current UX behavior includes:

- a panel rail with one active panel on stage
- collapsible debug visibility into planner rationale
- a studio drawer for infrequent configuration tasks
- recent runs and source previews as secondary material
- native charts for baseline readability
- generated widgets as richer optional artifacts

## Multi-User Behavior

The intended multi-user model is:

- the server continuously maintains a current analytical picture
- browsers render the most recent persisted state
- users can request analysis manually
- normal reruns reuse fresh or in-progress work when possible
- force reruns bypass reuse and start a fresh analysis

This reduces duplicate model calls and keeps the application closer to a shared monitoring surface than a single-user prompt toy.

## Data Sources

Morphy currently supports preview adapters for:

- JSON object stores / files
- VictoriaMetrics-compatible time-series endpoints
- relational sample-row stubs

The current VictoriaMetrics datasource example is in [config/data-sources.json](config/data-sources.json).

For historical datasets, explicit time windows matter. Without `start`, `end`, and an evaluation time, a valid endpoint may appear empty if the data is not current.

## Running Morphy

1. Install dependencies.

```bash
npm install
```

2. Export an API key if you want live OpenAI-backed planning, analysis, and widget generation.

```bash
export OPENAI_API_KEY=your_key_here
```

3. Start the server.

```bash
npm start
```

4. Open the app in a browser.

```text
http://127.0.0.1:3000
```

## Key Files

- [src/server.js](src/server.js): Express app, APIs, SSE, generated widget serving
- [src/services/agent-runtime.js](src/services/agent-runtime.js): planning and analysis orchestration
- [src/services/refresh-coordinator.js](src/services/refresh-coordinator.js): shared refresh loop
- [src/services/widget-service.js](src/services/widget-service.js): widget bundle generation and serving
- [src/services/data-sources.js](src/services/data-sources.js): datasource previews and VictoriaMetrics access
- [src/services/config-store.js](src/services/config-store.js): persisted config and runtime state
- [public/app.js](public/app.js): client-side workspace rendering and event handling
- [public/runtime/widget-bridge.js](public/runtime/widget-bridge.js): iframe bridge for generated widgets

## Current Limitations

- datasource access is still preview-oriented rather than a full query-planning system
- relational support is still a stub
- widget generation is useful but not yet consistently high quality
- generated browser artifacts are sandboxed, but the validation and CSP story should be tightened before production use
- auth, tenancy, and operator approval controls are not implemented

## Direction

The broader direction for Morphy is:

- fixed outer shell
- config-driven domain scaffolding
- bounded agent-driven workspace adaptation
- shared server-side analysis refresh
- generated browser widgets for panel-specific visual artifacts

That combination is meant to let one application serve many domains without reducing the UI to a raw chatbot or requiring a separate hand-built frontend for every dataset.
