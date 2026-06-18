#!/usr/bin/env python3
"""Evaluate the Nasuni-on-Azure assistant with Azure AI Foundry built-in evaluators.

The flow is:

1. Read prompts from ``dataset.jsonl`` (one ``{"query": "..."}`` per line).
2. Call the deployed agent's non-streaming Responses endpoint for each prompt and
   extract the answer text plus the knowledge-base context the agent retrieved.
3. Score every (query, response, context) row with a couple of Foundry's built-in
   *quality* evaluators that are the most meaningful for a RAG assistant:
     - Groundedness  (is the answer supported by the retrieved context?)
     - Relevance     (does the answer address the question?)
     - Retrieval     (did the search return relevant, well-ranked context?)
4. By default, upload the run to the Foundry project so it shows up under the
   portal's *Evaluations* tab, and print the ``studio_url``. Use --no-upload to
   keep everything local.

Usage:
    python run_eval.py                 # full run, logged to the Foundry portal
    python run_eval.py --no-upload     # local-only run, no portal upload
    python run_eval.py --limit 3       # only the first 3 prompts (cheaper smoke test)
    python run_eval.py --prep-only     # call the agent + build eval input, skip judging

Configuration comes from environment variables (see .env.example); a local .env
file is loaded automatically if present.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
except ImportError:  # python-dotenv is optional at import time
    load_dotenv = None

HERE = Path(__file__).resolve().parent
DEFAULT_AGENT_URL = (
    "https://chatbot-web.ashyglacier-15904dad.westcentralus.azurecontainerapps.io"
    "/api/responses"
)


def log(msg: str) -> None:
    print(f"[eval] {msg}", flush=True)


# Markdown image syntax and data/image URLs confuse the evaluators' prompt
# rendering (they get turned into image content parts the judge model rejects).
_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_DATA_URI = re.compile(r"data:image/[^\s)\"']+", re.IGNORECASE)
_IMG_URL = re.compile(r"https?://\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?", re.IGNORECASE)


def sanitize_text(text: str) -> str:
    """Strip image markdown / data URIs / image URLs so the judge sees plain text."""
    text = _MD_IMAGE.sub(lambda m: m.group(1) or "image", text)
    text = _DATA_URI.sub("[image]", text)
    text = _IMG_URL.sub("[image]", text)
    return text


def load_dataset(path: Path, limit: int | None) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if "query" not in row:
                raise ValueError(f"dataset row missing 'query': {line}")
            rows.append(row)
    if limit is not None:
        rows = rows[:limit]
    return rows


def call_agent(agent_url: str, query: str, timeout: int = 120) -> dict:
    """POST a single prompt to the non-streaming Responses endpoint."""
    resp = requests.post(
        agent_url,
        headers={"Content-Type": "application/json"},
        json={"input": query, "stream": False},
        timeout=timeout,
    )
    resp.raise_for_status()
    return resp.json()


def parse_response(payload: dict) -> tuple[str, str, int]:
    """Extract (answer_text, retrieved_context, num_search_calls) from a Responses payload.

    The agent emits an ``output`` array of items. ``message`` items carry the
    assistant answer; ``function_call_output`` items carry the knowledge-base
    search results as a JSON string of citation objects.
    """
    answer_parts: list[str] = []
    context_chunks: list[str] = []
    search_calls = 0

    for item in payload.get("output", []):
        itype = item.get("type")
        if itype == "message":
            for part in item.get("content", []):
                if part.get("type") in ("output_text", "text"):
                    answer_parts.append(part.get("text", ""))
        elif itype == "function_call":
            search_calls += 1
        elif itype == "function_call_output":
            raw = item.get("output")
            citations = raw
            if isinstance(raw, str):
                try:
                    citations = json.loads(raw)
                except json.JSONDecodeError:
                    context_chunks.append(raw)
                    continue
            if isinstance(citations, list):
                for c in citations:
                    if not isinstance(c, dict):
                        context_chunks.append(str(c))
                        continue
                    idx = c.get("index")
                    title = c.get("title") or c.get("source") or "source"
                    snippet = (c.get("snippet") or "").strip()
                    if snippet:
                        context_chunks.append(f"[{idx}] {title}: {snippet}")
            else:
                context_chunks.append(str(citations))

    answer = "\n".join(p for p in answer_parts if p).strip()
    context = "\n\n".join(context_chunks).strip()
    return answer, context, search_calls


def build_eval_input(rows: list[dict], agent_url: str, out_path: Path) -> int:
    """Query the agent for every prompt and write a jsonl of eval rows."""
    written = 0
    with out_path.open("w", encoding="utf-8") as out:
        for i, row in enumerate(rows, start=1):
            query = row["query"]
            log(f"[{i}/{len(rows)}] querying agent: {query[:70]}...")
            try:
                payload = call_agent(agent_url, query)
            except requests.RequestException as exc:
                log(f"  ! request failed, skipping row: {exc}")
                continue
            answer, context, search_calls = parse_response(payload)
            answer = sanitize_text(answer)
            context = sanitize_text(context)
            if not answer:
                log("  ! empty answer, skipping row")
                continue
            if not context:
                # Groundedness/Retrieval need context; fall back to the answer so
                # the row is still scorable for Relevance, but flag it.
                log("  ~ no retrieved context (agent did not search)")
            eval_row = {
                "query": query,
                "response": answer,
                "context": context or "(no knowledge-base context retrieved)",
            }
            if "ground_truth" in row:
                eval_row["ground_truth"] = row["ground_truth"]
            out.write(json.dumps(eval_row, ensure_ascii=False) + "\n")
            written += 1
            log(f"  ok: {len(answer)} chars answer, {search_calls} search call(s)")
    return written


def make_model_config():
    from azure.ai.evaluation import AzureOpenAIModelConfiguration

    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    deployment = os.environ.get("MODEL_DEPLOYMENT_NAME")
    if not endpoint or not deployment:
        sys.exit(
            "AZURE_OPENAI_ENDPOINT and MODEL_DEPLOYMENT_NAME must be set "
            "(see eval/.env.example)."
        )
    cfg = AzureOpenAIModelConfiguration(
        azure_endpoint=endpoint,
        azure_deployment=deployment,
        api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21"),
    )
    api_key = os.environ.get("AZURE_OPENAI_API_KEY")
    if api_key:
        cfg["api_key"] = api_key  # type: ignore[index]
    return cfg


def run_evaluation(input_path: Path, upload: bool, name: str) -> None:
    from azure.ai.evaluation import (
        GroundednessEvaluator,
        RelevanceEvaluator,
        RetrievalEvaluator,
        evaluate,
    )

    model_config = make_model_config()

    # Keyless (Entra ID) is the default: when no api_key is configured, pass a
    # DefaultAzureCredential so the evaluators can authenticate the judge model.
    evaluator_kwargs: dict = {}
    if not os.environ.get("AZURE_OPENAI_API_KEY"):
        from azure.identity import DefaultAzureCredential

        evaluator_kwargs["credential"] = DefaultAzureCredential()

    evaluators = {
        "groundedness": GroundednessEvaluator(model_config, **evaluator_kwargs),
        "relevance": RelevanceEvaluator(model_config, **evaluator_kwargs),
        "retrieval": RetrievalEvaluator(model_config, **evaluator_kwargs),
    }
    evaluator_config = {
        "groundedness": {
            "column_mapping": {
                "query": "${data.query}",
                "response": "${data.response}",
                "context": "${data.context}",
            }
        },
        "relevance": {
            "column_mapping": {
                "query": "${data.query}",
                "response": "${data.response}",
            }
        },
        "retrieval": {
            "column_mapping": {
                "query": "${data.query}",
                "context": "${data.context}",
            }
        },
    }

    kwargs = {
        "data": str(input_path),
        "evaluators": evaluators,
        "evaluator_config": evaluator_config,
        "evaluation_name": name,
    }
    if upload:
        project = os.environ.get("AZURE_AI_PROJECT")
        if not project:
            sys.exit(
                "AZURE_AI_PROJECT must be set to upload results, or pass --no-upload."
            )
        kwargs["azure_ai_project"] = project

    log("running evaluators (groundedness, relevance, retrieval)...")
    result = evaluate(**kwargs)

    metrics = result.get("metrics", {})
    log("=== aggregate metrics ===")
    for key in sorted(metrics):
        print(f"  {key}: {metrics[key]}")

    studio_url = result.get("studio_url")
    if studio_url:
        log(f"portal results: {studio_url}")
    else:
        log("local run complete (no portal upload).")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default=str(HERE / "dataset.jsonl"))
    parser.add_argument("--limit", type=int, default=None, help="only first N prompts")
    parser.add_argument("--no-upload", action="store_true", help="skip portal upload")
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
        # override=True so eval/.env wins over any pre-existing shell exports
        # (e.g. an AZURE_OPENAI_ENDPOINT left over from another project).
        load_dotenv(HERE / ".env", override=True)

    # An empty AZURE_OPENAI_API_KEY="" confuses the evaluators' keyless path;
    # drop it entirely so they fall back cleanly to Entra ID (DefaultAzureCredential).
    if not os.environ.get("AZURE_OPENAI_API_KEY", "").strip():
        os.environ.pop("AZURE_OPENAI_API_KEY", None)

    agent_url = os.environ.get("AGENT_API_URL", DEFAULT_AGENT_URL)
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
    written = build_eval_input(rows, agent_url, input_path)
    log(f"built {written} eval row(s) in {time.time() - start:.0f}s -> {input_path.name}")
    if written == 0:
        sys.exit("no eval rows produced; aborting.")

    if args.prep_only:
        log("--prep-only set; skipping evaluators.")
        return 0

    run_evaluation(input_path, upload=not args.no_upload, name=args.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
