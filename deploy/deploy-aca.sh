#!/usr/bin/env bash
# Deploy the demo1 **frontend** to Azure Container Apps.
#
# The agent itself lives in Foundry's Hosted Agent Service (see
# deploy/deploy-agent.sh). This Container App hosts ONLY the frontend:
#
#   * chatbot-web    — multi-container app:
#                        - nginx serves the React/Vite SPA on port 8080 and
#                          proxies /api/responses to the sidecar.
#                        - token-proxy sidecar (Node) on 127.0.0.1:8090 acquires
#                          an Entra token via the app's managed identity and
#                          forwards POSTs to the Foundry hosted agent's
#                          Responses endpoint (streaming SSE).
#
#   Browser → nginx → token-proxy → Foundry Hosted Agent Service → KB → MCP
#
# Images are built in the cloud via Azure Container Registry Tasks
# (`az acr build`), so Docker is not required locally.
#
# Usage:
#   FOUNDRY_AGENT_RESPONSES_URL="https://<acct>.services.ai.azure.com/api/projects/<proj>/agents/<agent>/endpoint/protocols/openai/responses?api-version=v1" \
#     ./deploy/deploy-aca.sh
#
#   # or let the script build the URL from the project + agent name:
#   FOUNDRY_ACCOUNT_NAME=researchfoundry FOUNDRY_PROJECT_NAME=researchProject \
#     AGENT_NAME=demo1-kb-mslearn ./deploy/deploy-aca.sh
#
# Requirements:
#   * Azure CLI 2.86+ and the `containerapp` extension 1.3.0b4+
#   * `az login` with a Microsoft Entra account (personal MSA not supported)
#   * The agent already deployed to Foundry Agent Service (deploy/deploy-agent.sh)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ---- Configuration ----------------------------------------------------------
ENV_MODE="${ENV_MODE:-standard}"
LOCATION="${LOCATION:-westcentralus}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-demo1-aca}"
ENV_NAME="${ENV_NAME:-cae-demo1-${ENV_MODE}}"
ACR_NAME="${ACR_NAME:-}"   # auto-detected or auto-created
FRONTEND_APP="${FRONTEND_APP:-chatbot-web}"
PROXY_CONTAINER="${PROXY_CONTAINER:-token-proxy}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"

# Foundry hosted agent the sidecar forwards to.
AGENT_NAME="${AGENT_NAME:-demo1-kb-mslearn}"
FOUNDRY_ACCOUNT_NAME="${FOUNDRY_ACCOUNT_NAME:-researchfoundry}"
FOUNDRY_PROJECT_NAME="${FOUNDRY_PROJECT_NAME:-researchProject}"
FOUNDRY_TOKEN_SCOPE="${FOUNDRY_TOKEN_SCOPE:-https://ai.azure.com/.default}"

# The full Responses URL of the Foundry hosted agent. Built from the project +
# agent name unless supplied explicitly.
PROJECT_ENDPOINT="https://${FOUNDRY_ACCOUNT_NAME}.services.ai.azure.com/api/projects/${FOUNDRY_PROJECT_NAME}"
FOUNDRY_AGENT_RESPONSES_URL="${FOUNDRY_AGENT_RESPONSES_URL:-${PROJECT_ENDPOINT}/agents/${AGENT_NAME}/endpoint/protocols/openai/responses?api-version=v1}"

# ---- Helpers ----------------------------------------------------------------
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
require() { command -v "$1" >/dev/null 2>&1 || { warn "Missing required tool: $1"; exit 1; }; }

# ---- Pre-flight -------------------------------------------------------------
require az

ACCOUNT_USER="$(az account show --query 'user.name' -o tsv 2>/dev/null || true)"
SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
if [[ -z "$SUBSCRIPTION_ID" ]]; then
  warn "Not logged in to Azure. Run 'az login' first."
  exit 1
fi
say "Subscription: $SUBSCRIPTION_ID  ($ACCOUNT_USER)"
say "Agent Responses URL: $FOUNDRY_AGENT_RESPONSES_URL"

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

# ---- 4. Build images (frontend only) ----------------------------------------
FRONTEND_IMAGE="$ACR_LOGIN_SERVER/$FRONTEND_APP:$IMAGE_TAG"
PROXY_IMAGE="$ACR_LOGIN_SERVER/$PROXY_CONTAINER:$IMAGE_TAG"

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

ACR_USERNAME="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
ACR_PASSWORD="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"

# ---- 5. Frontend container app (multi-container: nginx + token-proxy) -------
# Both containers share the network namespace and a single system-assigned
# managed identity. The sidecar uses that identity to mint the Entra token the
# Foundry agent endpoint requires.
FRONTEND_YAML="$(mktemp)"
trap 'rm -f "$FRONTEND_YAML"' EXIT

cat > "$FRONTEND_YAML" <<EOF
identity:
  type: SystemAssigned
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
          - name: FOUNDRY_AGENT_RESPONSES_URL
            value: "$FOUNDRY_AGENT_RESPONSES_URL"
          - name: FOUNDRY_TOKEN_SCOPE
            value: "$FOUNDRY_TOKEN_SCOPE"
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

# ---- 6. Frontend RBAC: invoke the Foundry hosted agent ----------------------
# The sidecar's managed identity calls the Foundry agent's Responses endpoint.
# Interacting with an agent is a data-plane action covered by the Foundry User
# role (formerly "Azure AI User") at the project scope.
FRONTEND_MI_PRINCIPAL_ID="$(az containerapp identity show \
  -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" \
  --query principalId -o tsv 2>/dev/null || true)"
say "Frontend managed identity: ${FRONTEND_MI_PRINCIPAL_ID:-<none>}"

FOUNDRY_RG="$(az cognitiveservices account list \
  --query "[?name=='$FOUNDRY_ACCOUNT_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"

if [[ -n "$FRONTEND_MI_PRINCIPAL_ID" && -n "$FOUNDRY_RG" ]]; then
  FOUNDRY_ID="$(az cognitiveservices account show \
    -n "$FOUNDRY_ACCOUNT_NAME" -g "$FOUNDRY_RG" --query id -o tsv)"
  PROJECT_SCOPE="$FOUNDRY_ID/projects/$FOUNDRY_PROJECT_NAME"
  say "Granting frontend MI 'Azure AI User' on project $FOUNDRY_PROJECT_NAME"
  az role assignment create \
    --assignee-object-id "$FRONTEND_MI_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Azure AI User" \
    --scope "$PROJECT_SCOPE" -o none 2>/dev/null || say "  (already assigned)"
else
  warn "Could not resolve frontend MI or Foundry account; grant 'Azure AI User'"
  warn "on the project to the frontend app's identity manually."
fi

FRONTEND_FQDN="$(az containerapp show \
  -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" \
  --query properties.configuration.ingress.fqdn -o tsv)"

# ---- 7. Summary -------------------------------------------------------------
cat <<EOF

================================================================================
 Frontend deployment complete
================================================================================
  Resource group : $RESOURCE_GROUP
  Environment    : $ENV_NAME ($LOCATION, $ENV_MODE)
  Registry       : $ACR_LOGIN_SERVER
  Frontend       : https://$FRONTEND_FQDN
                   - nginx (SPA + /api/responses)
                   - $PROXY_CONTAINER sidecar -> Foundry hosted agent
  Agent endpoint : $FOUNDRY_AGENT_RESPONSES_URL

  The agent runs in Foundry Agent Service (deploy/deploy-agent.sh), NOT here.

  RBAC propagation can take several minutes. If the first chat request returns
  401 or 403, wait 5–10 minutes and retry.
================================================================================
EOF
