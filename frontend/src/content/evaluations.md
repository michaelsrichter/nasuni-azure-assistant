## Why evaluate a RAG assistant?

This assistant answers questions by **retrieving** Nasuni and Microsoft Learn
documentation and then **generating** a grounded answer with citations. That
retrieval‑augmented‑generation (RAG) pattern is powerful, but it can fail in
quiet, hard‑to‑spot ways:

- The model can **hallucinate** — state something the sources never say.
- The search can **miss** — return weak or off‑topic context, so the answer is
  built on a shaky foundation.
- The answer can **drift** — be fluent and confident yet not actually address
  the question that was asked.

You cannot ship an enterprise assistant on vibes. **Evaluation turns "it seems
to work" into a measurable, repeatable quality bar** you can track release over
release, catch regressions before customers do, and show stakeholders with
numbers instead of anecdotes.

## What this evaluation does

For every prompt in the benchmark dataset, the harness:

1. Calls the **deployed agent's** Responses endpoint — the same path the chat UI
   uses — and captures the answer plus the knowledge‑base context it retrieved.
2. Sends each `(question, answer, retrieved context)` row to Microsoft Foundry's
   built‑in **AI‑assisted evaluators**, which use a judge model to score quality
   on three axes that matter most for RAG:

| Evaluator | Question it answers |
| --- | --- |
| **Groundedness** | Is every claim in the answer supported by the retrieved context? (catches hallucination) |
| **Relevance** | Does the answer actually address the question that was asked? |
| **Retrieval** | Did the knowledge‑base search return relevant, well‑ranked context to begin with? |

Each row gets a pass/fail and a score, and the run rolls up to aggregate
pass rates you can trend over time.

## How Microsoft Foundry makes this easy

Foundry turns evaluation from a bespoke project into a few SDK calls:

- **Built‑in evaluators** — groundedness, relevance, retrieval (and many more)
  ship as managed `builtin.*` evaluators. No prompt‑engineering your own judge,
  no rubric to maintain.
- **The Foundry evaluations API** (the OpenAI Evals surface exposed by
  `azure-ai-projects`) versions your dataset, runs the evaluators against a judge
  model deployment, and stores every result — all keyless via Microsoft Entra ID
  managed identity, so there are no API keys to leak.
- **The Foundry portal** renders each run as a shareable report with per‑row
  scores and judge reasoning, so anyone on the team can inspect *why* a row
  passed or failed.
- **One code path** — the exact harness behind this page (`eval/eval_core.py`)
  also runs from the command line and in CI, so the demo, the dev loop, and your
  release gate stay in lock step.

Press **Run evaluation** to score the live agent now and watch the results stream
in. A small sample is the fastest way to see the flow end‑to‑end; the full set
gives a more stable quality signal.
