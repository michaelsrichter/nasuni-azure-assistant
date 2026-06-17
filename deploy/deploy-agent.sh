#!/usr/bin/env bash
# Deploy the demo1 agent to **Foundry's Hosted Agent Service**.
#
# This is the half of the deployment that puts the agent where the Foundry
# portal can see it: project → Agents → (Hosted). The agent runs *inside*
# Foundry Agent Service — NOT in our Container App. The Container App
# (deploy-aca.sh) hosts only the frontend.
#
#   Browser → nginx → token-proxy → [Foundry Hosted Agent Service] → KB → MCP
#                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
#                                    deployed by THIS script
#
# Under the hood it drives the Azure Developer CLI agent extension, which
# builds the container image, pushes it to a project-linked ACR, registers a
# Hosted agent version with Foundry, and waits for it to go `active`.
#
# IMPORTANT: when azd runs non-interactively (--no-prompt) it does NOT grant the
# platform-created agent identity its **Foundry User** role. Without that role
# the hosted agent fails to provision (~80s "ProvisioningError: Please retry").
# This script therefore grants Foundry User to the agent identity explicitly.
#
# The agent's `knowledge_base_search` tool also calls Azure AI Search directly,
# so the same agent identity is granted the Search data-plane roles too. Both
# grants are best effort and use the identity in AGENT_PRINCIPAL_ID (below).
#
# Docs: https://learn.microsoft.com/azure/foundry/agents/quickstarts/quickstart-hosted-agent?pivots=azd
#
# Usage:
#   ./deploy/deploy-agent.sh
#   FOUNDRY_PROJECT_ID="/subscriptions/.../projects/researchProject" ./deploy/deploy-agent.sh
#
# Prerequisites:
#   * Azure Developer CLI (azd) 1.25.3+  and the `azure.ai.agents` extension
#       azd extension install azure.ai.agents
#   * `az login` / `azd auth login` as a principal with **Foundry Project
#     Manager** at the project scope (needed to create the agent and assign the
#     agent identity its Foundry User role).
#   * The Search service + Knowledge Base already provisioned
#     (infra/Demo1.Infra: ensure-search / ensure-kb).
#
# NOTE: provisioning creates real, billable Azure resources (ACR, Application
# Insights, Log Analytics, the hosted agent). Review before running.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ---- Configuration ----------------------------------------------------------
AGENT_NAME="${AGENT_NAME:-demo1-kb-mslearn}"
MANIFEST="${MANIFEST:-hosted-agent/agent.manifest.yaml}"
AGENT_SRC="${AGENT_SRC:-hosted-agent}"
AZD_ENV="${AZD_ENV:-demo1}"

# The agent's declared parameters / env vars (resolved into the hosted runtime).
AZURE_AI_MODEL_DEPLOYMENT_NAME="${AZURE_AI_MODEL_DEPLOYMENT_NAME:-gpt-4.1-mini}"
DEMO1_SEARCH_ENDPOINT="${DEMO1_SEARCH_ENDPOINT:-https://srch-demo1-d9129d.search.windows.net}"
DEMO1_KNOWLEDGE_BASE_NAME="${DEMO1_KNOWLEDGE_BASE_NAME:-kb-mslearn}"

# Foundry project (account + project name make up the project endpoint).
FOUNDRY_ACCOUNT_NAME="${FOUNDRY_ACCOUNT_NAME:-researchfoundry}"
FOUNDRY_PROJECT_NAME="${FOUNDRY_PROJECT_NAME:-researchProject}"
# Optional: pass the full ARM project id to run init non-interactively.
FOUNDRY_PROJECT_ID="${FOUNDRY_PROJECT_ID:-}"

# Built-in role IDs (assigned by ID so renamed display names don't break us).
ROLE_FOUNDRY_USER="53ca6127-db72-4b80-b1b0-d745d6d5456d"  # Foundry User (model + runtime)

# Search service for the agent-identity tool-access role grant.
SEARCH_SERVICE_NAME="${SEARCH_SERVICE_NAME:-srch-demo1-d9129d}"
# Principal (object) id of the platform-created agent identity. azd prints it,
# and the Foundry portal shows it under the agent's Identity blade. Supply it to
# let this script grant the Search roles automatically.
AGENT_PRINCIPAL_ID="${AGENT_PRINCIPAL_ID:-}"

