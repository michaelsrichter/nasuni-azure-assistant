#!/usr/bin/env python3
"""Reusable core for the Nasuni-on-Azure assistant evaluation harness.

This module factors the agent-calling + Foundry-scoring logic out of the CLI
(`run_eval.py`) so it can also be driven by the FastAPI service (`service/app.py`)
that powers the web app's **Evaluations** page.

The two public entry points emit structured progress events through an optional
``on_event(kind, data)`` callback so a caller can stream them over SSE:

  prepare_rows(...)  -> calls the deployed agent for every prompt and writes the
                        (query, response, context) rows used for scoring.
  score_rows(...)    -> uploads those rows and scores them with Foundry built-in
                        evaluators (groundedness, relevance, retrieval) via the
                        new Foundry evaluations API (the OpenAI Evals surface
                        exposed by ``azure-ai-projects``).

Event kinds (data shapes are best-effort and forward compatible):
  "prompt"  {index, total, query, status, answer_chars, search_calls, context_chars}
  "phase"   {phase, message}
  "status"  {status}
  "result"  {status, counts, criteria, report_url}
  "log"     {message}
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import requests

HERE = Path(__file__).resolve().parent

DEFAULT_AGENT_URL = (
    "https://chatbot-web.ashyglacier-15904dad.westcentralus.azurecontainerapps.io"
    "/api/responses"
)

# The built-in evaluators we score every run with, in display order. Kept here so
# the CLI, the service, and the web UI all describe them identically.
EVALUATORS = [
    {
        "name": "groundedness",
        "evaluator_name": "builtin.groundedness",
        "label": "Groundedness",
        "summary": "Is every claim in the answer supported by the retrieved knowledge-base context?",
    },
    {
        "name": "relevance",
        "evaluator_name": "builtin.relevance",
        "label": "Relevance",
        "summary": "Does the answer actually address the question that was asked?",
    },
    {
        "name": "retrieval",
        "evaluator_name": "builtin.retrieval",
        "label": "Retrieval",
        "summary": "Did the knowledge-base search return relevant, well-ranked context for the query?",
    },
]

# Callback type: (kind, data) -> None
EventFn = Callable[[str, dict], None]


def _emit(on_event: Optional[EventFn], kind: str, data: dict) -> None:
    if on_event is not None:
        try:
            on_event(kind, data)
        except Exception:  # never let a misbehaving sink break the run
            pass


def log(msg: str, on_event: Optional[EventFn] = None) -> None:
    print(f"[eval] {msg}", flush=True)
    _emit(on_event, "log", {"message": msg})


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


def load_dataset(path: Path, limit: int | None = None) -> list[dict]:
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
    """Extract (answer_text, retrieved_context, num_search_calls) from a Responses payload."""
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


def prepare_rows(
    rows: list[dict],
    agent_url: str,
    out_path: Path,
    on_event: Optional[EventFn] = None,
) -> int:
    """Query the agent for every prompt and write a jsonl of eval rows.

    Emits a ``"prompt"`` event before and after each agent call so a caller can
    render live progress.
    """
    total = len(rows)
    written = 0
    with out_path.open("w", encoding="utf-8") as out:
        for i, row in enumerate(rows, start=1):
            query = row["query"]
            _emit(on_event, "prompt", {"index": i, "total": total, "query": query, "status": "querying"})
            log(f"[{i}/{total}] querying agent: {query[:70]}...", on_event)
            try:
                payload = call_agent(agent_url, query)
            except requests.RequestException as exc:
                log(f"  ! request failed, skipping row: {exc}", on_event)
                _emit(on_event, "prompt", {"index": i, "total": total, "query": query, "status": "failed", "error": str(exc)})
                continue
            answer, context, search_calls = parse_response(payload)
            answer = sanitize_text(answer)
            context = sanitize_text(context)
            if not answer:
                log("  ! empty answer, skipping row", on_event)
                _emit(on_event, "prompt", {"index": i, "total": total, "query": query, "status": "skipped"})
                continue
            if not context:
                log("  ~ no retrieved context (agent did not search)", on_event)
            eval_row = {
                "query": query,
                "response": answer,
                "context": context or "(no knowledge-base context retrieved)",
            }
            if "ground_truth" in row:
                eval_row["ground_truth"] = row["ground_truth"]
            out.write(json.dumps(eval_row, ensure_ascii=False) + "\n")
            written += 1
            log(f"  ok: {len(answer)} chars answer, {search_calls} search call(s)", on_event)
            _emit(
                on_event,
                "prompt",
                {
                    "index": i,
                    "total": total,
                    "query": query,
                    "status": "done",
                    "answer_chars": len(answer),
                    "context_chars": len(context),
                    "search_calls": search_calls,
                },
            )
    return written


def _aggregate_criteria(openai_client, eval_id: str, run_id: str) -> list[dict]:
    """Best-effort per-evaluator pass/fail + average score from the run's output items."""
    buckets: dict[str, dict] = {}
    try:
        page = openai_client.evals.runs.output_items.list(eval_id=eval_id, run_id=run_id)
    except Exception:
        return []

    def add(name: str, passed, score) -> None:
        key = (name or "").strip().lower()
        if not key:
            return
        b = buckets.setdefault(key, {"name": key, "passed": 0, "failed": 0, "scores": []})
        if passed is True:
            b["passed"] += 1
        elif passed is False:
            b["failed"] += 1
        if isinstance(score, (int, float)):
            b["scores"].append(float(score))

    for item in page:  # the SDK iterator transparently follows pages
        results = getattr(item, "results", None)
        if results is None and isinstance(item, dict):
            results = item.get("results")
        for r in results or []:
            if isinstance(r, dict):
                add(r.get("name"), r.get("passed"), r.get("score"))
            else:
                add(getattr(r, "name", None), getattr(r, "passed", None), getattr(r, "score", None))

    out: list[dict] = []
    label_by_name = {e["name"]: e["label"] for e in EVALUATORS}
    summary_by_name = {e["name"]: e["summary"] for e in EVALUATORS}
    for spec in EVALUATORS:
        b = buckets.get(spec["name"])
        if not b:
            # match on prefix (Foundry sometimes suffixes the criterion name)
            for key, val in buckets.items():
                if key.startswith(spec["name"]):
                    b = val
                    break
        if not b:
            continue
        scores = b["scores"]
        out.append(
            {
                "name": spec["name"],
                "label": label_by_name.get(spec["name"], spec["name"].title()),
                "summary": summary_by_name.get(spec["name"], ""),
                "passed": b["passed"],
                "failed": b["failed"],
                "avg_score": round(sum(scores) / len(scores), 2) if scores else None,
            }
        )
    return out


