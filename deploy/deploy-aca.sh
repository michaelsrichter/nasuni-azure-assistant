#!/usr/bin/env bash
# Deploy the demo1 chatbot to Azure Container Apps.
#
# Architecture (all in one ACA environment):
#
#   * hosted-agent   — .NET 10 Foundry hosted agent (Demo1.Agent, port 8088).
#                      Internal ingress only. Owns the knowledge_base_search
#                      function tool over kb-mslearn. Built from
#                      hosted-agent/Dockerfile.
#   * chatbot-web    — multi-container app:
#                        - nginx serves the React/Vite SPA on port 8080 and
#                          proxies /api/responses to the sidecar.
#                        - token-proxy sidecar (Node) on 127.0.0.1:8090 forwards
#                          POSTs to the hosted agent's /responses (streaming SSE).
#                      Built from frontend/Dockerfile + frontend/proxy/Dockerfile.
#
# Images are built in the cloud via Azure Container Registry Tasks
# (`az acr build`), so Docker is not required locally.
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
ENV_MODE="${ENV_MODE:-standard}"
LOCATION="${LOCATION:-westcentralus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-demo1-aca}"
ENV_NAME="${ENV_NAME:-cae-demo1-${ENV_MODE}}"
ACR_NAME="${ACR_NAME:-}"   # auto-detected or auto-created
AGENT_APP="${AGENT_APP:-hosted-agent}"
FRONTEND_APP="${FRONTEND_APP:-chatbot-web}"
PROXY_CONTAINER="${PROXY_CONTAINER:-token-proxy}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"

# Resources from the infra CLI (override if you re-provisioned).
DEMO1_SEARCH_ENDPOINT="${DEMO1_SEARCH_ENDPOINT:-https://srch-demo1-d9129d.search.windows.net}"
DEMO1_KNOWLEDGE_BASE_NAME="${DEMO1_KNOWLEDGE_BASE_NAME:-kb-mslearn}"
AZURE_AI_MODEL_DEPLOYMENT_NAME="${AZURE_AI_MODEL_DEPLOYMENT_NAME:-gpt-4.1-mini}"
FOUNDRY_PROJECT_ENDPOINT="${FOUNDRY_PROJECT_ENDPOINT:-https://researchfoundry.services.ai.azure.com/api/projects/researchProject}"

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

# ---- 4. Build images --------------------------------------------------------
AGENT_IMAGE="$ACR_LOGIN_SERVER/$AGENT_APP:$IMAGE_TAG"
FRONTEND_IMAGE="$ACR_LOGIN_SERVER/$FRONTEND_APP:$IMAGE_TAG"
PROXY_IMAGE="$ACR_LOGIN_SERVER/$PROXY_CONTAINER:$IMAGE_TAG"

say "Building hosted-agent image $AGENT_IMAGE (ACR Tasks)"
az acr build \
  --registry "$ACR_NAME" \
  --image "$AGENT_APP:$IMAGE_TAG" \
  --image "$AGENT_APP:latest" \
  --file hosted-agent/Dockerfile \
  --platform linux \
  hosted-agent \
  -o none

say "Building frontend (nginx) image $FRONTEND_IMAGE (ACR Tasks)"
az acr build \
  --registry "$ACR_NAME" \
  --image "$FRONTEND_APP:$IMAGE_TAG" \
  --image "$FRONTEND_APP:latest" \
  --file frontend/Dockerfile \
  --platform linux \
  frontend \
  -o none

say "Building token-proxy image $PROXY_IMAGE (ACR Tasks)"
az acr build \
  --registry "$ACR_NAME" \
  --image "$PROXY_CONTAINER:$IMAGE_TAG" \
  --image "$PROXY_CONTAINER:latest" \
  --file frontend/proxy/Dockerfile \
  --platform linux \
  frontend/proxy \
  -o none

# ---- 5. Hosted agent container app ------------------------------------------
ACR_USERNAME="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
ACR_PASSWORD="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"

if az containerapp show -n "$AGENT_APP" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  say "Updating existing hosted-agent app '$AGENT_APP' to $IMAGE_TAG"
  az containerapp update \
    --name "$AGENT_APP" --resource-group "$RESOURCE_GROUP" \
    --image "$AGENT_IMAGE" \
    -o none
else
  say "Creating hosted-agent app '$AGENT_APP' (internal ingress)"
  az containerapp create \
    --name "$AGENT_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$ENV_NAME" \
    --image "$AGENT_IMAGE" \
    --target-port 8088 \
    --ingress internal \
    --transport http \
    --registry-server "$ACR_LOGIN_SERVER" \
    --registry-username "$ACR_USERNAME" \
    --registry-password "$ACR_PASSWORD" \
    --min-replicas 1 --max-replicas 3 \
    --cpu 0.5 --memory 1.0Gi \
    -o none
fi

say "Assigning system-assigned managed identity to hosted-agent"
az containerapp identity assign \
  --name "$AGENT_APP" --resource-group "$RESOURCE_GROUP" \
  --system-assigned -o none

say "Setting hosted-agent env vars"
az containerapp update \
  --name "$AGENT_APP" --resource-group "$RESOURCE_GROUP" \
  --set-env-vars \
    "FOUNDRY_PROJECT_ENDPOINT=$FOUNDRY_PROJECT_ENDPOINT" \
    "AZURE_AI_MODEL_DEPLOYMENT_NAME=$AZURE_AI_MODEL_DEPLOYMENT_NAME" \
    "DEMO1_SEARCH_ENDPOINT=$DEMO1_SEARCH_ENDPOINT" \
    "DEMO1_KNOWLEDGE_BASE_NAME=$DEMO1_KNOWLEDGE_BASE_NAME" \
    "ASPNETCORE_ENVIRONMENT=Production" \
  -o none

