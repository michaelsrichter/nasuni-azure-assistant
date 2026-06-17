#!/usr/bin/env bash
# Deploy the demo1 chatbot to Azure Container Apps **Express** (preview).
#
# Express environments are managed by Azure and require no VNet or Log Analytics
# workspace, so they spin up in well under a minute. Two apps are deployed:
#
#   * chatbot-api       — the .NET 10 backend (built from ./backend/Dockerfile)
#   * chatbot-web       — the nginx-served React frontend that proxies /api/* to
#                         the backend (built from ./frontend/Dockerfile)
#
# Both images are built in the cloud using Azure Container Registry Tasks via
# `az containerapp up --source`, so Docker is not required locally.
#
# Reference: https://learn.microsoft.com/azure/container-apps/deploy-express-cli
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
# Express is preview-only in westcentralus or eastasia.
LOCATION="${LOCATION:-westcentralus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-demo1-aca}"
ENV_NAME="${ENV_NAME:-cae-demo1}"
BACKEND_APP="${BACKEND_APP:-chatbot-api}"
FRONTEND_APP="${FRONTEND_APP:-chatbot-web}"

# Resources from the infra CLI (override if you re-provisioned).
DEMO1__SEARCHENDPOINT="${DEMO1__SEARCHENDPOINT:-https://srch-demo1-d9129d.search.windows.net}"
DEMO1__KNOWLEDGEBASENAME="${DEMO1__KNOWLEDGEBASENAME:-kb-mslearn}"
DEMO1__FOUNDRYOPENAIENDPOINT="${DEMO1__FOUNDRYOPENAIENDPOINT:-https://researchfoundry.cognitiveservices.azure.com}"
DEMO1__CHATDEPLOYMENT="${DEMO1__CHATDEPLOYMENT:-gpt-4.1-mini}"
DEMO1__MCPSERVERURL="${DEMO1__MCPSERVERURL:-https://learn.microsoft.com/api/mcp}"

FOUNDRY_ACCOUNT_NAME="${FOUNDRY_ACCOUNT_NAME:-researchfoundry}"
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

# ---- 2. Express environment -------------------------------------------------
if az containerapp env show -n "$ENV_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  say "Container Apps environment '$ENV_NAME' already exists"
else
  say "Creating express Container Apps environment '$ENV_NAME'"
  az containerapp env create \
    --environment-mode express \
    --name "$ENV_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --logs-destination none \
    -o none
fi

ENV_DEFAULT_DOMAIN="$(az containerapp env show \
  -n "$ENV_NAME" -g "$RESOURCE_GROUP" \
  --query properties.defaultDomain -o tsv)"
say "Environment default domain: $ENV_DEFAULT_DOMAIN"

# ---- 3. Backend app ---------------------------------------------------------
say "Building and deploying backend '$BACKEND_APP' from ./backend (ACR Tasks build)"
az containerapp up \
  --name "$BACKEND_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --location "$LOCATION" \
  --source ./backend \
  --target-port 8080 \
  --ingress external \
  -o none

say "Configuring backend env vars + system-assigned managed identity"
az containerapp identity assign \
  --name "$BACKEND_APP" --resource-group "$RESOURCE_GROUP" \
  --system-assigned -o none

az containerapp update \
  --name "$BACKEND_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "Demo1__SearchEndpoint=$DEMO1__SEARCHENDPOINT" \
    "Demo1__KnowledgeBaseName=$DEMO1__KNOWLEDGEBASENAME" \
    "Demo1__FoundryOpenAIEndpoint=$DEMO1__FOUNDRYOPENAIENDPOINT" \
    "Demo1__ChatDeployment=$DEMO1__CHATDEPLOYMENT" \
    "Demo1__McpServerUrl=$DEMO1__MCPSERVERURL" \
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

# ---- 4. Grant RBAC to the backend's managed identity ------------------------
FOUNDRY_RG="$(az cognitiveservices account list \
  --query "[?name=='$FOUNDRY_ACCOUNT_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"
SEARCH_RG="$(az search service list \
  --query "[?name=='$SEARCH_SERVICE_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"

if [[ -n "$FOUNDRY_RG" ]]; then
  FOUNDRY_ID="$(az cognitiveservices account show \
    -n "$FOUNDRY_ACCOUNT_NAME" -g "$FOUNDRY_RG" --query id -o tsv)"
  say "Granting 'Cognitive Services OpenAI User' on $FOUNDRY_ACCOUNT_NAME"
  az role assignment create \
    --assignee-object-id "$BACKEND_MI_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Cognitive Services OpenAI User" \
    --scope "$FOUNDRY_ID" -o none 2>/dev/null || \
    say "  (already assigned)"
else
  warn "Foundry account '$FOUNDRY_ACCOUNT_NAME' not found; skipping role assignment"
fi

if [[ -n "$SEARCH_RG" ]]; then
  SEARCH_ID="$(az search service show \
    -n "$SEARCH_SERVICE_NAME" -g "$SEARCH_RG" --query id -o tsv)"
  say "Granting 'Search Index Data Reader' on $SEARCH_SERVICE_NAME"
  az role assignment create \
    --assignee-object-id "$BACKEND_MI_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Search Index Data Reader" \
    --scope "$SEARCH_ID" -o none 2>/dev/null || \
    say "  (already assigned)"
else
  warn "Search service '$SEARCH_SERVICE_NAME' not found; skipping role assignment"
fi

# ---- 5. Frontend app --------------------------------------------------------
say "Building and deploying frontend '$FRONTEND_APP' from ./frontend"
az containerapp up \
  --name "$FRONTEND_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --environment "$ENV_NAME" \
  --location "$LOCATION" \
  --source ./frontend \
  --target-port 8080 \
  --ingress external \
  -o none

say "Pointing frontend nginx proxy at $BACKEND_URL"
az containerapp update \
  --name "$FRONTEND_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "BACKEND_URL=$BACKEND_URL" \
  -o none

FRONTEND_FQDN="$(az containerapp show \
  -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv)"

# ---- 6. Summary -------------------------------------------------------------
cat <<EOF

================================================================================
 Deployment complete
================================================================================
  Resource group : $RESOURCE_GROUP
  Environment    : $ENV_NAME ($LOCATION, express)
  Backend API    : https://$BACKEND_FQDN
                   curl https://$BACKEND_FQDN/health
  Frontend       : https://$FRONTEND_FQDN

  RBAC propagation can take several minutes. If the first chat request returns
  401 from the backend, wait 5–10 minutes and retry.
================================================================================
EOF
