#!/usr/bin/env bash
# Deploy the demo1 chatbot to Azure Container Apps.
#
# Two apps are deployed into a single Container Apps environment:
#
#   * chatbot-api       — the .NET 10 backend (built from ./backend/Dockerfile)
#   * chatbot-web       — the nginx-served React frontend that proxies /api/* to
#                         the backend (built from ./frontend/Dockerfile)
#
# Both images are built in the cloud using Azure Container Registry Tasks
# (`az acr build`), so Docker is not required locally.
#
# Reference: https://learn.microsoft.com/azure/container-apps/deploy-express-cli
#
# About 'express' vs 'standard' environments:
#   The original target was the **express** environment (preview), but as of the
#   current preview, *managed identity* and *secrets* are both listed as "In
#   development" (see https://learn.microsoft.com/azure/container-apps/express-overview).
#   Our backend authenticates to Azure AI Foundry via system-assigned managed
#   identity (Foundry has disableLocalAuth=true), so we need a **standard**
#   environment for it to work. The environment type is controlled by the
#   ENV_MODE variable below; set ENV_MODE=express to opt back into the express
#   preview when those features ship.
#
# Note: This script uses `az acr build` + `az containerapp create/update`
# rather than `az containerapp up --source` because the latter currently has
# a regression in containerapp extension 1.3.0b4 (`OS.linux` AttributeError).
#
# Usage:
#   ./deploy/deploy-aca.sh                       # defaults
#   RESOURCE_GROUP=rg-demo1-aca ./deploy/deploy-aca.sh
#
# Requirements:
#   * Azure CLI 2.86+ and the `containerapp` extension 1.3.0b4+
#   * `az login` with a Microsoft Entra account (personal MSA not supported)
#   * The Foundry account, Knowledge Base, and Search service from the infra
#     CLI already provisioned (see infra/Demo1.Infra)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ---- Configuration ----------------------------------------------------------
# Container Apps environment mode. 'standard' supports managed identity (which
# our backend requires); 'express' is faster to provision but its preview
# currently does not support MI or secrets.
ENV_MODE="${ENV_MODE:-standard}"
# Express is preview-only in westcentralus or eastasia; standard is GA in many
# regions but we keep the same default for parity.
LOCATION="${LOCATION:-westcentralus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-demo1-aca}"
ENV_NAME="${ENV_NAME:-cae-demo1-${ENV_MODE}}"
ACR_NAME="${ACR_NAME:-}"   # auto-detected or auto-created
BACKEND_APP="${BACKEND_APP:-chatbot-api}"
FRONTEND_APP="${FRONTEND_APP:-chatbot-web}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"

# Resources from the infra CLI (override if you re-provisioned).
DEMO1__SEARCHENDPOINT="${DEMO1__SEARCHENDPOINT:-https://srch-demo1-d9129d.search.windows.net}"
DEMO1__KNOWLEDGEBASENAME="${DEMO1__KNOWLEDGEBASENAME:-kb-mslearn}"
# Note: the Foundry OpenAI endpoint *must* use the openai.azure.com host so the
# KB's Azure OpenAI vectorizer (managed identity) authenticates correctly. The
# cognitiveservices.azure.com host returns 401 because the account has
# disableLocalAuth=true. See docs/operations.md for the diagnosis.
DEMO1__FOUNDRYOPENAIENDPOINT="${DEMO1__FOUNDRYOPENAIENDPOINT:-https://researchfoundry.openai.azure.com}"
DEMO1__CHATDEPLOYMENT="${DEMO1__CHATDEPLOYMENT:-gpt-4.1-mini}"
DEMO1__MCPSERVERURL="${DEMO1__MCPSERVERURL:-https://learn.microsoft.com/api/mcp}"

