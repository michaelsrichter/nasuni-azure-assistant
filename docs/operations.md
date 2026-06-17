# Operations

## Architecture summary

The chatbot is a Foundry hosted agent in front of an Azure AI Search knowledge base. The browser streams Server-Sent Events from the agent through an nginx + Node token-proxy pair in a single Azure Container App. There is no separate backend API. See [architecture.md](architecture.md) for the full picture.

## Provisioning the Knowledge Base

All `ensure-*` commands are idempotent and re-runnable. State is persisted to `state.json` at the repo root (gitignored).

```bash
# create/detect AI Search, assign roles, connect to the Foundry project
dotnet run --project infra/Demo1.Infra -- ensure-search

# create the knowledge source + knowledge base
dotnet run --project infra/Demo1.Infra -- ensure-kb

# smoke-test the KB via a real retrieval round-trip
dotnet run --project infra/Demo1.Infra -- ensure-agent

# all three in sequence
dotnet run --project infra/Demo1.Infra -- ensure-all
```

The hosted agent itself is built and deployed by `./deploy/deploy-aca.sh`; it is not provisioned by the infra console.

## Running locally

```bash
# terminal A — hosted agent (port 8088)
cd hosted-agent
cp .env.example .env   # then edit
dotnet run

# terminal B — token-proxy sidecar (port 8090)
cd frontend/proxy
npm install
FOUNDRY_AGENT_ENDPOINT=http://127.0.0.1:8088 FOUNDRY_TOKEN_SCOPE= node server.mjs

# terminal C — Vite dev server (port 5173)
cd frontend
npm install
npm run dev
```

For local development the agent requires `x-agent-user-isolation-key` and `x-agent-chat-isolation-key` headers on every request. The sidecar injects sensible defaults (`client-<ip>` / `chat-<session>`); when calling the agent directly with `curl`, supply your own.

`hosted-agent/.env` must contain:

```bash
FOUNDRY_PROJECT_ENDPOINT=https://researchfoundry.services.ai.azure.com/api/projects/researchProject
AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4.1-mini
DEMO1_SEARCH_ENDPOINT=https://srch-demo1-d9129d.search.windows.net
DEMO1_KNOWLEDGE_BASE_NAME=kb-mslearn
```

Local auth is `DefaultAzureCredential` — `az login` is sufficient if your principal has the same RBAC the deployed SAMI gets (see *Deploying* below).

## Deploying to Azure Container Apps

One command builds three images via ACR Tasks and deploys two container apps:

```bash
./deploy/deploy-aca.sh
```

| Resource | Default |
| --- | --- |
| Resource group | `rg-demo1-aca` |
| Region | `westcentralus` |
| Managed environment | `cae-demo1-standard` |
| Container registry | `acrdemo1<hex>` (Basic SKU, admin-enabled, auto-named) |
| Hosted-agent app | `hosted-agent` (internal ingress, port 8088, SAMI) |
| Frontend app | `chatbot-web` (external ingress, multi-container: `nginx` + `token-proxy`) |

Overrides via env vars: `RESOURCE_GROUP`, `LOCATION`, `ENV_NAME`, `ENV_MODE` (`standard` or `express`), `AGENT_APP`, `FRONTEND_APP`, `AZURE_AI_MODEL_DEPLOYMENT_NAME`, `DEMO1_SEARCH_ENDPOINT`, `DEMO1_KNOWLEDGE_BASE_NAME`, `FOUNDRY_PROJECT_ENDPOINT`.

What the script does, in order:

1. Ensures the resource group, ACA environment, and ACR exist.
2. Builds three images: `hosted-agent`, `chatbot-web` (nginx + SPA), `token-proxy`.
3. Creates/updates the `hosted-agent` Container App with **internal** ingress on port 8088, assigns a SAMI, and sets the four required env vars.
4. Grants the hosted-agent SAMI:
   - On the Foundry **account**: `Cognitive Services OpenAI User`, `Cognitive Services User`.
   - On the Foundry **project**: `Cognitive Services User`.
   - On the **Search** service: `Search Index Data Reader` (for `KB.Retrieve`) and `Search Service Contributor` (so the SDK can resolve the KB definition).
5. Renders a YAML spec describing the multi-container `chatbot-web` app (`nginx` + `token-proxy`) and applies it with `az containerapp update --yaml`. The sidecar's `FOUNDRY_AGENT_ENDPOINT` is set to the hosted-agent's internal FQDN; `FOUNDRY_TOKEN_SCOPE` is empty (no Entra token required for ACA-internal calls).

### Verifying the deploy

```bash
# Stream a question end-to-end through the public ingress (SSE)
curl -N -X POST https://chatbot-web.<env-default-domain>/api/responses \
  -H 'Content-Type: application/json' \
  -d '{"input":"What is Azure Blob Storage in one sentence?","stream":true}' \
  | grep -E "^event:"
```

