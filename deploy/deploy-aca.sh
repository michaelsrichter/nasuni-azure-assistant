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

# Frontend telemetry (injected into the SPA at container start via nginx).
#   * Application Insights — provisioned/reused below unless a connection string
#     is supplied explicitly. Set APPINSIGHTS_NAME='' to skip provisioning.
#   * Clarity — supply CLARITY_PROJECT_ID to enable; empty = disabled (no-op).
APPINSIGHTS_NAME="${APPINSIGHTS_NAME:-appi-demo1}"
# App Insights isn't available in every region (e.g. westcentralus). It can live
# in a different region than the Container App — the connection string carries
# its own ingestion endpoint — so default to a supported nearby region.
APPINSIGHTS_LOCATION="${APPINSIGHTS_LOCATION:-westus2}"
APPLICATIONINSIGHTS_CONNECTION_STRING="${APPLICATIONINSIGHTS_CONNECTION_STRING:-}"
CLARITY_PROJECT_ID="${CLARITY_PROJECT_ID:-}"

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

# ---- 3b. Application Insights (frontend telemetry) --------------------------
# Provision (or reuse) a workspace-based App Insights component and capture its
# connection string. Skipped when a connection string is supplied explicitly or
# APPINSIGHTS_NAME is blank. The string is NOT committed to source — it is
# injected into the SPA at container start via nginx (see nginx.conf.template).
if [[ -z "$APPLICATIONINSIGHTS_CONNECTION_STRING" && -n "$APPINSIGHTS_NAME" ]]; then
  if ! az extension show -n application-insights >/dev/null 2>&1; then
    az extension add -n application-insights --yes >/dev/null 2>&1 || true
  fi
  if az monitor app-insights component show --app "$APPINSIGHTS_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
    say "Reusing Application Insights component '$APPINSIGHTS_NAME'"
  else
    say "Creating Application Insights component '$APPINSIGHTS_NAME' in $APPINSIGHTS_LOCATION"
    az monitor app-insights component create \
      --app "$APPINSIGHTS_NAME" \
      --location "$APPINSIGHTS_LOCATION" \
      --resource-group "$RESOURCE_GROUP" \
      --kind web \
      --application-type web \
      -o none
  fi
  APPLICATIONINSIGHTS_CONNECTION_STRING="$(az monitor app-insights component show \
    --app "$APPINSIGHTS_NAME" -g "$RESOURCE_GROUP" --query connectionString -o tsv 2>/dev/null || true)"
fi

if [[ -n "$APPLICATIONINSIGHTS_CONNECTION_STRING" ]]; then
  say "App Insights: enabled"
else
  warn "App Insights: disabled (no connection string) — frontend telemetry off"
fi
if [[ -n "$CLARITY_PROJECT_ID" ]]; then
  say "Clarity: enabled (project $CLARITY_PROJECT_ID)"
else
  say "Clarity: disabled (set CLARITY_PROJECT_ID to enable)"
fi

# ---- 4. Build images (frontend only) ----------------------------------------
# Each image's tag is derived from a hash of its build context, so an unchanged
# image is never rebuilt or re-pushed. The timestamp IMAGE_TAG is kept only for
# human-readable traceability ("FORCE_BUILD=1" bypasses the skip entirely).
FORCE_BUILD="${FORCE_BUILD:-}"

# Hash the relevant source for an image's build context. We hash file contents
# (sorted, so order is stable) and exclude regenerable artifacts. Extra args are
# additional paths/globs to exclude under the context dir.
context_hash() {
  local dir="$1"; shift
  local prune=(-name node_modules -o -name dist -o -name .vite -o -name '*.log')
  local extra
  for extra in "$@"; do prune+=(-o -path "$dir/$extra"); done
  # shellcheck disable=SC2046
  find "$dir" \( "${prune[@]}" \) -prune -o -type f -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -c1-12
}

# Return 0 (true) if <repo>:<tag> already exists in the registry.
tag_exists() {
  local repo="$1" tag="$2"
  az acr repository show-tags -n "$ACR_NAME" --repository "$repo" -o tsv 2>/dev/null \
    | grep -qx "$tag"
}

# build_image <repo> <dockerfile> <context> [exclude...]
# Builds via ACR Tasks only when the content hash isn't already published.
# Sets the global BUILT_IMAGE to the fully-qualified image reference to use.
BUILT_IMAGE=""
build_image() {
  local repo="$1" dockerfile="$2" context="$3"; shift 3
  local hash tag
  hash="$(context_hash "$context" "$@")"
  tag="sha-$hash"

  if [[ -z "$FORCE_BUILD" ]] && tag_exists "$repo" "$tag"; then
    say "Skipping $repo build — unchanged (image $repo:$tag already in ACR)"
  else
    say "Building $repo image ($repo:$tag) via ACR Tasks"
    az acr build \
      --registry "$ACR_NAME" \
      --image "$repo:$tag" \
      --image "$repo:$IMAGE_TAG" \
      --image "$repo:latest" \
      --file "$dockerfile" \
      --platform linux \
      "$context" \
      -o none
  fi
  BUILT_IMAGE="$ACR_LOGIN_SERVER/$repo:$tag"
}

