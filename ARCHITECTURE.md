# Morphy Architecture

## Introduction

Morphy is an experiment in a particular kind of AI-assisted software system: a **metamorphic system**. By metamorphic, Morphy does not mean “a program that rewrites itself arbitrarily.” It means a system that can change its analytical shape, emphasis, and presentation in response to context while still remaining bounded enough to inspect, debug, and operate. The host application stays recognizable and stable. The inner analytical workspace, however, can shift. Panels can move in and out of focus. Presentation archetypes can change. Widgets can be regenerated. Interactive controls can expose different entities and workflows in different domains. The result should feel adaptable without feeling chaotic.

That design goal shapes almost every major architectural decision in the project. Morphy is not a chatbot pasted into a dashboard. It is also not a fixed dashboard with a few AI-generated summaries bolted on. Instead, it is a server-centered analytical runtime that uses configuration, deterministic local tooling, model reasoning, and browser-side rendering together to project a domain-specific analytical interface over heterogeneous data sources.

This document describes the system as it exists now: how domains are defined, how the server thinks, how data moves into the browser, how widgets are generated and updated, where model-directed tool use exists already, and where the architecture is intentionally constrained.

## The Core Architectural Idea

At the highest level, Morphy is built around a stable host shell and an adaptive interior.

The stable shell is the part of the application that should not surprise the user. It includes the Node.js and Express server, the browser host application, the routing and API surface, the persistence layer, the refresh coordinator, the billing tracker, the diagnostics system, and the general layout of the UI. Morphy treats that shell as infrastructure. It is deterministic, inspectable, and owned by the application code.

Inside that shell sits the adaptive analytical workspace. This is the part Morphy allows to shift in response to both configuration and runtime evidence. A domain can define a completely different set of panels than another domain. The workspace planner can choose which panels matter right now. The system can select different presentation archetypes for the same panel under different evidence conditions. Widgets can be regenerated or updated with richer filtered views. Interactive panels can expose validated controls grounded in datasource contents. This interior is where Morphy’s metamorphic behavior lives.

The most important constraint is that Morphy never gives the model arbitrary authority over the entire application. The model can influence bounded structures. It cannot rewrite the host shell. It cannot bypass the server’s data access rules. It cannot ship arbitrary privileged code into the browser. Every adaptive layer is routed through a contract the host understands.

## System Overview

Morphy is a Node.js and Express application with a browser client. The server owns state, analysis, refresh scheduling, datasource access, and widget generation. The browser is primarily a subscriber and renderer of shared state rather than an autonomous analysis initiator.

From the outside, a user experiences Morphy as a domain-specific analytical workspace. They choose or generate a domain, browse panels, run or force rerun analyses, inspect native charts and generated widgets, and optionally interact with filtered widgets such as `Job Explorer`. Underneath that surface, the server is maintaining a persistent shared picture of the domain. It periodically refreshes datasource previews, recalculates workspace plans, reruns stale panel analyses, and attaches widget artifacts to completed runs. Multiple users are therefore looking at the same current domain state rather than independently triggering duplicate model calls.

Morphy currently supports heterogeneous data source types, including VictoriaMetrics, JSON-backed sources, and relational-style sample sources. The system is designed so that additional datasource adapters can be added without changing the host model. What changes across domains is not the server skeleton, but the domain configuration and the local tool recipes that explain how to interpret that data.

## Layers of the System

### The Host Server

The entry point for the application is [src/server.js](src/server.js). This file wires together the major runtime services: configuration storage, datasource previewing, the agent runtime, widget generation, billing, logging, and the refresh coordinator. The Express server exposes the API surface used by the browser UI and also serves the browser app itself.

The server does several jobs at once. It is the configuration service for domains and datasources. It is the shared-state service that returns bootstrap data to the browser. It is the orchestration layer that receives analysis requests and turns them into persistent runs. It is the live update hub through Server-Sent Events. It is also the artifact server for generated widgets. This concentration is deliberate in the current prototype: Morphy is easier to reason about when the authoritative state transitions remain on one side of the browser/server boundary.

### The Browser Host

The browser client is implemented in [public/index.html](public/index.html), [public/app.js](public/app.js), and [public/styles.css](public/styles.css). The browser is not where privileged analysis happens. Instead, it renders the current shared state of the system and responds to updates as the server changes that state.

