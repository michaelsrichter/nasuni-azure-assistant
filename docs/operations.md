# Operations

## Hosted-agent execution model (default)

The `chatbot-api` backend runs in one of two modes, controlled by `Demo1__UseHostedAgent`:

| Mode | DI class | Flow |
| --- | --- | --- |
| `true` (default in ACA) | `AgentChatService` | UI → backend → **hosted agent** → tool-call → backend → KB → MCP → answer |
| `false` (local dev fallback) | `ChatService` | UI → backend → KB → MCP → backend LLM call → answer |

In hosted-agent mode, the backend creates a thread, posts the user's message, starts a run on `Demo1__HostedAgentId`, and polls until the run reports `RequiresAction`. The required action is a single `knowledge_base_search` function call; the backend executes it against the Knowledge Base, submits the references back as `ToolOutput`, and waits for the agent to finish writing the answer. Citations are extracted from the KB's `Response[0].Content[0].Text` JSON (see `backend/ChatbotApi/KbCitationParser.cs`).

The agent owns the system prompt, model, temperature, and citation contract — all editable from the Foundry portal under *project → Agents → kb-mslearn-hosted*. The infra command `ensure-hosted-agent` re-applies the canonical instructions and writes the agent id to `state.json`.

Required RBAC for the backend SAMI (or your local `az login` principal) is documented in *Deploying to Azure Container Apps* below.

## Re-running provisioning

All `ensure-*` commands are idempotent and re-runnable. State is persisted to `state.json` at the repo root (gitignored).

```bash
# detect/create AI Search service, assign roles, connect to Foundry project
dotnet run --project infra/Demo1.Infra -- ensure-search

# create the knowledge source + knowledge base
dotnet run --project infra/Demo1.Infra -- ensure-kb

# smoke test the KB via a real retrieval round-trip
dotnet run --project infra/Demo1.Infra -- ensure-agent

# create/update the portal-visible Foundry hosted agent (MCP-tool)
dotnet run --project infra/Demo1.Infra -- ensure-hosted-agent

# all four in sequence
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

## Foundry Hosted Agent (portal-visible, function-tool)

The repo provisions a persistent Foundry agent that appears in the portal under *project → Agents* and serves as the entrypoint for `/api/chat`:

```bash
dotnet run --project infra/Demo1.Infra -- ensure-hosted-agent
```

What it does:

- Uses `Azure.AI.Agents.Persistent` 1.2.0-beta.8 (`PersistentAgentsClient.Administration.CreateAgentAsync` / `UpdateAgentAsync`).
- Creates an agent named `kb-mslearn-hosted` (from `hostedAgentName` in [infra/Demo1.Infra/appsettings.json](infra/Demo1.Infra/appsettings.json)) using the project's `gpt-4.1-mini` deployment.
- Attaches a single `FunctionToolDefinition` named `knowledge_base_search` with a JSON-schema `{ query: string }`. The backend executes that function against the KB whenever the run reaches `RequiresAction`.
- The agent's instructions tell it to (1) call `knowledge_base_search` with a focused query, (2) answer using only the returned references, (3) cite every factual claim with `[n]`.
- Idempotent: re-running detects the existing agent by name and updates it in place. The id is persisted to `state.json` as `hostedAgentId`.

Verify in the portal: open https://ai.azure.com → project `researchProject` → **Agents**. The `kb-mslearn-hosted` row shows the function tool and the model. Tool runs and submitted outputs are visible per-thread in the *Threads* panel.

Why a function tool and not the typed `KnowledgeBaseToolDefinition`? The 1.2.0-beta.8 SDK ships a partial type, but its server-side routing is not yet enabled for our project/region. The function-tool fallback keeps the agent contract identical (single tool, JSON-schema arguments) and lets the backend authenticate to the KB as the SAMI it already has. When the typed tool is GA, this is a one-class change in `AgentChatService.cs`.

## Deploying to Azure Container Apps

One command builds and deploys both containers:

```bash
./deploy/deploy-aca.sh
```

Default resources:

| Resource | Default |
| --- | --- |
| Resource group | `rg-demo1-aca` |
| Region | `westcentralus` |
| Managed environment | `cae-demo1-standard` (standard workload profile) |
| Container registry | `caa…acr` (Basic SKU, admin-enabled, auto-named) |
| Backend app | `chatbot-api` (external ingress, port 8080, SAMI) |
| Frontend app | `chatbot-web` (external ingress, port 80, nginx) |

Overrides via env vars: `RESOURCE_GROUP`, `LOCATION`, `ENV_NAME`, `ENV_MODE` (`standard` or `express`), `BACKEND_APP`, `FRONTEND_APP`.

What the script does, in order:

1. Ensures the resource group, ACA environment, and ACR exist.
2. `az acr build` for the backend Dockerfile, then `az containerapp create` (or `update`) with the resulting image.
3. Enables a system-assigned managed identity on the backend and sets `Demo1__*` env vars — including `Demo1__UseHostedAgent=true`, `Demo1__ProjectEndpoint`, and `Demo1__HostedAgentId` (read from `infra/state.json` if present).
4. Assigns these roles to the SAMI:
   - On the Foundry **account**: `Cognitive Services OpenAI User`, `Cognitive Services User`, `Azure AI Administrator` (the last is what unblocks the agent threads/runs data action set; `Azure AI Developer` alone is not enough).
   - On the Foundry **project**: `Cognitive Services User`, `Azure AI Developer`.
   - On the **Search** service: `Search Index Data Reader` (for `KB.Retrieve`) and `Search Service Contributor` (so the SDK can resolve the KB definition).
5. `az acr build` for the frontend Dockerfile, then `az containerapp create` (or `update`) for `chatbot-web`.
6. Sets `BACKEND_URL` (full https URL) and `BACKEND_HOST` (FQDN only) on the frontend container; nginx's envsubst entrypoint stamps those into [frontend/nginx.conf.template](frontend/nginx.conf.template) at start.

### Verifying the deploy

```bash
# Backend health
curl https://chatbot-api.<env-default-domain>/health

