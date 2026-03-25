# Morphy Architecture

## Executive Summary

Morphy is an experiment in a **metamorphic system**: a system that can contextually modify parts of its own behavior and presentation through AI while remaining bounded, inspectable, and operable.

Morphy is not trying to be a fully self-rewriting application. The design goal is more specific:

- keep a stable host application
- let AI reinterpret data context continuously
- let AI adapt workspace structure within explicit limits
- let AI choose among bounded presentation archetypes
- let AI generate browser-executable panel artifacts safely
- preserve enough structure that operators can trust, debug, and manage the result

This document describes how the current Morphy prototype is structured and what constraints define its metamorphic behavior.

## System Goals

Morphy is designed to support analytical web applications over heterogeneous data sources such as:

- relational systems
- JSON object stores
- time-series databases such as VictoriaMetrics

The intended outcome is a single host application that can support many analytical domains by combining:

- config-defined domain scaffolding
- server-side AI-driven reasoning
- bounded runtime workspace adaptation
- generated panel-specific browser widgets

The current primary example domain is HPC cluster observability over a VictoriaMetrics dataset with Slurm, ROCm GPU telemetry, fabric counters, storage health, and job-correlation signals.

## Architectural Principles

### Stable Shell, Adaptive Interior

Morphy keeps a stable application shell. The global navigation, layout frame, datasource controls, and hosting responsibilities stay deterministic.

The adaptive part of the system is the analytical workspace inside that shell:

- which panels are emphasized
- how panels are grouped
- which presentation archetype a panel uses
- what report content and widget are attached to a panel

### Bounded Metamorphosis

Morphy does not allow unconstrained runtime UI rewriting. Adaptation is limited by:

- domain scaffolding schema
- planner output schema
- archetype allow-lists
- sandboxed widget execution
- server-owned datasource access

This is the key design distinction. Morphy is self-modifying in a contextual sense, but only within contracts that the host application understands.

### Shared Server-Side Intelligence

Morphy is designed for multi-user analytical surfaces, not one isolated prompt session per browser. The server performs shared refresh and reasoning work, persists the results, and lets browsers subscribe to the current state.

That avoids:

- duplicate model calls across users
- inconsistent user views of the same domain
- latency spikes caused by every page load triggering fresh reasoning

### Tool-First Analysis

Morphy is moving toward a tool-first model. Deterministic local server-side tools do the ranking, aggregation, correlation, and basic analytical reduction work first. The model is then used mainly for:

- choosing priorities
- selecting presentation archetypes
- interpreting evidence
- producing narratives and detail sections
- generating presentation artifacts

This separation keeps raw data and heavy computation local while preserving adaptive model behavior where it is most valuable.

The next architectural constraint is equally important: Morphy should not drift into a pile of hardcoded domain helpers. To preserve the metamorphic property of the system, the tool layer is being split into:

- a stable execution substrate in code
- domain- and panel-level `analysisRecipe` specifications generated or authored in config

That means the runtime owns generic deterministic primitives, while the active domain configuration decides how those primitives are composed for the current form of the system.

### Reports First, Widgets Second

The primary output of an analysis run is a structured report and native chart. Generated widgets are a secondary artifact attached to the run after the analysis completes.

This gives Morphy:

- a reliable native rendering path
- lower perceived failure when widget generation is delayed
- a clean separation between analytical correctness and richer presentation

## Top-Level Components

### 1. Host Application

The host application is implemented with Node.js and Express. It is responsible for:

- configuration loading
- API endpoints
- state persistence
- datasource access
- refresh coordination
- serving the browser UI
- serving generated widget artifacts

Important entry point:

- [src/server.js](src/server.js)

### 2. Domain Scaffolding

Each domain is described in JSON. A domain defines:

- domain identity
- required datasource ids
- domain-level analysis recipe
- panel definitions
- panel summaries
- panel analysis prompts
- preferred chart types
- per-panel allowed archetypes
- per-panel analysis recipes

Example:

- [data/domains/hpcfund-cluster-observability.json](data/domains/hpcfund-cluster-observability.json)

This scaffolding is the base structure from which runtime adaptation begins.

The important current shift is that domain configs now describe not only UI scaffolding, but also the domain-specific local analysis behavior. The runtime owns the deterministic primitives; the active domain config owns how they are composed.

### 3. Datasource Adapters