The browser host is responsible for the visible structure of the application: the sidebar, panel rail, panel stage, spend display, Studio drawer, recent runs, and source preview views. It is also responsible for interpreting the bounded workspace plan and applying it to the UI. When the server says a panel should be focused, or that certain sections should be collapsed, the client applies those instructions. When the server says a run has completed or a widget has attached, the browser updates the relevant panel view.

Crucially, the browser host also acts as the broker between sandboxed widgets and the rest of Morphy. The iframe widget cannot directly reach privileged APIs or datasource credentials. The browser host forwards allowed requests from widgets to Morphy’s server endpoints, then pushes filtered results back into the iframe over the widget bridge.

### Persistent Configuration and State

Morphy persists both static configuration and runtime state. The persistence layer lives behind [src/services/config-store.js](src/services/config-store.js).

Static configuration includes the application config in `config/app.config.json`, datasource definitions in `config/data-sources.json`, and domain scaffolding in `data/domains`. Runtime state is stored under `data/state`. This includes runs, workspace plans, live shared state, widgets, billing ledger entries, and related runtime objects.

The decision to persist runtime state is fundamental to Morphy’s multi-user architecture. The server is not simply answering a live prompt per request and discarding the result. It is maintaining a domain state model across time. This allows newly opened browser sessions to receive the current operational picture immediately, rather than waiting for fresh model calls to reconstruct it.

## Domain Configuration as the Starting Point

Morphy begins from domain configuration. A domain is a JSON document that describes what the analytical workspace is supposed to be about. The domain config gives Morphy a starting scaffold, but the goal is not for that scaffold to be the final fixed UI. Instead, it is the stable baseline from which bounded adaptation begins.

The current primary domain example is [data/domains/hpcfund-cluster-observability.json](data/domains/hpcfund-cluster-observability.json), which reflects a VictoriaMetrics-backed GPU cluster monitoring scenario. That file defines domain identity, associated data source ids, domain-level analysis recipes, panel definitions, archetype policy, interaction contracts, and panel-level analysis recipes.

Each panel in a domain has several different responsibilities encoded into config. It has a title and summary for the user-facing scaffold. It has an `analysisPrompt`, which still matters for the interpretive model call. It has archetype policy such as `allowedArchetypes`, `preferredArchetype`, and `archetypeGuidance`. It can also have an `interactionMode` and `interactionContract` if it is meant to behave as an interactive panel rather than a purely report-oriented one. Most importantly for the current architecture, it has an `analysisRecipe`, which describes how deterministic local tools should summarize the underlying data for that panel.

This means the domain config is no longer just “panel labels and prompts.” It is the main point where Morphy’s metamorphic intent is encoded. A domain is telling the system not only what kind of workspace to show, but how to locally reduce evidence and what kinds of presentation families are valid.

## Grounded Domain Creation

One of the earlier architectural gaps in Morphy was that domain creation understood datasource configuration but not actual datasource contents. The current design moves beyond that. When Morphy generates a domain from Studio, it no longer relies only on the user prompt and datasource metadata. It also gathers live datasource discovery evidence and passes that into domain generation.

For VictoriaMetrics, that discovery evidence includes the active query window, representative query results, label keys, metric hints extracted from query expressions, and a bounded sample of actual result rows. For JSON and relational sources, the evidence includes row shapes, sample keys, numeric fields, and sample rows. This allows the model to generate a domain that reflects the semantic shape of the real source instead of simply guessing based on the datasource type.

Generated domains now also persist `generationPrompt` and `generationEvidenceSummary`. This gives Morphy a lineage for future domain evolution: what the user asked for, and what datasource evidence most strongly shaped the resulting scaffold.

## Datasource Adapters and Source Previews

Morphy does not send full datasets to the model. Instead, it builds a **source preview**. A source preview is a bounded local summary of the underlying datasource state. It is intended to be compact enough to reuse and reason over, while still preserving enough signal for planning and analysis.

Datasource previewing is implemented in [src/services/data-sources.js](src/services/data-sources.js). Each supported datasource type has its own strategy for constructing a preview. VictoriaMetrics uses predefined preview queries and returns bounded result samples together with query-window metadata. JSON-backed sources return sample rows and field hints. Relational-style sources return sample rows and column-like summaries.