# ---- Helpers ----------------------------------------------------------------
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
require() { command -v "$1" >/dev/null 2>&1 || { warn "Missing required tool: $1"; exit 1; }; }

# ---- Pre-flight -------------------------------------------------------------
require azd
require az

if ! azd ai agent version >/dev/null 2>&1; then
  warn "The azd agent extension is missing. Install it with:"
  warn "  azd extension install azure.ai.agents"
  exit 1
fi

SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
[[ -z "$SUBSCRIPTION_ID" ]] && { warn "Run 'az login' first."; exit 1; }
say "Subscription: $SUBSCRIPTION_ID"

# ---- 1. azd environment -----------------------------------------------------
if ! azd env list 2>/dev/null | awk '{print $1}' | grep -qx "$AZD_ENV"; then
  say "Creating azd environment '$AZD_ENV'"
  azd env new "$AZD_ENV" --no-prompt
fi
azd env select "$AZD_ENV"

say "Recording agent parameters in the azd environment"
azd env set AZURE_AI_MODEL_DEPLOYMENT_NAME "$AZURE_AI_MODEL_DEPLOYMENT_NAME"
azd env set DEMO1_SEARCH_ENDPOINT         "$DEMO1_SEARCH_ENDPOINT"
azd env set DEMO1_KNOWLEDGE_BASE_NAME     "$DEMO1_KNOWLEDGE_BASE_NAME"

# ---- 2. Initialize the agent project (idempotent) ---------------------------
# `azd ai agent init` scaffolds azure.yaml + agent.yaml from the manifest and
# wires the project. Skip if azure.yaml already references our agent.
if [[ -f azure.yaml ]] && grep -q "$AGENT_NAME" azure.yaml 2>/dev/null; then
  say "azure.yaml already initialized for '$AGENT_NAME' — skipping init"
else
  say "Initializing agent project from $MANIFEST"
  INIT_ARGS=(ai agent init -m "$MANIFEST" --src "$AGENT_SRC" --agent-name "$AGENT_NAME"
             --model-deployment "$AZURE_AI_MODEL_DEPLOYMENT_NAME")
  if [[ -n "$FOUNDRY_PROJECT_ID" ]]; then
    INIT_ARGS+=(--project-id "$FOUNDRY_PROJECT_ID" --no-prompt)
  else
    warn "FOUNDRY_PROJECT_ID not set — 'azd ai agent init' will prompt you to"
    warn "pick the tenant / subscription / project interactively."
  fi
  azd "${INIT_ARGS[@]}"
fi

# ---- 3. Provision + deploy --------------------------------------------------
# Recent azd agent extensions scaffold a self-contained project into a
# subdirectory named after the agent (its own azure.yaml / infra / .azure). If
# that happened, provision and deploy must run from inside that subdirectory.
AGENT_PROJECT_DIR="$ROOT_DIR"
if [[ -f "$ROOT_DIR/$AGENT_NAME/azure.yaml" ]]; then
  AGENT_PROJECT_DIR="$ROOT_DIR/$AGENT_NAME"
  say "Using scaffolded agent project directory: $AGENT_PROJECT_DIR"
fi

pushd "$AGENT_PROJECT_DIR" >/dev/null
say "Provisioning Azure resources (azd provision)"
azd provision

say "Deploying the hosted agent to Foundry Agent Service (azd deploy)"
azd deploy
popd >/dev/null

# ---- 4. Surface the agent endpoint ------------------------------------------
PROJECT_ENDPOINT="https://${FOUNDRY_ACCOUNT_NAME}.services.ai.azure.com/api/projects/${FOUNDRY_PROJECT_NAME}"
RESPONSES_URL="${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/protocols/openai/responses?api-version=v1"

say "Agent status:"
azd ai agent show 2>/dev/null || true