Datasource adapters gather a **source preview**, which is Morphy’s compact summary of the underlying datasource state. A preview is not a full dump of the datasource. It is a bounded summary intended to inform planning and analysis.

Current adapters:

- JSON-backed previews
- VictoriaMetrics preview queries
- relational sample-row previews

Primary implementation:

- [src/services/data-sources.js](src/services/data-sources.js)

### 4. Agent Runtime

The agent runtime orchestrates:

- deterministic tool summarization
- workspace planning
- archetype selection
- panel analysis
- run completion
- widget generation kickoff

Primary implementation:

- [src/services/agent-runtime.js](src/services/agent-runtime.js)

### 5. Refresh Coordinator

The refresh coordinator runs the shared server-side refresh loop. It:

- refreshes datasource previews
- refreshes workspace plans
- refreshes selected panels
- deduplicates in-flight domain refresh work

Primary implementation:

- [src/services/refresh-coordinator.js](src/services/refresh-coordinator.js)

### 6. Widget Service

The widget service:

- generates widget bundles
- stores widget artifacts
- injects run payloads into widget HTML
- serves widget files
- normalizes older widget bundles at serve time

Primary implementation:

- [src/services/widget-service.js](src/services/widget-service.js)

### 7. Browser Host

The browser host:

- renders the stable shell
- applies workspace plans
- renders native charts and archetype detail cards
- embeds generated widgets in iframes
- subscribes to live SSE updates

Primary implementation:

- [public/index.html](public/index.html)
- [public/app.js](public/app.js)
- [public/styles.css](public/styles.css)

### 8. Deterministic Tool Layer

The deterministic tool layer computes local analytical summaries over preview data before model calls are made.

Primary implementation:

- [src/services/analysis-tools.js](src/services/analysis-tools.js)

The substrate now executes recipe blocks such as:

- `scalar`
- `top_entries`

Domain configs use those primitives to define the actual local analytical summaries for the domain and for each panel. For example, a panel can declare recipe blocks for:

- backlog leaders by partition
- partition saturation leaders
- hottest GPUs
- fabric/storage risk leaders
- recent jobs by node
- peak GPU utilization / VRAM / occupancy by job

These outputs are intentionally compact and deterministic so that the model can reason over already-reduced evidence rather than large raw preview blobs.

This is the main mechanism that keeps Morphy metamorphic while still reducing token spend: the code owns the stable execution substrate, while prompt-generated or authored config owns the domain-specific local analytical behavior.

## Runtime State Model

Morphy persists runtime state under `data/state`.

Important persisted objects:

- live shared state
- workspace plans
- runs
- widgets
- billing ledger

These paths are configured in:

- [src/services/config-store.js](src/services/config-store.js)

Tracked state includes:

### Domain Snapshot

A domain snapshot summarizes the server’s current shared view of a domain, including panel status and source previews.

### Workspace Plan

The workspace plan is the bounded planner output for a domain. It can include:

- `layoutMode`
- `focusPanelId`
- `visiblePanelIds`
- `panelGroups`
- `collapsedSections`
- `recommendedActions`
- `rationale`

### Run

A run is the authoritative unit of analysis output. A run stores:

- domain and panel identity
- run status
- report
- selected archetype
- widget lifecycle status
- optional widget id and URL
- analysis usage/cost
- widget usage/cost

### Widget Artifact

A widget artifact is attached to a specific run and stored as:

- `index.html`
- `styles.css`
- `widget.js`
- `manifest.json`

### Billing Ledger

The billing ledger records model-specific usage and cost across:

- workspace planning
- archetype selection
- panel analysis
- widget generation

## End-to-End Analytical Flow

The current analytical flow is:

1. Refresh coordinator chooses a domain to refresh.
2. Datasource adapters refresh the domain’s source preview if stale.
3. Deterministic local tools summarize the refreshed preview state.
4. The fallback planner or model-driven planner ranks panels from recipe-derived local evidence.
5. Workspace planning is rerun if stale.
6. The coordinator selects a bounded set of panels for the current sweep.
7. For each selected panel, Morphy either reuses a fresh run or starts a new analysis run.
8. The analysis run selects an archetype from the allowed set.
9. The analysis call returns a report using deterministic tool outputs as primary evidence.
10. The run is marked complete for analysis.
11. Widget generation starts asynchronously.
12. The widget artifact is attached to the run when ready.
13. SSE events notify connected browsers as state changes.

This split is deliberate. Analysis and widget generation are separate phases.

