# Evaluation service for the Nasuni-on-Azure assistant web app.
#
# Wraps the Foundry evaluation harness (eval/eval_core.py) in a FastAPI app that
# the SPA's Evaluations page calls to run evals and stream progress over SSE.
#
# Auth to Foundry is keyless: in Azure the container's managed identity is used
# via DefaultAzureCredential, so no secrets are baked into the image.

FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Install deps first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The service imports eval_core and reads dataset.jsonl from the eval root.
COPY eval_core.py dataset.jsonl ./
COPY service ./service

EXPOSE 8099
CMD ["uvicorn", "service.app:app", "--host", "0.0.0.0", "--port", "8099"]