# ---- 5. Grant the agent identity its data-plane roles -----------------------
# The platform-created agent identity needs:
#   * Foundry User at the project scope — REQUIRED for the hosted agent to
#     provision/run (azd --no-prompt does not grant this; without it the agent
#     fails to go active).
#   * Search Index Data Reader + Search Service Contributor on the Search
#     service — so the knowledge_base_search tool can query it directly.
# All target the same identity (AGENT_PRINCIPAL_ID). Find it in the Foundry
# portal under project → Agents → $AGENT_NAME → Identity, or in the agent
# version JSON as instance_identity.principal_id. The identity is stable across
# agent versions.
FOUNDRY_RG="$(az cognitiveservices account list \
  --query "[?name=='$FOUNDRY_ACCOUNT_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"
SEARCH_RG="$(az search service list \
  --query "[?name=='$SEARCH_SERVICE_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"

if [[ -z "$AGENT_PRINCIPAL_ID" ]]; then
  warn "AGENT_PRINCIPAL_ID not set — skipping agent-identity role grants."
  warn "The hosted agent will FAIL to provision without 'Foundry User'. After"
  warn "finding the identity (Foundry portal → Agents → $AGENT_NAME → Identity):"
  warn "  PROJECT=<account-resource-id>/projects/$FOUNDRY_PROJECT_NAME"
  warn "  az role assignment create --assignee-object-id <id> \\"
  warn "    --assignee-principal-type ServicePrincipal \\"
  warn "    --role $ROLE_FOUNDRY_USER --scope \$PROJECT   # Foundry User"
  warn "  (then 'Search Index Data Reader' + 'Search Service Contributor' on the"
  warn "   Search service for knowledge_base_search)"
else
  # Foundry User at the project scope.
  if [[ -n "$FOUNDRY_RG" ]]; then
    FOUNDRY_ID="$(az cognitiveservices account show \
      -n "$FOUNDRY_ACCOUNT_NAME" -g "$FOUNDRY_RG" --query id -o tsv)"
    PROJECT_SCOPE="$FOUNDRY_ID/projects/$FOUNDRY_PROJECT_NAME"
    say "Granting agent identity 'Foundry User' on project $FOUNDRY_PROJECT_NAME"
    if OUT="$(az role assignment create \
        --assignee-object-id "$AGENT_PRINCIPAL_ID" \
        --assignee-principal-type ServicePrincipal \
        --role "$ROLE_FOUNDRY_USER" --scope "$PROJECT_SCOPE" -o none 2>&1)"; then
      say "  granted Foundry User"
    elif grep -qi "already exists\|RoleAssignmentExists" <<<"$OUT"; then
      say "  (already assigned)"
    else
      warn "  FAILED to grant Foundry User: $OUT"
    fi
  else
    warn "Could not resolve Foundry account RG; grant 'Foundry User' manually."
  fi

  # Search data-plane roles for knowledge_base_search.
  if [[ -n "$SEARCH_RG" ]]; then
    SEARCH_ID="$(az search service show -n "$SEARCH_SERVICE_NAME" -g "$SEARCH_RG" --query id -o tsv)"
    for ROLE in "Search Index Data Reader" "Search Service Contributor"; do
      say "Granting agent identity '$ROLE' on $SEARCH_SERVICE_NAME"
      az role assignment create \
        --assignee-object-id "$AGENT_PRINCIPAL_ID" \
        --assignee-principal-type ServicePrincipal \
        --role "$ROLE" \
        --scope "$SEARCH_ID" -o none 2>/dev/null || say "  (already assigned)"
    done
  else
    warn "Could not resolve Search service RG; grant the Search roles manually."
  fi
fi

# ---- 6. Summary -------------------------------------------------------------
cat <<EOF

================================================================================
 Hosted agent deployed to Foundry Agent Service
================================================================================
  Agent name      : $AGENT_NAME
  Project         : $FOUNDRY_ACCOUNT_NAME / $FOUNDRY_PROJECT_NAME
  Responses URL   : $RESPONSES_URL

  The agent now appears in the Foundry portal:
    project → Agents → $AGENT_NAME  (Type: hosted)

  Test it directly:
    azd ai agent invoke "What is Azure Blob Storage in one sentence?"

  Then deploy the frontend Container App and point its sidecar at the agent:
    FOUNDRY_AGENT_RESPONSES_URL="$RESPONSES_URL" ./deploy/deploy-aca.sh
================================================================================
EOF
