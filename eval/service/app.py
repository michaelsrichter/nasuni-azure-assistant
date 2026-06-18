#!/usr/bin/env python3
"""FastAPI service that drives Foundry evaluations from the web app.

The SPA's **Evaluations** page calls this service to:
  * GET  /api/eval/info     -> configuration + the evaluator catalogue + dataset size
  * GET  /api/eval/dataset  -> the list of benchmark prompts
  * POST /api/eval/run      -> start a run and stream progress as Server-Sent Events

The heavy lifting (calling the deployed agent for every prompt, then scoring the
rows with Foundry built-in evaluators) lives in ``eval_core`` and is shared with
the ``run_eval.py`` CLI, so the web experience and the command line stay in lock
step.

Run locally:
    uvicorn service.app:app --port 8099 --reload     # from the eval/ directory

Configuration mirrors the CLI (see eval/.env.example): AGENT_API_URL,
AZURE_AI_PROJECT, MODEL_DEPLOYMENT_NAME. Auth is keyless (DefaultAzureCredential).
"""

from __future__ import annotations

import json
import queue
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import sys

# Allow `import eval_core` whether the service is started from eval/ or eval/service.
EVAL_DIR = Path(__file__).resolve().parent.parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

from eval_core import (  # noqa: E402
    EVALUATORS,
    EvalEnv,
    load_dataset,
    prepare_rows,
    score_rows,
)

try:
    from dotenv import load_dotenv

    load_dotenv(EVAL_DIR / ".env", override=False)
except ImportError:  # python-dotenv is optional
    pass

DATASET_PATH = EVAL_DIR / "dataset.jsonl"
RESULTS_DIR = EVAL_DIR / "results"

app = FastAPI(title="Nasuni assistant evaluation service", version="1.0.0")

# The page is normally served same-origin (nginx / vite proxy forwards /api/eval
# here), but allow the local dev origins so the SPA can talk to the service
# directly during development too.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _evaluator_catalogue() -> list[dict]:
    return [
        {"name": e["name"], "label": e["label"], "summary": e["summary"]}
        for e in EVALUATORS
    ]


@app.get("/api/eval/info")
def info() -> dict:
    env = EvalEnv.from_environ()
    prompts = load_dataset(DATASET_PATH) if DATASET_PATH.exists() else []
    return {
        "agent_url": env.agent_url,
        "project_configured": bool(env.project),
        "model": env.model,
        "evaluators": _evaluator_catalogue(),
        "dataset_count": len(prompts),
    }


@app.get("/api/eval/dataset")
def dataset() -> dict:
    prompts = load_dataset(DATASET_PATH) if DATASET_PATH.exists() else []
    return {"count": len(prompts), "prompts": [p["query"] for p in prompts]}


@app.get("/api/eval/healthz")
def healthz() -> dict:
    return {"status": "ok"}


class RunRequest(BaseModel):
    limit: int | None = None
    prep_only: bool = False


def _sse(kind: str, data: dict) -> bytes:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def _run_job(req: RunRequest, q: "queue.Queue") -> None:
    """Execute the evaluation on a worker thread, pushing events onto ``q``."""

    def on_event(kind: str, data: dict) -> None:
        q.put((kind, data))

    try:
        env = EvalEnv.from_environ()
        if not DATASET_PATH.exists():
            on_event("error", {"message": f"dataset not found: {DATASET_PATH.name}"})
            return

        rows = load_dataset(DATASET_PATH, req.limit)
        on_event(
            "start",
            {
                "total": len(rows),
                "agent_url": env.agent_url,
                "prep_only": req.prep_only,
                "evaluators": _evaluator_catalogue(),
                "project_configured": bool(env.project),
            },
        )

        RESULTS_DIR.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        input_path = RESULTS_DIR / f"{stamp}.eval.jsonl"

        written = prepare_rows(rows, env.agent_url, input_path, on_event=on_event)
        if written == 0:
            on_event("error", {"message": "no eval rows produced (agent returned no answers)"})
            return

        if req.prep_only:
            on_event("result", {"status": "prep_only", "counts": None, "criteria": [], "report_url": None})
            return

        if not env.project or not env.model:
            on_event(
                "error",
                {
                    "message": "AZURE_AI_PROJECT and MODEL_DEPLOYMENT_NAME must be set to score "
                    "(see eval/.env.example). Use 'prepare only' to skip scoring."
                },
            )
            return

        name = f"nasuni-assistant-{stamp}"
        score_rows(input_path, name=name, project=env.project, model=env.model, on_event=on_event)
    except Exception as exc:  # surface any failure to the client instead of hanging
        on_event("error", {"message": f"{type(exc).__name__}: {exc}"})
    finally:
        q.put(None)  # sentinel: job finished


@app.post("/api/eval/run")
def run(req: RunRequest) -> StreamingResponse:
    q: "queue.Queue" = queue.Queue()
    worker = threading.Thread(target=_run_job, args=(req, q), daemon=True)
    worker.start()

    def event_stream():
        while True:
            try:
                item = q.get(timeout=15)
            except queue.Empty:
                # keep the SSE connection (and any intermediary) alive during the
                # long evaluator polling phase.
                yield b": keep-alive\n\n"
                continue
            if item is None:
                yield _sse("done", {"finished_at": time.time()})
                return
            kind, data = item
            yield _sse(kind, data)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