## Source Previews

Morphy does not send full datasource contents to the model. Instead it builds a **source preview** from bounded query results or sample records.

For VictoriaMetrics, the preview may include:

- query window metadata
- query name
- result type
- result count
- a limited sample of result rows

This preview is persisted and reused until its TTL expires.

On top of the preview, Morphy now derives deterministic tool summaries. The preview is the raw local substrate; the tool summary is the reduced evidence passed to the model.

For the HPCFund domain, queries include examples such as:

- pending jobs by partition
- partition CPU saturation
- hottest GPUs by temperature
- recent jobs by node
- peak GPU utilization
- peak GPU VRAM
- peak GPU occupancy

## Workspace Planning

Workspace planning is a bounded form of metamorphic behavior.

The planner can change:

- the primary panel
- which panels are visible
- rail grouping
- which secondary sections start collapsed

The planner cannot:

- rewrite the outer application shell
- invent arbitrary new host UI
- bypass panel or domain contracts

The planner’s structured output is interpreted directly by the browser. Human-readable rationale is not used as a machine control surface.

In the current implementation, even the no-model fallback planner is no longer keyed to specific panel ids like `scheduler-pressure` or `gpu-hotspots`. It ranks the configured panels by evidence density from their local recipe outputs, boosts failed or missing runs generically, and produces a bounded workspace plan from that ranking.

## Archetype Layer

Archetypes are Morphy’s bounded presentation families. Current archetypes include:

- `risk-scoreboard`
- `pressure-board`
- `timeline-analysis`
- `correlation-inspector`
- `incident-summary`
- `job-detail-sheet`

Archetypes are defined in:

- [src/lib/archetypes.js](src/lib/archetypes.js)

Archetypes matter at three levels:

### Design-Time Policy

Each panel can define:

- `allowedArchetypes`
- `preferredArchetype`
- `archetypeGuidance`

This constrains which presentation families are valid for that panel.

### Runtime Selection

Before analysis, Morphy chooses one archetype from the allowed set based on:

- current datasource evidence
- recipe-derived local findings
- panel purpose
- preferred archetype
- confidence in the available signal

The chosen archetype is persisted on the run.

### Runtime Rendering

The selected archetype influences:

- analysis contract
- host-native detail rendering
- widget-generation prompt

This is how Morphy turns contextual information into bounded presentation change.

In the current implementation, even heuristic archetype fallback is no longer hardcoded to specific panel ids. It scores the allowed archetypes from recipe metadata, evidence shape, and chart bias, then chooses the highest-scoring allowed archetype.

## Archetype-Aware Analysis

Morphy no longer treats all analysis output as the same generic structure. Each selected archetype carries a more specific analysis contract.

The current design is:

- strict on shape
- flexible on content

That means Morphy can require a `pressure-board` analysis to produce pressure-oriented sections without forcing one exact metric set or one rigid layout.

This preserves adaptivity while keeping rendering predictable.

Fallback detail synthesis now follows the same principle. When the model output is incomplete, Morphy backfills archetype sections from generic evidence pools built from:

- deterministic recipe findings
- native chart leaders
- narrative/highlight text
- preview coverage notes

That means archetype fallback stays bounded and archetype-specific without reverting to hardcoded panel/query rules.

## Widget Architecture

Widgets are browser-executable artifacts delivered through sandboxed iframes.

### Widget Inputs

The widget document receives a payload through:

- embedded `window.__MORPHY_PAYLOAD__`
- optional bridge updates from the host page

The payload currently includes:

- `runId`
- compact `domain`
- compact `panel`
- selected `archetype`
- `report`
- compact `context`
- timestamps
- theme values

Widgets are therefore mostly self-contained for initial render.

### Widget Safety Model

Widgets do not receive:

- datasource credentials
- unrestricted host APIs
- arbitrary shell access

They are hosted in a restricted iframe environment and communicate with the parent through a narrow bridge.

### Widget Lifecycle

For a given run:

- analysis completes first
- widget generation starts afterward
- widget readiness is tracked separately

This avoids blocking the main analytical result on code generation latency.

## Shared Refresh Schedule

The current default schedule is:

- refresh tick: every `60s`
- source preview TTL: `60s`
- workspace plan TTL: `5m`
- analysis TTL: `5m`
- panels per domain sweep: `3`

Practical effect:

