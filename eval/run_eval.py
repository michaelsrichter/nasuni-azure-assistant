#!/usr/bin/env python3
"""Evaluate the Nasuni-on-Azure assistant with Microsoft Foundry built-in evaluators.

This uses the new Foundry evaluations API (the OpenAI Evals surface exposed by
``azure-ai-projects``), so runs show up under the **New Foundry portal's
Evaluations tab** (report URLs are ``ai.azure.com/nextgen/.../build/evaluations/...``).

The flow is:

1. Read prompts from ``dataset.jsonl`` (one ``{"query": "..."}`` per line).
2. Call the deployed agent's non-streaming Responses endpoint for each prompt and
   extract the answer text plus the knowledge-base context the agent retrieved.
3. Upload the (query, response, context) rows as a versioned dataset, then create a
   Foundry evaluation that scores them with built-in evaluators most meaningful for
   a RAG assistant:
     - builtin.groundedness  (is the answer supported by the retrieved context?)
     - builtin.relevance     (does the answer address the question?)
     - builtin.retrieval     (did the search return relevant, well-ranked context?)
4. Poll the run to completion and print the portal report URL + pass/fail counts.

Usage:
    python run_eval.py                 # full run, logged to the New Foundry portal
    python run_eval.py --limit 3       # only the first 3 prompts (cheaper smoke test)
    python run_eval.py --prep-only     # call the agent + build eval input, skip scoring

Configuration comes from environment variables (see .env.example); a local .env
file is loaded automatically if present.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from eval_core import (
    DEFAULT_AGENT_URL,
    EvalEnv,
    load_dataset,
    log,
    prepare_rows,
    score_rows,
)

try:
    from dotenv import load_dotenv
except ImportError:  # python-dotenv is optional at import time
    load_dotenv = None

HERE = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default=str(HERE / "dataset.jsonl"))
    parser.add_argument("--limit", type=int, default=None, help="only first N prompts")
    parser.add_argument(
        "--prep-only",
        action="store_true",
        help="call the agent and build eval input, but do not run evaluators",
    )
    parser.add_argument(
        "--name",
        default=f"nasuni-assistant-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}",
        help="evaluation run name shown in the portal",
    )
    args = parser.parse_args()

    if load_dotenv:
        # override=True so eval/.env wins over any pre-existing shell exports.
        load_dotenv(HERE / ".env", override=True)

    env = EvalEnv.from_environ()
    agent_url = env.agent_url or DEFAULT_AGENT_URL
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        sys.exit(f"dataset not found: {dataset_path}")

    results_dir = HERE / "results"
    results_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    input_path = results_dir / f"{stamp}.eval.jsonl"

    rows = load_dataset(dataset_path, args.limit)
    log(f"loaded {len(rows)} prompt(s) from {dataset_path.name}")
    log(f"agent endpoint: {agent_url}")

    start = time.time()
    written = prepare_rows(rows, agent_url, input_path)
    log(f"built {written} eval row(s) in {time.time() - start:.0f}s -> {input_path.name}")
    if written == 0:
        sys.exit("no eval rows produced; aborting.")

    if args.prep_only:
        log("--prep-only set; skipping evaluators.")
        return 0

    if not env.project or not env.model:
        sys.exit(
            "AZURE_AI_PROJECT and MODEL_DEPLOYMENT_NAME must be set (see eval/.env.example)."
        )
    score_rows(input_path, name=args.name, project=env.project, model=env.model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