You should see the full event sequence ending in `response.completed`. The agent's portal view (Foundry → project → Agents → Hosted) lists the agent and the function-tool definition. Per-thread runs are visible there as well.

### Container logs

```bash
az containerapp logs show -n hosted-agent  -g rg-demo1-aca --tail 80 --format text
az containerapp logs show -n chatbot-web   -g rg-demo1-aca --tail 80 --format text \
  --container token-proxy
```

## Token usage + cost

Every assistant turn ends with a footer like `4,295 in · 88 out · $0.00188 · 1234 ms · gpt-4.1-mini`. Token counts come from the agent's `response.completed` event (`usage.input_tokens` and `usage.output_tokens`); cost is a *list-price* estimate computed in [frontend/src/pricing.ts](../frontend/src/pricing.ts). Update the table there when you swap models or when Microsoft revises prices; the comment in that file pins the verification date and source URL.

## Inspecting traces

Set `APPLICATIONINSIGHTS_CONNECTION_STRING` on the `hosted-agent` Container App; the runtime emits GenAI spans automatically. Then in App Insights:

```kusto
// All Responses calls in the last hour
dependencies
| where timestamp > ago(1h)
| where customDimensions["gen_ai.system"] == "az.ai.openai"
| project timestamp, name, duration, success, customDimensions

// Tool calls
dependencies
| where timestamp > ago(1h)
| where name contains "knowledge_base_search" or customDimensions["gen_ai.operation.name"] == "execute_tool"
| project timestamp, name, duration, customDimensions
```

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ensure-search` fails with `RoleAssignmentExists` | Race between two runs | Safe to ignore; the second run logs `already assigned` |
| `ensure-kb` hangs > 2 min | KB validating MCP endpoint | Wait — the MS Learn MCP endpoint is the gating dependency |
| `KB returned 0 references` in `ensure-agent` smoke test | KB's AzureOpenAI vectorizer pointed at `cognitiveservices.azure.com` instead of `openai.azure.com` | Re-run `ensure-kb` — the command uses the correct host. The cognitive-services host returns 401 because the Foundry account has `disableLocalAuth=true` and the bearer audience does not match. |
| Agent returns 500 with `HostedSessionIsolationKeyProvider returned null` (local dev) | The Foundry runtime auto-injects isolation headers in production but not when called by raw `curl`. | Add `x-agent-user-isolation-key: localdev-user` and `x-agent-chat-isolation-key: localdev-chat-N` on the request. The sidecar does this automatically when called from the SPA. |
| First few deltas arrive but UI freezes | A proxy or CDN is buffering SSE | Verify nginx has `proxy_buffering off; chunked_transfer_encoding on; proxy_read_timeout 600s;` for `location = /api/responses`. The sidecar already sets `x-accel-buffering: no` and `cache-control: no-cache, no-transform`. |
| Sidecar logs `Failed to acquire token from DefaultAzureCredential` | `FOUNDRY_TOKEN_SCOPE` is set, but the SAMI has no permission for that audience | Either grant the SAMI the role on the agent's resource, or set `FOUNDRY_TOKEN_SCOPE=` (empty) when the agent is on an ACA-internal endpoint that doesn't require auth |
| `/api/responses` returns 403 immediately after deploy | RBAC not yet propagated to the agent's SAMI | Wait 5–10 min and retry. Verify with `az role assignment list --assignee <principal>` |
| Hosted-agent log: `Principal does not have access to API/Operation` on POST /responses | Token in the SAMI's in-process cache predates the role assignment | `az containerapp revision restart -n hosted-agent` |
| Agent appears under *Foundry → classic agents* but not the new Agents view | You're looking at the legacy Assistants object (`asst_*`), not the new hosted agent. The hosted agent only appears in *project → Agents → Hosted* after it is deployed with `Microsoft.Agents.AI.Foundry.Hosting`. | Deploy with `./deploy/deploy-aca.sh` (or push the manifest in [hosted-agent/agent.manifest.yaml](../hosted-agent/agent.manifest.yaml) once the Foundry-managed hosting path is GA) |
| UI shows tool pill but no text, then errors | Model is calling the tool but the tool output is unparseable | Check the agent log: `KnowledgeBaseSearchTool.SearchAsync` truncates each snippet to 1500 chars + `…`; if you see exceptions, validate the KB's response shape with `ensure-agent` |
| Frontend test failure on `ReadableStream` undefined | jsdom version older than 22 doesn't have streams | Use `jsdom ^29` (already pinned in `frontend/package.json`) |
| Usage footer shows `—` for cost | The model returned by `response.completed` isn't in `MODEL_PRICES` | Add the model to [frontend/src/pricing.ts](../frontend/src/pricing.ts) with current list prices |