The preview is important because it is the raw local substrate from which every higher-level reasoning step begins. It feeds deterministic local tools. It feeds workspace planning. It feeds analysis. It also underpins interactive validation, because the same preview evidence is used to generate valid job, host, or partition choices for interactive controls.

Morphy refreshes previews on a cadence rather than rebuilding them for every browser request. That preview TTL is part of the shared refresh model described later in this document.

## Deterministic Local Tooling

Morphy follows a tool-first philosophy. The server should do as much deterministic ranking, grouping, correlation, and filtering work as possible before handing evidence to the model. This reduces token spend, improves responsiveness, and keeps raw data local. But if Morphy is supposed to remain metamorphic, the tool layer cannot collapse into a pile of fixed per-domain helpers. The architecture therefore distinguishes between a stable execution substrate and domain-specific recipes.

The stable execution substrate lives in [src/services/analysis-tools.js](src/services/analysis-tools.js). It knows how to execute compact operations such as `scalar` and `top_entries` over preview data. These are not bound to one specific domain. They are generic local primitives.

What varies by domain is the `analysisRecipe` configuration. A recipe is a domain- or panel-level description of which local evidence blocks should exist. A panel can specify blocks for backlog leaders, saturation leaders, hottest GPUs, recent jobs by node, utilization peaks, VRAM peaks, occupancy peaks, or any other compact deterministic summary expressible in the current recipe language. The runtime then executes those recipes locally.

This is one of the most important architectural moves in Morphy. The code owns the execution substrate. The active domain configuration owns the way that substrate is composed for the current form of the system. That is how Morphy gains cost efficiency without giving up its metamorphic character.

## Derived Tool Registries

Morphy now goes one step further than local deterministic summaries. From the current domain and panel recipes, it derives a **model-facing tool registry**. This registry is not the same as the stable primitive substrate. The substrate is internal and generic. The derived registry is the exposed analytical surface the model sees for the current domain.

For example, in one domain the model might be shown tools corresponding to backlog ranking, GPU hotspot ranking, or job correlation. In another domain, the registry could expose very different tools, even though underneath they are still built from the same small set of stable primitives. This keeps the system configurable by prompt and recipe without exposing arbitrary server code as a tool surface.

The derived registry is visible in the Studio UI so that users can inspect what Morphy has projected from the current domain configuration. This is important both for debugging and for maintaining trust in the system’s metamorphic behavior.

## Model-Directed Tool Calling

Morphy is no longer limited to merely presenting tool summaries to the model. It now has real model-directed tool invocation in several parts of the pipeline.

The first such layer is workspace planning. The model can see a domain-specific derived tool registry, decide whether more evidence is needed, request one or more tools from that registry, and then receive the results back before producing a final workspace plan. The same pattern exists for archetype selection and for panel analysis itself. In each case the server validates requested tool ids, executes them locally through the deterministic substrate, and records the resulting tool trace.

This means Morphy has crossed an important threshold. The model is no longer just consuming static prompt context prepared by the server. It can now choose bounded local tools from the current domain-specific registry and use their outputs to refine a decision. These traces are persisted and surfaced in the UI so that the behavior remains inspectable.

Widget generation can also use a model-directed tool loop for non-interactive widget generation. Interactive panels, however, now deliberately follow a different path, discussed below.

## The Refresh Coordinator and Shared Runtime Model

Morphy is designed as a shared server runtime rather than a per-browser reasoning experience. That is why the refresh coordinator in [src/services/refresh-coordinator.js](src/services/refresh-coordinator.js) exists.

The refresh coordinator periodically walks all configured domains. On each tick, it checks whether source previews are stale, whether workspace plans are stale, and which panel analyses should be refreshed. It does not rerun every panel every minute. Instead, it runs a bounded sweep per domain, currently limited by `panelsPerSweep`, and only reruns analyses that are stale enough to require it.

This design avoids duplicated model calls when multiple users are looking at the same domain. The browser is not the authority over whether a panel should be refreshed. The server is. The browser mostly consumes the current persisted snapshot of the domain and then subscribes for updates as that shared state evolves.

This architecture is also why Morphy has concepts like domain snapshots, live shared state, workspace plans, runs, widgets, and billing ledgers. All of these are parts of a persistent multi-user operational surface.

