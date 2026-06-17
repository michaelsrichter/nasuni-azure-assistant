# Operations

## Re-running provisioning

All `ensure-*` commands are idempotent and re-runnable. State is persisted to `state.json` at the repo root (gitignored).

```bash
# detect/create AI Search service, assign roles, connect to Foundry project
dotnet run --project infra/Demo1.Infra -- ensure-search

# create the knowledge source + knowledge base
dotnet run --project infra/Demo1.Infra -- ensure-kb

# smoke test the KB via a real retrieval round-trip
dotnet run --project infra/Demo1.Infra -- ensure-agent

# all three in sequence
dotnet run --project infra/Demo1.Infra -- ensure-all
```

Re-running `ensure-search` prints `Found existing Search service` and `Role ... already assigned` for the second invocation — proof of idempotency.

## Resetting state

```bash
rm state.json
dotnet run --project infra/Demo1.Infra -- ensure-all
```

State is reconstructed by re-querying Azure. No info is lost by deleting it.

## Running locally

```bash
# terminal A — backend
dotnet run --project backend/ChatbotApi
# terminal B — frontend
cd frontend && npm run dev
```

Backend listens on `http://localhost:5000`. Vite dev server on `http://localhost:5173` with `/api` proxied to the backend.

## Inspecting traces

Open the App Insights resource attached to the project (`appi-connection` in the Foundry project), then run:

```kusto
// All chat requests in the last hour
requests
| where timestamp > ago(1h)
| where name == "POST /api/chat"
| order by timestamp desc

// Trace tree for a single request id
union *
| where operation_Id == "<your-trace-id>"
| project timestamp, itemType, name, duration, success, customDimensions
| order by timestamp asc

// GenAI spans (KB retrieve + chat completion)
dependencies
| where timestamp > ago(1h)
| where customDimensions["gen_ai.system"] == "az.ai.openai" or name contains "knowledgebase"
| project timestamp, name, duration, customDimensions
```

The chat response body includes `traceId` so you can paste it directly into the second query.

## Evaluation runs

`POST /api/eval/run` (no body) runs the fixed 5-task evaluation set against the orchestration. The Eval panel in the UI calls the same endpoint and renders the table. Each row shows per-evaluator scores; the overall pass/fail uses the same threshold the backend applies.

## Hosted Agent deploy (Phase 9)

```bash
azd auth login
azd ai agent init \
  --src ./hosted-agent \
  --agent-name kb-mslearn-hosted \
  --deploy-mode code \
  --runtime dotnet_10 \
  --entry-point Program.cs \
  --dep-resolution remote_build
azd deploy
```

After deploy, set `HOSTED_AGENT_NAME=kb-mslearn-hosted` on the backend and restart — the backend will route via the Responses API to the hosted agent instead of orchestrating in-process. The UI is unchanged.

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ensure-search` fails with `RoleAssignmentExists` | Race between two runs | Safe to ignore; the second run logs `already assigned` |
| `ensure-kb` hangs > 2 min | KB validating MCP endpoint | Wait — the MS Learn MCP endpoint is the gating dependency |
| Chat returns empty answer with `traceId` | KB retrieval succeeded but model declined | Check system prompt; check `gen_ai.completion` in the trace |
| `/api/chat` returns 401 | Stale `az login` | `az login --tenant <tenant>` and restart backend |
| Eval page shows all `null` | Evaluator deployment not provisioned in the project | Confirm `gpt-4.1-mini` deployment exists |