# Hosted-agent execution path. When UseHostedAgent=true the backend delegates
# orchestration to a portal-visible Foundry agent that invokes a single
# `knowledge_base_search` function tool; the backend executes that tool against
# the KB (which fans out to MCP and any other knowledge sources the KB owns).
DEMO1__USEHOSTEDAGENT="${DEMO1__USEHOSTEDAGENT:-true}"
DEMO1__PROJECTENDPOINT="${DEMO1__PROJECTENDPOINT:-https://researchfoundry.services.ai.azure.com/api/projects/researchProject}"
# Default reads hostedAgentId from infra/state.json if present so the value
# always matches the most recent `infra ensure-agent` run.
DEMO1__HOSTEDAGENTID_DEFAULT="$(jq -r '.hostedAgentId // empty' infra/state.json 2>/dev/null || true)"
DEMO1__HOSTEDAGENTID="${DEMO1__HOSTEDAGENTID:-${DEMO1__HOSTEDAGENTID_DEFAULT:-asst_QYxAByzcXx0whX2p04qZjP3b}}"

FOUNDRY_ACCOUNT_NAME="${FOUNDRY_ACCOUNT_NAME:-researchfoundry}"
FOUNDRY_PROJECT_NAME="${FOUNDRY_PROJECT_NAME:-researchProject}"
SEARCH_SERVICE_NAME="${SEARCH_SERVICE_NAME:-srch-demo1-d9129d}"

# ---- Helpers ----------------------------------------------------------------
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { warn "Missing required tool: $1"; exit 1; }
}

# ---- Pre-flight -------------------------------------------------------------
require az

ACCOUNT_USER="$(az account show --query 'user.name' -o tsv 2>/dev/null || true)"
SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
if [[ -z "$SUBSCRIPTION_ID" ]]; then
  warn "Not logged in to Azure. Run 'az login' first."
  exit 1
fi
say "Subscription: $SUBSCRIPTION_ID  ($ACCOUNT_USER)"

if ! az extension show -n containerapp >/dev/null 2>&1; then
  say "Installing 'containerapp' Azure CLI extension"
  az extension add -n containerapp --yes
fi
az extension update -n containerapp >/dev/null 2>&1 || true

# ---- 1. Resource group ------------------------------------------------------
say "Creating resource group '$RESOURCE_GROUP' in $LOCATION (idempotent)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none

# ---- 2. Container Apps environment ------------------------------------------
if az containerapp env show -n "$ENV_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  say "Container Apps environment '$ENV_NAME' already exists"
else
  if [[ "$ENV_MODE" == "express" ]]; then
    say "Creating EXPRESS Container Apps environment '$ENV_NAME' (preview)"
    az containerapp env create \
      --environment-mode express \
      --name "$ENV_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --logs-destination none \
      -o none
  else
    say "Creating STANDARD Container Apps environment '$ENV_NAME'"
    az containerapp env create \
      --name "$ENV_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --location "$LOCATION" \
      --logs-destination none \
      -o none
  fi
fi

ENV_DEFAULT_DOMAIN="$(az containerapp env show \
  -n "$ENV_NAME" -g "$RESOURCE_GROUP" \
  --query properties.defaultDomain -o tsv)"
say "Environment default domain: $ENV_DEFAULT_DOMAIN"

# ---- 3. Azure Container Registry --------------------------------------------
if [[ -z "$ACR_NAME" ]]; then
  ACR_NAME="$(az acr list -g "$RESOURCE_GROUP" --query "[0].name" -o tsv 2>/dev/null || true)"
fi

if [[ -z "$ACR_NAME" ]]; then
  ACR_NAME="acrdemo1$(openssl rand -hex 3)"
  say "Creating Azure Container Registry '$ACR_NAME' (Basic, admin enabled)"
  az acr create \
    -n "$ACR_NAME" \
    -g "$RESOURCE_GROUP" \
    --sku Basic \
    --admin-enabled true \
    --location "$LOCATION" \
    -o none
else
  say "Reusing existing Azure Container Registry '$ACR_NAME'"
  az acr update -n "$ACR_NAME" -g "$RESOURCE_GROUP" --admin-enabled true -o none >/dev/null
fi

ACR_LOGIN_SERVER="$(az acr show -n "$ACR_NAME" -g "$RESOURCE_GROUP" --query loginServer -o tsv)"

# ---- 4. Backend image -------------------------------------------------------
BACKEND_IMAGE="$ACR_LOGIN_SERVER/$BACKEND_APP:$IMAGE_TAG"
say "Building backend image $BACKEND_IMAGE (ACR Tasks)"
az acr build \
  --registry "$ACR_NAME" \
  --image "$BACKEND_APP:$IMAGE_TAG" \
  --image "$BACKEND_APP:latest" \
  --file backend/Dockerfile \
  --platform linux \
  backend \
  -o none