## Workspace Planning

Workspace planning is one of Morphy’s central bounded metamorphic behaviors. The planner decides how the analytical workspace should be arranged without being allowed to rewrite the whole application.

The planner can choose a focus panel, determine which panels are visible, group them in the panel rail, and decide which secondary sections start collapsed. It can also supply rationale and recommended actions for operator awareness and debugging. What it cannot do is mutate the outer shell, create arbitrary navigation, or bypass domain contracts.

The planner’s output is structured JSON, not prose interpreted as code. The browser applies the structured fields directly. The rationale is for humans, not a machine control surface. Even the fallback planner, when no model is used, now derives decisions from generic evidence density and run state rather than hardcoded panel ids.

## Archetypes as Bounded Presentation Families

Morphy uses archetypes to control presentation adaptivity. An archetype is a bounded presentation family such as `risk-scoreboard`, `pressure-board`, `timeline-analysis`, `correlation-inspector`, `incident-summary`, or `job-detail-sheet`. The current archetype definitions live in [src/lib/archetypes.js](src/lib/archetypes.js).

Archetypes matter in three distinct phases. During domain design, a panel declares which archetypes are allowed and which one is preferred. During runtime, Morphy selects one archetype for the current run based on current evidence, panel intent, and confidence. During rendering, the selected archetype influences the analysis contract, host-native detail rendering, and widget shape.

This is an important compromise in Morphy’s metamorphic design. The model can adapt presentation meaningfully, but only within a bounded vocabulary of shapes the system understands.

## Analysis Runs

The run is the authoritative unit of analytical output. When Morphy starts a run for a panel, it persists that run immediately and then steps it through a series of progress phases. Those phases include context preparation, workspace planning, archetype selection, analysis tool selection, analysis submission, analysis running, report finalization, and the widget phases that follow. The browser displays these phases so users can see that the server is working and where time is being spent.

During analysis, Morphy now combines several kinds of evidence. It uses compact domain and panel summaries, the selected archetype and its contract, deterministic local findings, and optionally model-directed tool outputs chosen during the analysis phase itself. The model then returns a structured report with `narrative`, `highlights`, `details`, and `chart`. The report is normalized on the server before being persisted.

The key design rule here is that Morphy now tries to reserve the model for interpretation and presentation, not for basic numeric reduction. Rankings, filtering, grouping, and similar operations are meant to happen locally first.

## Widgets

Widget generation is a secondary phase after analysis, not the primary analytical result. This distinction was introduced because widget generation was both expensive and latency-sensitive. By separating report completion from widget attachment, Morphy ensures that the analytical result can still appear even when a widget is slow or unavailable.

Widgets are stored as bundles under `data/state/widget-bundles`. A bundle contains `index.html`, `styles.css`, `widget.js`, and `manifest.json`. Each widget is attached to a specific run. For non-interactive panels, widget generation may still involve model-generated browser artifacts. For interactive panels, Morphy has moved toward deterministic local widget templates to improve reliability, cost, and interaction quality.

The widget payload is embedded into `index.html` as `window.__MORPHY_PAYLOAD__` and also updated over the widget bridge. This payload includes domain and panel metadata, selected archetype, report, local findings, interaction state, timestamps, and theme data.

## Interactive Widgets

Interactive widgets required a different architecture from static or briefing-style widgets. A widget such as `Job Explorer` cannot be treated as a one-shot artifact bound forever to one payload. Users need to filter, validate, and reinterpret subsets of the data without regenerating the entire widget each time.

Morphy therefore separates widget structure from widget data refresh. The widget code can remain stable while the user changes filters. The widget can ask the host for filtered data through the bridge. The server validates requested parameters against datasource-backed choices, recomputes interaction state locally, and returns a filtered payload. This is the cheap path.

Morphy also now supports a second, explicit interaction path: **reinterpretation**. The user can request a model-backed reinterpretation of the currently filtered view. That does not regenerate the widget. Instead, it runs a scoped model call over the filtered evidence and returns refreshed narrative/highlights/detail content for the existing widget. This allows interactive widgets to remain responsive and cheap by default while still giving the user access to a richer interpretive pass when desired.

Interactive widgets also expose validated controls. A job selector, host selector, partition selector, or date range control is not just a freeform input. Its values are derived from the underlying datasource evidence or validated against it. This is how Morphy keeps interactive panels grounded in the data.

