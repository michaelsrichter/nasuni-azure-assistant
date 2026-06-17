# Demo1 — Foundry Hosted Agent + MS Learn Knowledge Base

A streaming chatbot demo built on a **Microsoft Foundry hosted agent** that grounds every answer in the **MS Learn MCP server** via a Foundry **Knowledge Base**. React SPA + .NET 10 hosted agent + Node token-proxy sidecar, all deployable to Azure Container Apps with one script. The browser streams Server-Sent Events end-to-end, with live tool pills and per-turn token-usage + cost.

> Acceptance: ask a question on the deployed `chatbot-web` site. The agent calls `knowledge_base_search`, the KB queries the MS Learn MCP server, the model writes an answer with `[n]` citations, and the UI shows tokens-in / tokens-out / estimated cost the moment the stream completes.

## Architecture

```mermaid
flowchart LR
    U[User] -->|streams| NGX[nginx :8080]
    NGX -- 127.0.0.1:8090 --> PRX[token-proxy<br/>Node sidecar]
    PRX --> AG[Hosted Agent<br/>Demo1.Agent :8088]
    AG --> KB[(Knowledge Base<br/>kb-mslearn)]
    KB --> MCP[MS Learn MCP]
    AG --> M[gpt-4.1-mini]
```

There is **no backend API**. The hosted agent owns the system prompt, the `knowledge_base_search` function tool, and the streaming `/responses` endpoint. The sidecar attaches a workload-identity bearer (or none, in ACA-internal mode) so the browser can never see credentials.

See [docs/architecture.md](docs/architecture.md) for the full picture, including the streaming-event contract and the KB endpoint pitfall that caused the historical 401.

## Layout

```
demo1/
  hosted-agent/    .NET 10 Foundry hosted agent (Demo1.Agent)
    Program.cs       AgentHost + Foundry Responses + function tool
    Tools/           KnowledgeBaseSearchTool + KbCitationParser
    Instructions.cs  System prompt (call KB first, cite every fact)
    Dockerfile       aspnet:10.0 multi-stage
    agent.manifest.yaml   Foundry-managed-hosting manifest (forward-looking)
  frontend/
    src/             React SPA (streaming chat, tool pills, usage footer)
    src/streaming/   SSE parser
    src/api/         streamChat() async iterator
    src/pricing.ts   List-price table + estimateCost()
    src/test/        Vitest cases (17 passing)
    proxy/           Node token-proxy sidecar (server.mjs + Dockerfile)
    Dockerfile       nginx + Vite bundle
    nginx.conf.template  /api/responses → 127.0.0.1:8090 (buffering off)
  infra/Demo1.Infra/  .NET 10 console: ensure-search / ensure-kb / ensure-agent
  deploy/deploy-aca.sh  One-command ACR build + multi-container ACA deploy
  docs/               architecture.md, operations.md, testing.md
  state.json          Persisted resource IDs (gitignored)
```

## Prerequisites

- .NET SDK 10
- Node 20+
- Azure CLI 2.86+ with the `containerapp` extension
- `az login` against a subscription that has the Foundry account
- A Foundry project — defaults point at `researchfoundry / researchProject`. Edit [infra/Demo1.Infra/appsettings.json](infra/Demo1.Infra/appsettings.json) to point at your own.

## Quick start

```bash
# 1. provision Azure AI Search and connect it to the project (idempotent)
dotnet run --project infra/Demo1.Infra -- ensure-search

# 2. create the MCP-backed knowledge source and knowledge base
dotnet run --project infra/Demo1.Infra -- ensure-kb

# 3. smoke-test the KB retrieval path end-to-end
dotnet run --project infra/Demo1.Infra -- ensure-agent

# 4. run the hosted agent locally (port 8088)
cd hosted-agent
cp .env.example .env && $EDITOR .env
dotnet run

# 5. run the token-proxy sidecar (port 8090, no Entra token for local agent)
cd frontend/proxy && npm install
FOUNDRY_AGENT_ENDPOINT=http://127.0.0.1:8088 FOUNDRY_TOKEN_SCOPE= node server.mjs

# 6. start the SPA
cd frontend && npm install && npm run dev
# open http://localhost:5173
```

## Deploying to Azure Container Apps

```bash
./deploy/deploy-aca.sh
```

Defaults: `rg-demo1-aca` / `westcentralus` / standard managed env. The script builds three images (`hosted-agent`, `chatbot-web`, `token-proxy`), deploys the agent with internal ingress, deploys `chatbot-web` as a multi-container app (`nginx` + `token-proxy`), and assigns RBAC to the agent's SAMI. See [docs/operations.md](docs/operations.md#deploying-to-azure-container-apps) for the full breakdown.

## Tests

```bash
dotnet build hosted-agent/Demo1.Agent.csproj          # agent compiles
dotnet build infra/Demo1.Infra/Demo1.Infra.csproj     # infra compiles
cd frontend && npm test                               # 17 Vitest cases
cd frontend && npm run build                          # tsc + Vite bundle
```

See [docs/testing.md](docs/testing.md) for the test matrix.

## Docs

- [docs/architecture.md](docs/architecture.md) — components, sequence diagram, streaming contract, design rationale
- [docs/operations.md](docs/operations.md) — running locally, deploying to ACA, App Insights KQL, troubleshooting matrix
- [docs/testing.md](docs/testing.md) — test layout and how to add a model

## Troubleshooting

The most common issues — `KB 0 references`, `HostedSessionIsolationKeyProvider returned null`, RBAC propagation lag, SSE buffering — are covered in the *Troubleshooting matrix* in [docs/operations.md](docs/operations.md#troubleshooting-matrix).