# ---- 5. Backend container app -----------------------------------------------
if az containerapp show -n "$BACKEND_APP" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  say "Updating existing backend app '$BACKEND_APP' to $IMAGE_TAG"
  az containerapp update \
    --name "$BACKEND_APP" --resource-group "$RESOURCE_GROUP" \
    --image "$BACKEND_IMAGE" \
    -o none
else
  say "Creating backend app '$BACKEND_APP'"
  ACR_USERNAME="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
  ACR_PASSWORD="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
  az containerapp create \
    --name "$BACKEND_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$ENV_NAME" \
    --image "$BACKEND_IMAGE" \
    --target-port 8080 \
    --ingress external \
    --registry-server "$ACR_LOGIN_SERVER" \
    --registry-username "$ACR_USERNAME" \
    --registry-password "$ACR_PASSWORD" \
    --min-replicas 1 --max-replicas 3 \
    --cpu 0.5 --memory 1.0Gi \
    -o none
fi

say "Assigning system-assigned managed identity to backend"
az containerapp identity assign \
  --name "$BACKEND_APP" --resource-group "$RESOURCE_GROUP" \
  --system-assigned -o none

say "Setting backend env vars"
az containerapp update \
  --name "$BACKEND_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "Demo1__SearchEndpoint=$DEMO1__SEARCHENDPOINT" \
    "Demo1__KnowledgeBaseName=$DEMO1__KNOWLEDGEBASENAME" \
    "Demo1__FoundryOpenAIEndpoint=$DEMO1__FOUNDRYOPENAIENDPOINT" \
    "Demo1__ChatDeployment=$DEMO1__CHATDEPLOYMENT" \
    "Demo1__McpServerUrl=$DEMO1__MCPSERVERURL" \
    "Demo1__UseHostedAgent=$DEMO1__USEHOSTEDAGENT" \
    "Demo1__ProjectEndpoint=$DEMO1__PROJECTENDPOINT" \
    "Demo1__HostedAgentId=$DEMO1__HOSTEDAGENTID" \
    "ASPNETCORE_ENVIRONMENT=Production" \
  -o none

BACKEND_FQDN="$(az containerapp show \
  -n "$BACKEND_APP" -g "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv)"
BACKEND_URL="https://$BACKEND_FQDN"
say "Backend URL: $BACKEND_URL"

BACKEND_MI_PRINCIPAL_ID="$(az containerapp identity show \
  -n "$BACKEND_APP" -g "$RESOURCE_GROUP" \
  --query principalId -o tsv)"
say "Backend managed identity principal: $BACKEND_MI_PRINCIPAL_ID"