# End-to-end through the frontend (must work — proves the nginx → HTTPS+SNI path)
curl -X POST https://chatbot-web.<env-default-domain>/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is Azure Storage?"}'
```

A successful response body includes `"source":"agent"` (the default, hosted-agent path) with non-empty `citations[]` (each row has `title`, `url`, and a `snippet`). If `"source":"knowledgeBase"` or `"mcp"` appears, the deploy is using the legacy in-process orchestration (`Demo1__UseHostedAgent` is not `true`).

### Container logs

```bash
az containerapp logs show -n chatbot-api -g rg-demo1-aca --tail 80 --format text
az containerapp logs show -n chatbot-web -g rg-demo1-aca --tail 80 --format text
```

### Why standard env (not Express)

Azure Container Apps **Express** is in preview and per [the Express overview docs](https://learn.microsoft.com/azure/container-apps/express-overview) it lists *Managed identity (app runtime)* as **In development**. The backend requires a SAMI to call Foundry and Search, so we deploy into a standard managed environment. The script can be flipped to Express (`ENV_MODE=express`) once that limitation lifts.

### Known nginx → HTTPS-upstream pitfall (SNI)

ACA's ingress is fronted by Azure Front Door, which **requires SNI** on the inbound TLS handshake. nginx's `proxy_pass https://…` upstream by default uses the resolved upstream IP as the SNI and as the `Host` header, which Front Door rejects with `peer closed connection in SSL handshake (104: Connection reset by peer)` and the frontend returns 502. The fix in `nginx.conf.template`:

```nginx
set $backend_host "${BACKEND_HOST}";
proxy_pass         ${BACKEND_URL}/api/;
proxy_set_header   Host $backend_host;
proxy_ssl_server_name on;
proxy_ssl_name        $backend_host;
```

`BACKEND_HOST` is the bare FQDN; `BACKEND_URL` is `https://<FQDN>` (full origin). The deploy script sets both via `az containerapp update --set-env-vars`.

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ensure-search` fails with `RoleAssignmentExists` | Race between two runs | Safe to ignore; the second run logs `already assigned` |
| `ensure-kb` hangs > 2 min | KB validating MCP endpoint | Wait — the MS Learn MCP endpoint is the gating dependency |
| Chat returns empty answer with `traceId` | KB retrieval succeeded but model declined | Check system prompt; check `gen_ai.completion` in the trace |
| `/api/chat` returns 401 | Stale `az login` (local) or RBAC not yet propagated (ACA) | `az login --tenant <tenant>` and restart; in ACA, wait 5–10 min after first deploy |
| `/api/chat` returns 500 with body `Principal lacks ... AIServices/agents/read` | Backend SAMI only has `Azure AI Developer`, which doesn't include the persistent-agents data action set | Grant `Azure AI Administrator` on the Foundry account and `Cognitive Services User` on both account and project; restart the revision |
| `/api/chat` returns 500 with body `Principal does not have access to API/Operation.` immediately after role grants | Token in the SAMI's in-process cache predates the role assignment | `az containerapp revision restart` (or wait for the next replica restart). Re-tokens are fetched on-demand but cached ones are not invalidated. |
| `KB returned 0 references` in `ensure-agent` smoke test | KB's AzureOpenAI vectorizer pointed at `cognitiveservices.azure.com` instead of `openai.azure.com` | Re-run `ensure-kb` — the `EnsureKnowledgeBaseCommand` now uses the correct host. The cognitive-services host returns 401 because the Foundry account has `disableLocalAuth=true` and the bearer audience does not match. |
| Eval page shows all `null` | Evaluator deployment not provisioned in the project | Confirm `gpt-4.1-mini` deployment exists |
| Frontend in ACA returns 502 on `POST /api/chat` while backend `curl` works | nginx not sending SNI to ACA ingress | Confirm `BACKEND_HOST` is set (FQDN, no scheme) and that `proxy_ssl_server_name on; proxy_ssl_name $backend_host;` is in `nginx.conf.template`; redeploy frontend |
| `az containerapp up --source` fails with `'NoneType' object has no attribute 'linux'` | Regression in `containerapp` CLI extension 1.3.0b4 | Use `deploy/deploy-aca.sh` (which uses `az acr build` + `containerapp create/update` explicitly) |
| ACA backend logs show `Cognitive Services OpenAI`/Search `Forbidden` immediately after deploy | RBAC not yet propagated to SAMI | Wait 5–10 min and retry; verify with `az role assignment list --assignee <principal>` |
| `kb-mslearn-hosted` agent missing from portal | `ensure-hosted-agent` not run | `dotnet run --project infra/Demo1.Infra -- ensure-hosted-agent` |
| Response has `"source":"knowledgeBase"` or `"mcp"` instead of `"agent"` | `Demo1__UseHostedAgent` is not `true`, or `Demo1__HostedAgentId` is empty | Set both env vars and restart the revision; deploy script does this automatically |
