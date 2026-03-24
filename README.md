# Morphy

Morphy is a config-driven analytical web app built with Node.js and Express. It provides a single browser application that can project multiple domain-specific front ends over heterogeneous data sources while delegating live analytical reasoning to an embedded server-side agent runtime.

## What is implemented

- Config-driven domain registry in `data/domains/*.json`
- Config-driven data-source registry in `config/data-sources.json`
- Pluggable source previews for:
  - JSON object stores
  - VictoriaMetrics-compatible time-series endpoints
  - Relational summary stubs
- Agent-backed domain generation from a prompt
- Agent-backed report generation per scaffolded panel
- Generated browser widget artifacts per completed panel run
- Persistent run/session state in `data/state`
- Live browser updates through server-sent events
- A modern, responsive UI with reserved chart/report panels

## Runtime model

The server centers on an `AgentRuntime` abstraction in `src/services/agent-runtime.js`.

- If `OPENAI_API_KEY` is set, Morphy uses the OpenAI Responses API through the `openai` Node SDK.
- If no API key is present, Morphy falls back to local synthesized reports so the app remains explorable.
- Agent state is persisted per domain through the last response id in `data/state/agent-sessions.json`.
- Analysis runs are persisted as JSON files in `data/state/runs`.
- Generated widget bundles are persisted in `data/state/widget-bundles`, with metadata indexed in `data/state/widgets/index.json`.

## Generated browser widgets

Each completed run can produce a browser-executable artifact bundle:

- `index.html` is a stable iframe host document
- `styles.css` styles the generated visualization
- `widget.js` renders the view using a host bridge
- `manifest.json` records metadata, sandbox mode, and bundle provenance

The host application renders these artifacts in sandboxed iframes and passes scoped panel payloads via `postMessage`. Generated widgets never receive database credentials directly; they receive domain, panel, report, and preview context from the host app.

## Run it

1. Install dependencies:

```bash
npm install
```

2. Optionally export an API key:

```bash
export OPENAI_API_KEY=your_key_here
```

3. Start the app:

```bash
npm start
```

4. Open `http://localhost:3000`

## Config model

### Data source example

```json
{
  "id": "victoria-cluster",
  "name": "VictoriaMetrics HPCFund Cluster",
  "type": "victoria-metrics",
  "baseUrl": "http://127.0.0.1:9090",
  "defaultEvaluationTime": "2026-03-24T23:59:59Z",
  "start": "2026-03-01T00:00:00Z",
  "end": "2026-03-24T23:59:59Z",
  "queries": {
    "pendingJobsByPartition": "sort_desc(last_over_time(slurm_partition_jobs_pending[30d]))",
    "hotGpusByTemperature": "topk(10, max by(instance,card) (last_over_time(rocm_temperature_celsius[7d])))"
  }
}
```

For historical datasets, `start`, `end`, and `defaultEvaluationTime` matter. Without an explicit time window, Morphy may query a valid VictoriaMetrics endpoint and still see an apparently empty dataset if the capture is not current.

### Domain example

```json
{
  "id": "hpcfund-cluster-observability",
  "name": "HPCFund Cluster Observability",
  "description": "Historical observability domain for the HPCFund GPU cluster.",
  "dataSources": ["victoria-cluster"],
  "panels": [
    {
      "id": "fleet-health",
      "title": "Fleet Health",
      "summary": "Rank hosts by operational risk using node, scheduler, GPU, and fabric signals.",
      "analysisPrompt": "Assess overall cluster health for hpcfund and identify the highest-risk hosts.",
      "chartPreference": "bar"
    }
  ]
}
```

## HPCFund dataset notes

The included `victoria-cluster` datasource is now configured around the historical March 2026 `hpcfund` GPU cluster dataset. The metric inventory supports:

- ROCm GPU telemetry and RAS counters
- Slurm partition, node, queue, and CPU allocation state
- Node exporter host, memory, storage, and InfiniBand metrics
- `rmsjob_info` job-to-node-to-user correlation

The domain config in `data/domains/hpcfund-cluster-observability.json` is the recommended starting point for exploring that dataset in Morphy.

## Next steps

- Replace the relational stub with real database adapters such as PostgreSQL or MySQL.
- Add richer query planning tools so the agent can selectively fetch large datasets instead of only previewing them.
- Add stricter static analysis and CSP enforcement for generated widget artifacts before serving them.
- Introduce authentication, tenant isolation, and approval flows before allowing live config edits in production.
- Add a pre-generation CLI that materializes domain scaffolding from saved prompts.