## The Widget Bridge

The browser and widget communicate through [public/runtime/widget-bridge.js](public/runtime/widget-bridge.js). The bridge is intentionally narrow. Widgets can register `onInit` and `onUpdate` handlers. They can emit resize and ready events. They can request filtered data refresh. They can now also request reinterpretation for the current filtered state.

The browser host mediates those requests. It forwards them to Morphy’s server endpoints and then posts responses back into the iframe. This prevents widgets from directly reaching privileged APIs or unrestricted network surfaces.

The bridge also supports interaction heartbeats so the host can tell when a user is actively interacting with a widget. Morphy uses that signal to avoid swapping in a newly generated widget artifact while the user is in the middle of entering data.

## Widget Serving and Serve-Time Rebuilds

One subtle architectural issue emerged while iterating on interactive widgets: saved widget bundles could become stale relative to improvements in the deterministic widget renderer. If local interactive widgets were stored once and then served forever from disk, browser reloads would not pick up newer renderer logic until another run regenerated the widget.

To fix that, Morphy now rebuilds **local interactive widgets at serve time** from the current renderer code. This means renderer fixes for interactive panels can take effect on page reload without requiring a fresh panel rerun just to pick up stale widget JS. Persisted widgets still exist as artifacts, but the local interactive template path is served from the current deterministic code rather than frozen historical bundle logic.

## Billing and Cost Visibility

Morphy tracks model usage and cost through [src/lib/billing.js](src/lib/billing.js). Billing entries record model name, operation type, token usage, and cost using a model-specific pricing table from configuration. The browser surfaces both global spend and panel-level or archetype-level spend where possible.

This matters architecturally because Morphy is intentionally experimenting with where AI should and should not be used. The system now makes it possible to observe that difference. For example, the move from model-generated interactive widgets to deterministic interactive templates produced a large speed and cost improvement. Cost visibility is therefore not just an administrative feature; it is part of the design feedback loop.

## Diagnostics and Inspectability

Morphy has structured diagnostics on both the server and browser sides. These diagnostics are controlled by configuration and runtime overrides. They are intended to make a highly dynamic system legible. This is especially important because a metamorphic system can otherwise feel random or magical in the bad sense. Morphy’s diagnostics are there to ensure that adaptation can be explained.

The UI also exposes several inspectable artifacts directly, including derived tool registries, planner rationale, planner tool traces, archetype tool traces, analysis tool traces, spend summaries, and current domain prompt/source context.

## Current Constraints

Morphy is deliberately bounded. Those bounds are not accidental limitations; they are part of the architecture.

The outer shell is not model-generated. Domain configs define scaffolding, but only within a schema the host understands. Archetypes come from a bounded vocabulary, even if panels can choose among different subsets of that vocabulary. Interactive widgets use a narrow bridge rather than arbitrary host access. Tool invocation is model-directed only where the server explicitly allows it, and always through a stable execution substrate. The server still owns persistence, refresh cadence, and datasource access.

This means Morphy is adaptive, but not unbounded. It can change its current analytical form, but only in ways the host has been built to interpret.

## Where Morphy Stands Now

At this point in the prototype, Morphy has several real metamorphic behaviors already working:

It can generate or load domain scaffolding and ground domain generation in live datasource contents. It can derive domain-specific tool registries from recipe configuration. It can use model-directed tool invocation for workspace planning, archetype selection, and panel analysis. It can run deterministic local summaries first and reserve the model for interpretation. It can select bounded presentation archetypes at runtime. It can generate or locally construct widgets per run. It can host interactive widgets that validate controls, refresh filtered data locally, and optionally reinterpret filtered views with a model call.

At the same time, several larger future directions remain open. The archetype vocabulary is still somewhat biased by the current HPC example. Code Interpreter is planned but not yet active. Codex App Server integration remains out of scope for now. And the long-term question of how far Morphy should go toward generated interactive workflows versus deterministic host templates is still an active design space.

What is important is that the current architecture has a coherent answer to the original design challenge. Morphy is becoming a system where prompt-generated domain form, stable local computation, bounded model reasoning, and browser-side presentation can all cooperate without collapsing into either a fixed dashboard or an unconstrained agent shell.