- each minute, Morphy checks each domain
- datasource previews can refresh each minute
- planning and panel analysis are only rerun when stale
- up to three panels per domain are refreshed in a sweep

This is selective refresh, not “rerun everything every minute.”

## Concurrency Model

Morphy is designed for bounded parallelism.

Current behavior:

- domains can refresh concurrently
- panels within a sweep can run concurrently
- widget generation can overlap with other panel analysis work

This means multiple model calls can be in flight at the same time.

Concurrency is bounded by:

- domain refresh deduplication
- sweep panel count limits
- TTL-based reuse of fresh results

## Prompt Context Strategy

Morphy originally spent too much on large prompts and accumulated history. The current design reduces token usage by:

- summarizing domain context instead of dumping whole objects
- pushing ranking, aggregation, and correlation work into deterministic local tools
- trimming datasource context per panel
- limiting source preview samples
- compacting workspace plan context
- compacting recent run summaries
- disabling response-history reuse by default

This improves:

- spend
- latency
- responsiveness

without giving up panel relevance.

It also changes where domain specificity lives. Instead of accumulating more fixed helper code in the runtime, Morphy now pushes more domain-specific analytical structure into `analysisRecipe` config and lets the runtime interpret it.

The current target architecture is:

- local tools for computation
- model for planning and interpretation
- generated widgets for presentation

## Code Interpreter Outlook

Morphy does not yet depend on Code Interpreter, but the architecture now anticipates it as a future execution tier.

The intended use is selective, not default. Good candidate cases are:

- ad hoc deeper tabular analysis
- richer time-series decomposition
- exploratory workload notebooks
- one-off artifact generation beyond deterministic local tool coverage

The design intent is:

- deterministic local tools first
- Code Interpreter second when a richer execution sandbox is justified
- broader Codex App Server style integration later only if the agent-runtime benefits outweigh the added complexity

## Billing And Cost Tracking

Morphy now tracks model-specific spend using a pricing table configured in:

- [config/app.config.json](config/app.config.json)

Current billing behavior:

- normalizes model usage
- computes estimated cost by token class
- persists usage records in a billing ledger
- aggregates spend by model, operation, panel, and archetype
- streams spend updates to the browser

The browser can show:

- total spend
- input vs cached input vs output spend
- panel-level cumulative spend
- archetype-level cumulative spend
- current run spend split between analysis and widget generation

## Browser Synchronization

Morphy uses a hybrid browser update model:

- periodic bootstrap polling
- SSE for live events

Important SSE events:

- `run.update`
- `workspace.update`
- `domain.refresh`
- `spend.update`

The browser is mainly a subscriber to shared server-side state, not the primary orchestrator of analytical work.

## Debuggability

Morphy includes structured diagnostics on both server and client sides.

Diagnostics are parameter-driven and category-based, so tracing can be focused on:

- refresh
- analysis
- widgets
- planner
- render
- network
- billing

This is important for a metamorphic system because adaptive behavior is only operationally viable if its decisions and state transitions can be traced.

## Security And Trust Boundaries

Morphy treats the following as privileged:

- datasource access
- API keys
- refresh orchestration
- billing state
- run persistence

Generated widgets are intentionally non-privileged and sandboxed. They are presentation artifacts, not autonomous host controllers.

This boundary is central to Morphy’s design. AI may influence presentation and analysis, but it does not directly own the application’s trust boundaries.

## Current Constraints

The current prototype still has important limits:

- planner adaptation is bounded to existing scaffolding
- widget validation against archetype contracts is still limited
- widget generation can still be expensive
- widgets are not yet reused across equivalent runs
- panel-scaffold mutation is limited to workspace rearrangement rather than full scaffold deltas
- the system still uses model APIs rather than a fuller Codex tool-execution harness

## Near-Term Evolution

Likely next steps include:

- stronger archetype-conformance validation
- smarter widget regeneration policies
- threshold-based widget reuse when underlying payload changes are minor
- richer planner use of archetype intent
- controlled scaffold-delta generation beyond simple panel reordering
- more domain-specific query-packing and compact context policies

## Design Summary

Morphy’s architecture is an attempt to make AI-driven software adaptation operationally credible.

The core idea is not “let the model redesign the app whenever it wants.” The core idea is:

- define bounded structures
- let AI choose and fill those structures contextually
- persist and share the results
- expose enough diagnostics and lifecycle state that the system remains understandable

That is what makes Morphy a metamorphic system rather than just a prompt-driven dashboard generator.
