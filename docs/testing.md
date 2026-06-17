# Testing

## Test matrix

| Project | Layer | Framework | Covers |
| --- | --- | --- | --- |
| `tests/Demo1.Infra.Tests` | infra | xUnit + Moq | Config load/save round-trip, state persistence, command argument routing, role-assignment idempotency logic (with mocked ARM) |
| `tests/ChatbotApi.Tests` | backend | xUnit + Moq | `IChatService.AnswerAsync` happy path (KB called → grounding injected), KB error path (returns 502 with diagnostic body), `IAppInsightsResolver` discovery, eval service result shaping |
| `tests/HostedAgent.Tests` | hosted agent | xUnit + Moq | Same `IChatService` shape as backend, exercised through the agent's request handler |
| `frontend/src/__tests__/` | UI | Vitest + React Testing Library | `ChatPanel` sends request and renders tool activity; `EvalPanel` renders table and handles loading state |

## Running

```bash
# All .NET tests in one go
dotnet test demo1.sln

# Single project
dotnet test tests/ChatbotApi.Tests/ChatbotApi.Tests.csproj

# Frontend
cd frontend
npm test           # watch mode
npm run test:ci    # single pass
```

## Guidelines

- Every public method on `IChatService`, `IEvaluationService`, and infra command classes must have at least one happy-path and one failure-path test.
- Tests must not call real Azure services. Use the `Mock<KnowledgeBaseRetrievalClient>` / `Mock<ChatClient>` fakes provided in `tests/ChatbotApi.Tests/Fakes/`.
- Integration with real Foundry resources is the responsibility of the `ensure-agent` smoke command, not the unit-test suite.

## Adding a new evaluator

1. Add the evaluator id to `EvaluationService.Evaluators` (sorted alphabetically).
2. Add a fixture row to `tests/ChatbotApi.Tests/Fixtures/eval-runs.json` covering the new score path.
3. Add a `EvalPanel` test asserting the new column renders for the same fixture.
4. Update [docs/operations.md](operations.md) `Evaluation runs` section.
