# Testing

## Test matrix

| Project | Layer | Framework | Covers |
| --- | --- | --- | --- |
| `infra/Demo1.Infra` | infra | `dotnet build` + `ensure-*` smoke run | Real provisioning (idempotent) — the commands themselves are the test |
| `hosted-agent/` | agent | `dotnet build` + `azd ai agent invoke` (Foundry) or curl-based smoke against a local `/responses` | Function-tool routing, citation parsing, streaming SSE contract |
| `frontend/src/test/sse.test.ts` | UI | Vitest | SSE parser handles chunk boundaries, multi-line `data`, CRLF, comments, default `message` event |
| `frontend/src/test/pricing.test.ts` | UI | Vitest | `estimateCost` math, `formatCost` formatting, unknown-model fallback |
| `frontend/src/test/ChatPanel.test.tsx` | UI | Vitest + Testing Library | Streams a real `ReadableStream` of SSE frames into the panel; asserts tool pill, citation links, and usage footer render |

## Running

```bash
# Hosted-agent build + (optional) local smoke
cd hosted-agent
dotnet build
dotnet run                       # then curl /responses as documented in operations.md

# Or invoke the deployed Foundry agent directly (no frontend needed)
azd ai agent invoke "What is Azure Blob Storage in one sentence?"

# Infra tool
dotnet build infra/Demo1.Infra/Demo1.Infra.csproj

# Frontend (typecheck + Vite bundle + 17 Vitest cases)
cd frontend
npm install
npm run build                    # tsc -b && vite build
npm test                         # vitest run
```

## Guidelines

- Tests must not call real Azure services. The SSE tests stream synthetic frames via `ReadableStream`; the pricing tests use the static rate table directly.
- The frontend's `ChatPanel.test.tsx` is the contract test for the streaming event shape; if you change `frontend/src/api/streamChat.ts`, the fixture in the test must be updated to match the new event mapping.
- The hosted-agent's smoke test is documented under *Verifying the deploy* in [operations.md](operations.md) — it doubles as the end-to-end test, since the agent is the only orchestration surface. Against the deployed Foundry agent, `azd ai agent invoke` is the quickest one-shot check.

## Adding a model

1. Add the model deployment name to `MODEL_PRICES` in [frontend/src/pricing.ts](../frontend/src/pricing.ts) with current per-1M-token list prices. Update the verification-date comment.
2. Add a case to [frontend/src/test/pricing.test.ts](../frontend/src/test/pricing.test.ts).
3. Update the hosted-agent env var `AZURE_AI_MODEL_DEPLOYMENT_NAME` (locally via `hosted-agent/.env`, in production via `./deploy/deploy-aca.sh`).
