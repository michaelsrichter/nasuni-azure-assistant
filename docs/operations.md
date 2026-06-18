# Operations

## Architecture summary

The chatbot is a Foundry **hosted agent** in front of an Azure AI Search knowledge base. The agent runs inside **Foundry's Hosted Agent Service**; the only thing in our Azure Container App is the frontend (nginx + a Node token-proxy). The browser streams Server-Sent Events from the Foundry agent through the proxy. There is no backend API. See [architecture.md](architecture.md) for the full picture.

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

The hosted agent itself is built and deployed to Foundry's Hosted Agent Service by `./deploy/deploy-agent.sh`; it is not provisioned by the infra console.

## Running locally

```bash
# terminal A — hosted agent (port 8088)
cd hosted-agent
cp .env.example .env   # then edit
dotnet run

# terminal B — token-proxy sidecar (port 8090)
cd frontend/proxy
npm install
FOUNDRY_AGENT_ENDPOINT=http://127.0.0.1:8088 \
  FOUNDRY_TOKEN_SCOPE= \
  INJECT_ISOLATION_KEYS=true \
  node server.mjs

# terminal C — Vite dev server (port 5173)
cd frontend
npm install
npm run dev
```

For local development the agent runs as a plain container whose in-memory session provider requires `x-agent-user-isolation-key` and `x-agent-chat-isolation-key` headers on every request. Setting `INJECT_ISOLATION_KEYS=true` makes the sidecar derive sensible defaults (`client-<ip>` / `chat-<session>`); when calling the agent directly with `curl`, supply your own. The Foundry Hosted Agent Service manages sessions itself, so these headers are **not** sent in production.

`hosted-agent/.env` must contain:

```bash
FOUNDRY_PROJECT_ENDPOINT=https://researchfoundry.services.ai.azure.com/api/projects/researchProject
AZURE_AI_MODEL_DEPLOYMENT_NAME=gpt-4.1-mini
DEMO1_SEARCH_ENDPOINT=https://srch-demo1-d9129d.search.windows.net
DEMO1_KNOWLEDGE_BASE_NAME=kb-mslearn
```

Local auth is `DefaultAzureCredential` — `az login` is sufficient if your principal has the same RBAC the deployed SAMI gets (see *Deploying* below). In Azure the agent and sidecar use `ManagedIdentityCredential` directly (gated by `AZURE_USE_MANAGED_IDENTITY=true`) to avoid the credential-chain probing on cold start.

## Deploying

Deployment has **two halves**: the agent goes to Foundry's Hosted Agent Service, and the frontend goes to Azure Container Apps. Run them in order.

### 1. Deploy the agent to Foundry Agent Service

```bash
# one-time: install the azd agent extension
azd extension install azure.ai.agents

# build the image, register a Hosted agent version, wait for `active`
./deploy/deploy-agent.sh
```

Prerequisites: `azd` 1.25.3+, `az login` / `azd auth login` as a principal with **Foundry Project Manager** at the project scope, and the Search service + Knowledge Base already provisioned (`ensure-search` / `ensure-kb`).

What the script does, in order:

1. Ensures the azd environment exists and records the agent's parameters (`AZURE_AI_MODEL_DEPLOYMENT_NAME`, `DEMO1_SEARCH_ENDPOINT`, `DEMO1_KNOWLEDGE_BASE_NAME`).
2. `azd ai agent init -m hosted-agent/agent.manifest.yaml --agent-name demo1-kb-mslearn` — scaffolds `azure.yaml` + `agent.yaml`. Pass `FOUNDRY_PROJECT_ID=<arm-id>` to run non-interactively; otherwise it prompts for tenant/subscription/project.
3. `azd provision` — creates the ACR, Application Insights, and Log Analytics, and wires the project connections.
4. `azd deploy` — builds the image, pushes it, registers a Hosted agent version, and waits for `active`. It prints the agent's playground link and Responses endpoint.
5. Grants the platform-created **agent identity** `Search Index Data Reader` + `Search Service Contributor` on the Search service (azd handles model + ACR + project access; the Search-tool access is the one thing it can't infer). Set `AGENT_PRINCIPAL_ID=<object-id>` (from *portal → Agents → demo1-kb-mslearn → Identity*) to automate this; otherwise the script prints the manual command.

The agent now appears in the Foundry portal under *project → Agents → demo1-kb-mslearn* (Type `hosted`). Smoke-test it without the frontend:

```bash
azd ai agent invoke "What is Azure Blob Storage in one sentence?"
azd ai agent monitor --follow      # live container logs
```

Capture the Responses URL it prints — you feed it to the frontend deploy:
`https://<account>.services.ai.azure.com/api/projects/<project>/agents/demo1-kb-mslearn/endpoint/protocols/openai/responses?api-version=v1`

### 2. Deploy the frontend to Azure Container Apps

```bash
FOUNDRY_AGENT_RESPONSES_URL="<the URL from step 1>" ./deploy/deploy-aca.sh
# or, if you use the default account/project/agent names, just:
./deploy/deploy-aca.sh
```

| Resource | Default |
| --- | --- |
| Resource group | `rg-demo1-aca` |
| Region | `westcentralus` |
| Managed environment | `cae-demo1-standard` |
| Container registry | `acrdemo1<hex>` (Basic SKU, admin-enabled, auto-named) |
| Frontend app | `chatbot-web` (external ingress, multi-container: `nginx` + `token-proxy`, SAMI) |

Overrides via env vars: `RESOURCE_GROUP`, `LOCATION`, `ENV_NAME`, `ENV_MODE` (`standard` or `express`), `FRONTEND_APP`, `FOUNDRY_AGENT_RESPONSES_URL`, `FOUNDRY_ACCOUNT_NAME`, `FOUNDRY_PROJECT_NAME`, `AGENT_NAME`, `FOUNDRY_TOKEN_SCOPE`.

What the script does, in order:

1. Ensures the resource group, ACA environment, and ACR exist.
2. Builds **two** images: `chatbot-web` (nginx + SPA) and `token-proxy`.
3. Renders a YAML spec for the multi-container `chatbot-web` app (`nginx` + `token-proxy`, `identity: SystemAssigned`) and applies it with `az containerapp create/update --yaml`. The sidecar gets `FOUNDRY_AGENT_RESPONSES_URL` (the Foundry agent endpoint) and `FOUNDRY_TOKEN_SCOPE=https://ai.azure.com/.default`.
4. Grants the frontend SAMI **Azure AI User** (Foundry User) at the **project** scope — the data-plane role required to invoke a hosted agent. That is the only role the frontend needs.

### Verifying the deploy

```bash
# Stream a question end-to-end through the public ingress (SSE)
curl -N -X POST https://chatbot-web.<env-default-domain>/api/responses \
  -H 'Content-Type: application/json' \
  -d '{"input":"What is Azure Blob Storage in one sentence?","stream":true}' \
  | grep -E "^event:"
```

You should see the full event sequence ending in `response.completed`. The agent's portal view (Foundry → project → Agents → demo1-kb-mslearn) lists the agent, its versions, and the function-tool definition.

### Container logs

```bash
# Frontend (nginx + sidecar) — in Azure Container Apps
az containerapp logs show -n chatbot-web -g rg-demo1-aca --tail 80 --format text \
  --container token-proxy

# Agent — in Foundry Hosted Agent Service
azd ai agent monitor --follow
```

## Token usage + cost

Every assistant turn ends with a footer like `4,295 in · 88 out · $0.00188 · 1234 ms · gpt-4.1-mini`. Token counts come from the agent's `response.completed` event (`usage.input_tokens` and `usage.output_tokens`); cost is a *list-price* estimate computed in [frontend/src/pricing.ts](../frontend/src/pricing.ts). Update the table there when you swap models or when Microsoft revises prices; the comment in that file pins the verification date and source URL.

## Inspecting traces

Foundry's Hosted Agent Service injects `APPLICATIONINSIGHTS_CONNECTION_STRING` into the agent container automatically, so the runtime emits GenAI spans without any extra wiring. Open the Application Insights resource provisioned by `azd provision` and run:

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

## Evaluating answer quality

The [eval/](../eval) harness scores the assistant with Azure AI Foundry's
**built-in quality evaluators** and (by default) logs the run to the Foundry
project so it shows up under the portal's **Evaluations** tab.

It uses the three RAG-relevant built-ins:

| Evaluator | What it checks | Inputs |
| --- | --- | --- |
| **Groundedness** | Is the answer supported by the retrieved knowledge-base context? | query, response, context |
| **Relevance** | Does the answer actually address the question? | query, response |
| **Retrieval** | Did `knowledge_base_search` return relevant, well-ranked context? | query, context |

For each prompt in [eval/dataset.jsonl](../eval/dataset.jsonl) the harness calls
the deployed agent's non-streaming Responses endpoint, extracts the answer plus
the citations the agent retrieved, then runs the evaluators (a `gpt-4.1-mini`
judge) and uploads the results.

```bash
cd eval
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in / confirm the values, then:

python run_eval.py            # full run, logged to the Foundry portal (prints a studio_url)
python run_eval.py --limit 3  # cheaper smoke test (first 3 prompts)
python run_eval.py --no-upload  # score locally, do not upload
python run_eval.py --prep-only  # only call the agent + build eval input, skip judging
```

The judge model and result upload authenticate with Entra ID (`az login`) by
default — leave `AZURE_OPENAI_API_KEY` blank to stay keyless. Point
`AGENT_API_URL` at `http://127.0.0.1:8090/api/responses` to evaluate a locally
running agent instead of the deployed one. Per-row eval inputs are written to
`eval/results/` (gitignored). These runs call the judge model and the agent, so
they incur consumption-based billing.

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ensure-search` fails with `RoleAssignmentExists` | Race between two runs | Safe to ignore; the second run logs `already assigned` |
| `ensure-kb` hangs > 2 min | KB validating MCP endpoint | Wait — the MS Learn MCP endpoint is the gating dependency |
| `KB returned 0 references` in `ensure-agent` smoke test | KB's AzureOpenAI vectorizer pointed at `cognitiveservices.azure.com` instead of `openai.azure.com` | Re-run `ensure-kb` — the command uses the correct host. The cognitive-services host returns 401 because the Foundry account has `disableLocalAuth=true` and the bearer audience does not match. |
| Agent returns 500 with `HostedSessionIsolationKeyProvider returned null` (local dev) | A locally-run agent container needs the isolation headers; you called it with raw `curl` (or without `INJECT_ISOLATION_KEYS=true`). The Foundry Hosted Agent Service injects them in production. | Add `x-agent-user-isolation-key: localdev-user` and `x-agent-chat-isolation-key: localdev-chat-N` on the request, or run the sidecar with `INJECT_ISOLATION_KEYS=true`. |
| First few deltas arrive but UI freezes | A proxy or CDN is buffering SSE | Verify nginx has `proxy_buffering off; chunked_transfer_encoding on; proxy_read_timeout 600s;` for `location = /api/responses`. The sidecar already sets `x-accel-buffering: no` and `cache-control: no-cache, no-transform`. |
| Sidecar logs `Failed to acquire token for the Foundry agent endpoint` | The frontend SAMI can't get a token for `https://ai.azure.com/.default` | Confirm the frontend app has a system-assigned identity and that **Azure AI User** is assigned at the project scope. Locally, run `az login` (and set `FOUNDRY_TOKEN_SCOPE=` empty when targeting a local agent). |
| `/api/responses` returns 403 immediately after deploy | RBAC not yet propagated to the frontend SAMI | Wait 5–10 min and retry. Verify with `az role assignment list --assignee <principal> --scope <project-id>` |
| Agent provisioning fails with `image_pull_failed` | The project managed identity can't pull from ACR | Confirm `Container Registry Repository Reader` on the ACR for the project MI and that the registry's `azureADAuthenticationAsArmPolicy` is `enabled` (azd normally handles this) |
| Agent answers but every tool call returns 0 citations / 403 | The platform-created **agent identity** lacks Search access | Grant `Search Index Data Reader` + `Search Service Contributor` to the agent identity on the Search service (see *Deploy the agent*, step 5) |
| Agent appears under *Foundry → classic agents* but not the new Agents view | You're looking at a legacy Assistants object (`asst_*`), not the new hosted agent. The hosted agent appears in *project → Agents* (Type `hosted`) only after `azd deploy` registers a version. | Run `./deploy/deploy-agent.sh` |
| UI shows tool pill but no text, then errors | Model is calling the tool but the tool output is unparseable | Check the agent log: `KnowledgeBaseSearchTool.SearchAsync` truncates each snippet to 1500 chars + `…`; if you see exceptions, validate the KB's response shape with `ensure-agent` |
| Frontend test failure on `ReadableStream` undefined | jsdom version older than 22 doesn't have streams | Use `jsdom ^29` (already pinned in `frontend/package.json`) |
| Usage footer shows `—` for cost | The model returned by `response.completed` isn't in `MODEL_PRICES` | Add the model to [frontend/src/pricing.ts](../frontend/src/pricing.ts) with current list prices |