# ---- 6. Grant RBAC to the backend's managed identity ------------------------
FOUNDRY_RG="$(az cognitiveservices account list \
  --query "[?name=='$FOUNDRY_ACCOUNT_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"
SEARCH_RG="$(az search service list \
  --query "[?name=='$SEARCH_SERVICE_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"

if [[ -n "$FOUNDRY_RG" ]]; then
  FOUNDRY_ID="$(az cognitiveservices account show \
    -n "$FOUNDRY_ACCOUNT_NAME" -g "$FOUNDRY_RG" --query id -o tsv)"
  PROJECT_SCOPE="$FOUNDRY_ID/projects/$FOUNDRY_PROJECT_NAME"

  # Roles required by the hosted-agent path (in addition to the in-process
  # path's 'Cognitive Services OpenAI User'):
  #   * Cognitive Services User (account scope) — generic data-plane read
  #     against AIServices/* endpoints. Foundry has disableLocalAuth=true so
  #     this is the role that makes our SAMI an "interactive" caller for the
  #     project's REST surfaces (threads, messages, runs).
  #   * Azure AI Administrator (account scope) — grants the broad
  #     'Microsoft.CognitiveServices/*' data action set the persistent-agents
  #     API requires (specifically AIServices/agents/read on POST .../threads).
  #     'Azure AI Developer' is NOT sufficient — its dataActions list is
  #     limited to OpenAI/SpeechServices/ContentSafety/MaaS.
  #   * Cognitive Services User (project scope) — required because Foundry
  #     enforces project-level RBAC on the project sub-resource.
  for ROLE in \
      "Cognitive Services OpenAI User" \
      "Cognitive Services User" \
      "Azure AI Administrator"; do
    say "Granting '$ROLE' on $FOUNDRY_ACCOUNT_NAME"
    az role assignment create \
      --assignee-object-id "$BACKEND_MI_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" \
      --scope "$FOUNDRY_ID" -o none 2>/dev/null || \
      say "  (already assigned)"
  done

  for ROLE in \
      "Cognitive Services User" \
      "Azure AI Developer"; do
    say "Granting '$ROLE' on project $FOUNDRY_PROJECT_NAME"
    az role assignment create \
      --assignee-object-id "$BACKEND_MI_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" \
      --scope "$PROJECT_SCOPE" -o none 2>/dev/null || \
      say "  (already assigned)"
  done
else
  warn "Foundry account '$FOUNDRY_ACCOUNT_NAME' not found; skipping role assignment"
fi

if [[ -n "$SEARCH_RG" ]]; then
  SEARCH_ID="$(az search service show \
    -n "$SEARCH_SERVICE_NAME" -g "$SEARCH_RG" --query id -o tsv)"
  # 'Search Index Data Reader' lets the backend call KB.Retrieve;
  # 'Search Service Contributor' lets it read the KB definition itself
  # (required by the SDK to resolve the KB name → backing index).
  for ROLE in \
      "Search Index Data Reader" \
      "Search Service Contributor"; do
    say "Granting '$ROLE' on $SEARCH_SERVICE_NAME"
    az role assignment create \
      --assignee-object-id "$BACKEND_MI_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" \
      --scope "$SEARCH_ID" -o none 2>/dev/null || \
      say "  (already assigned)"
  done
else
  warn "Search service '$SEARCH_SERVICE_NAME' not found; skipping role assignment"
fi

# ---- 7. Frontend image ------------------------------------------------------
FRONTEND_IMAGE="$ACR_LOGIN_SERVER/$FRONTEND_APP:$IMAGE_TAG"
say "Building frontend image $FRONTEND_IMAGE (ACR Tasks)"
az acr build \
  --registry "$ACR_NAME" \
  --image "$FRONTEND_APP:$IMAGE_TAG" \
  --image "$FRONTEND_APP:latest" \
  --file frontend/Dockerfile \
  --platform linux \
  frontend \
  -o none

# ---- 8. Frontend container app ----------------------------------------------
if az containerapp show -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  say "Updating existing frontend app '$FRONTEND_APP' to $IMAGE_TAG"
  az containerapp update \
    --name "$FRONTEND_APP" --resource-group "$RESOURCE_GROUP" \
    --image "$FRONTEND_IMAGE" \
    -o none
else
  say "Creating frontend app '$FRONTEND_APP'"
  ACR_USERNAME="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
  ACR_PASSWORD="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
  az containerapp create \
    --name "$FRONTEND_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$ENV_NAME" \
    --image "$FRONTEND_IMAGE" \
    --target-port 8080 \
    --ingress external \
    --registry-server "$ACR_LOGIN_SERVER" \
    --registry-username "$ACR_USERNAME" \
    --registry-password "$ACR_PASSWORD" \
    --min-replicas 1 --max-replicas 3 \
    --cpu 0.25 --memory 0.5Gi \
    -o none
fi

say "Pointing frontend nginx proxy at $BACKEND_URL"
az containerapp update \
  --name "$FRONTEND_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "BACKEND_URL=$BACKEND_URL" "BACKEND_HOST=$BACKEND_FQDN" \
  -o none

FRONTEND_FQDN="$(az containerapp show \
  -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv)"

# ---- 9. Summary -------------------------------------------------------------
cat <<EOF

================================================================================
 Deployment complete
================================================================================
  Resource group : $RESOURCE_GROUP
  Environment    : $ENV_NAME ($LOCATION, $ENV_MODE)
  Registry       : $ACR_LOGIN_SERVER
  Backend API    : https://$BACKEND_FQDN
                   curl https://$BACKEND_FQDN/health
  Frontend       : https://$FRONTEND_FQDN

  RBAC propagation can take several minutes. If the first chat request returns
  401 from the backend, wait 5–10 minutes and retry.
================================================================================
EOF