def score_rows(
    input_path: Path,
    name: str,
    *,
    project: str,
    model: str,
    on_event: Optional[EventFn] = None,
    poll_seconds: int = 8,
) -> dict:
    """Score prepared rows with Foundry built-in evaluators via the new Evals API.

    Returns a result dict and emits ``phase`` / ``status`` / ``result`` events.
    """
    from azure.identity import DefaultAzureCredential
    from azure.ai.projects import AIProjectClient
    from openai.types.eval_create_params import DataSourceConfigCustom
    from openai.types.evals.create_eval_jsonl_run_data_source_param import (
        CreateEvalJSONLRunDataSourceParam,
        SourceFileID,
    )

    if not project or not model:
        raise RuntimeError(
            "AZURE_AI_PROJECT and MODEL_DEPLOYMENT_NAME must be set (see eval/.env.example)."
        )

    project_client = AIProjectClient(endpoint=project, credential=DefaultAzureCredential())
    openai_client = project_client.get_openai_client()

    version = str(int(time.time()))
    _emit(on_event, "phase", {"phase": "upload", "message": f"Uploading dataset '{name}' (version {version})"})
    log(f"uploading dataset '{name}' (version {version})...", on_event)
    dataset = project_client.datasets.upload_file(
        name=name, version=version, file_path=str(input_path)
    )

    data_source_config = DataSourceConfigCustom(
        type="custom",
        item_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "response": {"type": "string"},
                "context": {"type": "string"},
            },
            "required": ["query", "response"],
        },
        include_sample_schema=False,
    )
    testing_criteria = [
        {
            "type": "azure_ai_evaluator",
            "name": "groundedness",
            "evaluator_name": "builtin.groundedness",
            "initialization_parameters": {"model": model},
            "data_mapping": {
                "query": "{{item.query}}",
                "response": "{{item.response}}",
                "context": "{{item.context}}",
            },
        },
        {
            "type": "azure_ai_evaluator",
            "name": "relevance",
            "evaluator_name": "builtin.relevance",
            "initialization_parameters": {"model": model},
            "data_mapping": {
                "query": "{{item.query}}",
                "response": "{{item.response}}",
            },
        },
        {
            "type": "azure_ai_evaluator",
            "name": "retrieval",
            "evaluator_name": "builtin.retrieval",
            "initialization_parameters": {"model": model},
            "data_mapping": {
                "query": "{{item.query}}",
                "context": "{{item.context}}",
            },
        },
    ]

    _emit(on_event, "phase", {"phase": "evaluate", "message": "Creating evaluation (groundedness, relevance, retrieval)"})
    log("creating evaluation (groundedness, relevance, retrieval)...", on_event)
    eval_object = openai_client.evals.create(
        name=name,
        data_source_config=data_source_config,
        testing_criteria=testing_criteria,
    )
    run = openai_client.evals.runs.create(
        eval_id=eval_object.id,
        name=f"{name}-run",
        data_source=CreateEvalJSONLRunDataSourceParam(
            type="jsonl",
            source=SourceFileID(type="file_id", id=dataset.id),
        ),
    )
    _emit(on_event, "phase", {"phase": "poll", "message": f"Evaluation submitted (run {run.id}); scoring rows"})
    log(f"eval {eval_object.id} / run {run.id} submitted; polling...", on_event)

    terminal = {"completed", "failed", "canceled", "error"}
    while run.status not in terminal:
        time.sleep(poll_seconds)
        run = openai_client.evals.runs.retrieve(run_id=run.id, eval_id=eval_object.id)
        _emit(on_event, "status", {"status": run.status})
        log(f"  status: {run.status}", on_event)

    counts = getattr(run, "result_counts", None)
    report_url = getattr(run, "report_url", None)
    criteria = _aggregate_criteria(openai_client, eval_object.id, run.id)

    log(f"=== {run.status} ===", on_event)
    if counts:
        log(
            f"passed={counts.passed} failed={counts.failed} "
            f"errored={counts.errored} total={counts.total}",
            on_event,
        )
    if report_url:
        log(f"portal results: {report_url}", on_event)

    result = {
        "status": run.status,
        "eval_id": eval_object.id,
        "run_id": run.id,
        "counts": {
            "passed": getattr(counts, "passed", None),
            "failed": getattr(counts, "failed", None),
            "errored": getattr(counts, "errored", None),
            "total": getattr(counts, "total", None),
        }
        if counts
        else None,
        "criteria": criteria,
        "report_url": report_url,
    }
    _emit(on_event, "result", result)
    return result


@dataclass
class EvalEnv:
    agent_url: str
    project: Optional[str]
    model: Optional[str]
    evaluators: list = field(default_factory=lambda: list(EVALUATORS))

    @classmethod
    def from_environ(cls) -> "EvalEnv":
        return cls(
            agent_url=os.environ.get("AGENT_API_URL", DEFAULT_AGENT_URL),
            project=os.environ.get("AZURE_AI_PROJECT"),
            model=os.environ.get("MODEL_DEPLOYMENT_NAME"),
        )