AGENT_FQDN="$(az containerapp show \
  -n "$AGENT_APP" -g "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv)"
AGENT_URL="https://$AGENT_FQDN"
say "Hosted-agent internal URL: $AGENT_URL"

AGENT_MI_PRINCIPAL_ID="$(az containerapp identity show \
  -n "$AGENT_APP" -g "$RESOURCE_GROUP" \
  --query principalId -o tsv)"
say "Hosted-agent managed identity: $AGENT_MI_PRINCIPAL_ID"

# ---- 6. Hosted-agent RBAC ---------------------------------------------------
# The agent's MI needs:
#   * Cognitive Services OpenAI User on the Foundry account — to call chat
#     completions against the model deployment.
#   * Cognitive Services User on the project — to issue Responses / tool calls.
#   * Search Index Data Reader + Search Service Contributor on the search
#     service — to call KB.Retrieve and resolve the KB definition.
FOUNDRY_RG="$(az cognitiveservices account list \
  --query "[?name=='$FOUNDRY_ACCOUNT_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"
SEARCH_RG="$(az search service list \
  --query "[?name=='$SEARCH_SERVICE_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"

if [[ -n "$FOUNDRY_RG" ]]; then
  FOUNDRY_ID="$(az cognitiveservices account show \
    -n "$FOUNDRY_ACCOUNT_NAME" -g "$FOUNDRY_RG" --query id -o tsv)"
  PROJECT_SCOPE="$FOUNDRY_ID/projects/$FOUNDRY_PROJECT_NAME"

  for ROLE in "Cognitive Services OpenAI User" "Cognitive Services User"; do
    say "Granting agent MI '$ROLE' on $FOUNDRY_ACCOUNT_NAME"
    az role assignment create \
      --assignee-object-id "$AGENT_MI_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" \
      --scope "$FOUNDRY_ID" -o none 2>/dev/null || say "  (already assigned)"
  done

  say "Granting agent MI 'Cognitive Services User' on project $FOUNDRY_PROJECT_NAME"
  az role assignment create \
    --assignee-object-id "$AGENT_MI_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Cognitive Services User" \
    --scope "$PROJECT_SCOPE" -o none 2>/dev/null || say "  (already assigned)"
else
  warn "Foundry account '$FOUNDRY_ACCOUNT_NAME' not found; skipping role assignment"
fi

if [[ -n "$SEARCH_RG" ]]; then
  SEARCH_ID="$(az search service show \
    -n "$SEARCH_SERVICE_NAME" -g "$SEARCH_RG" --query id -o tsv)"
  for ROLE in "Search Index Data Reader" "Search Service Contributor"; do
    say "Granting agent MI '$ROLE' on $SEARCH_SERVICE_NAME"
    az role assignment create \
      --assignee-object-id "$AGENT_MI_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$ROLE" \
      --scope "$SEARCH_ID" -o none 2>/dev/null || say "  (already assigned)"
  done
else
  warn "Search service '$SEARCH_SERVICE_NAME' not found; skipping role assignment"
fi

# ---- 7. Frontend container app (multi-container: nginx + token-proxy) -------
# We render the full container spec via YAML so both containers share the same
# revision. The proxy is reachable on 127.0.0.1:8090 inside the app.
FRONTEND_YAML="$(mktemp)"
trap 'rm -f "$FRONTEND_YAML"' EXIT

cat > "$FRONTEND_YAML" <<EOF
properties:
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8080
      transport: http
      allowInsecure: false
    registries:
      - server: $ACR_LOGIN_SERVER
        username: $ACR_USERNAME
        passwordSecretRef: registry-password
    secrets:
      - name: registry-password
        value: $ACR_PASSWORD
  template:
    scale:
      minReplicas: 1
      maxReplicas: 3
    containers:
      - name: nginx
        image: $FRONTEND_IMAGE
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: PROXY_URL
            value: http://127.0.0.1:8090
      - name: $PROXY_CONTAINER
        image: $PROXY_IMAGE
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: FOUNDRY_AGENT_ENDPOINT
            value: $AGENT_URL
          - name: FOUNDRY_TOKEN_SCOPE
            value: ""
          - name: PROXY_PORT
            value: "8090"
          - name: PROXY_HOST
            value: 0.0.0.0
EOF

if az containerapp show -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  say "Updating existing frontend app '$FRONTEND_APP' from YAML"
  az containerapp update \
    --name "$FRONTEND_APP" --resource-group "$RESOURCE_GROUP" \
    --yaml "$FRONTEND_YAML" \
    -o none
else
  say "Creating frontend app '$FRONTEND_APP' (multi-container) from YAML"
  az containerapp create \
    --name "$FRONTEND_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$ENV_NAME" \
    --yaml "$FRONTEND_YAML" \
    -o none
fi

FRONTEND_FQDN="$(az containerapp show \
  -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv)"

# ---- 8. Summary -------------------------------------------------------------
cat <<EOF

================================================================================
 Deployment complete
================================================================================
  Resource group : $RESOURCE_GROUP
  Environment    : $ENV_NAME ($LOCATION, $ENV_MODE)
  Registry       : $ACR_LOGIN_SERVER
  Hosted agent   : $AGENT_URL  (internal ingress)
  Frontend       : https://$FRONTEND_FQDN
                   - nginx (SPA + /api/responses)
                   - $PROXY_CONTAINER sidecar -> hosted-agent

  RBAC propagation can take several minutes. If the first chat request returns
  401 or 403, wait 5–10 minutes and retry.
================================================================================
EOF