# Sync the canonical architecture doc into the frontend build context so the
# in-app /architecture page bundles it (docs/ is outside the Docker context).
# Do this BEFORE hashing so doc changes correctly invalidate the SPA image.
say "Syncing docs/architecture.md into frontend/src/content"
mkdir -p frontend/src/content
cp docs/architecture.md frontend/src/content/architecture.md

# nginx SPA — exclude the proxy subdir so sidecar-only changes don't rebuild it.
build_image "$FRONTEND_APP" frontend/Dockerfile frontend proxy
FRONTEND_IMAGE="$BUILT_IMAGE"

# token-proxy sidecar — changes rarely; skipped on most frontend deploys.
build_image "$PROXY_CONTAINER" frontend/proxy/Dockerfile frontend/proxy
PROXY_IMAGE="$BUILT_IMAGE"

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
          - name: APPLICATIONINSIGHTS_CONNECTION_STRING
            value: "$APPLICATIONINSIGHTS_CONNECTION_STRING"
          - name: CLARITY_PROJECT_ID
            value: "$CLARITY_PROJECT_ID"
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
          - name: AZURE_USE_MANAGED_IDENTITY
            value: "true"
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
# Invoking a hosted agent is a data-plane action whose authorization is
# evaluated at the FOUNDRY ACCOUNT scope (not the project). The agent gateway
# reports the missing permission as
#   Microsoft.MachineLearningServices/workspaces/agents/action
# which is satisfied by the broad CognitiveServices data action
# (Microsoft.CognitiveServices/*) carried by "Cognitive Services User". Granting
# only project-scoped roles results in a 403 — the account-scope grant is what
# makes invocation work end-to-end.
#
# We assign roles by ID (the display names were recently changed: Azure AI User
# → Foundry User, etc.) so the grant doesn't silently fail on a renamed role.
ROLE_COGNITIVE_SERVICES_USER="a97b65f3-24c7-4388-baec-2e87b95c1773"  # Cognitive Services User
ROLE_FOUNDRY_AGENT_CONSUMER="eed3b665-ab3a-47b6-8f48-c9382fb1dad6"   # Foundry Agent Consumer (agent invoke/interact)
ROLE_FOUNDRY_PROJECT_RUNTIME_USER="142bfaed-a13f-4c2d-bed2-6db62c4a1009"  # Foundry Project Runtime User (responses/*)

FRONTEND_MI_PRINCIPAL_ID="$(az containerapp identity show \
  -n "$FRONTEND_APP" -g "$RESOURCE_GROUP" \
  --query principalId -o tsv 2>/dev/null || true)"
say "Frontend managed identity: ${FRONTEND_MI_PRINCIPAL_ID:-<none>}"

FOUNDRY_RG="$(az cognitiveservices account list \
  --query "[?name=='$FOUNDRY_ACCOUNT_NAME'] | [0].resourceGroup" -o tsv 2>/dev/null || true)"

grant_role() {  # <role-id> <scope> <description>
  local role="$1" scope="$2" desc="$3" out
  if out="$(az role assignment create \
      --assignee-object-id "$FRONTEND_MI_PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "$scope" -o none 2>&1)"; then
    say "  granted: $desc"
  elif grep -qi "already exists\|RoleAssignmentExists" <<<"$out"; then
    say "  (already assigned) $desc"
  else
    warn "  FAILED to grant $desc: $out"
  fi
}

if [[ -n "$FRONTEND_MI_PRINCIPAL_ID" && -n "$FOUNDRY_RG" ]]; then
  FOUNDRY_ID="$(az cognitiveservices account show \
    -n "$FOUNDRY_ACCOUNT_NAME" -g "$FOUNDRY_RG" --query id -o tsv)"
  PROJECT_SCOPE="$FOUNDRY_ID/projects/$FOUNDRY_PROJECT_NAME"
  say "Granting frontend MI agent-invoke roles"
  # Account-scope grant is the one that actually authorizes agent invocation.
  grant_role "$ROLE_COGNITIVE_SERVICES_USER"        "$FOUNDRY_ID"    "Cognitive Services User @ account"
  # Project-scope purpose-built roles for the Responses runtime.
  grant_role "$ROLE_FOUNDRY_AGENT_CONSUMER"         "$PROJECT_SCOPE" "Foundry Agent Consumer @ project"
  grant_role "$ROLE_FOUNDRY_PROJECT_RUNTIME_USER"   "$PROJECT_SCOPE" "Foundry Project Runtime User @ project"
else
  warn "Could not resolve frontend MI or Foundry account. Manually grant the"
  warn "frontend app identity 'Cognitive Services User' on the Foundry ACCOUNT"
  warn "($FOUNDRY_ACCOUNT_NAME) to allow it to invoke the hosted agent."
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
