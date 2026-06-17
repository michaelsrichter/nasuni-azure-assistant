using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.CognitiveServices;
using Azure.ResourceManager.Authorization;
using Azure.ResourceManager.Authorization.Models;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Search;
using Azure.ResourceManager.Search.Models;
using Demo1.Infra;

namespace Demo1.Infra.Commands;

public static class EnsureSearchCommand
{
    public static async Task<int> RunAsync(InfraConfig cfg, InfraState state, string statePath)
    {
        Console.WriteLine("=== ensure-search ===");

        var credential = new DefaultAzureCredential();
        var arm = new ArmClient(credential, cfg.SubscriptionId);
        var rg = arm.GetResourceGroupResource(
            ResourceGroupResource.CreateResourceIdentifier(cfg.SubscriptionId, cfg.ResourceGroup));

        // 1. Look for an existing AI Search service in the RG.
        SearchServiceResource? searchService = null;
        await foreach (var svc in rg.GetSearchServices().GetAllAsync())
        {
            searchService = svc;
            Console.WriteLine($"  Found existing Search service: {svc.Data.Name} ({svc.Data.Location})");
            break;
        }

        // 2. Create one if none exists.
        if (searchService is null)
        {
            var name = $"srch-demo1-{Guid.NewGuid().ToString("N")[..6]}";
            Console.WriteLine($"  No Search service in RG '{cfg.ResourceGroup}'. Creating '{name}' in {cfg.Location} (basic SKU)...");
            var data = new SearchServiceData(new AzureLocation(cfg.Location))
            {
                SearchSkuName = SearchServiceSkuName.Basic,
                ReplicaCount = 1,
                PartitionCount = 1,
                HostingMode = SearchServiceHostingMode.Default,
                PublicNetworkAccess = SearchServicePublicNetworkAccess.Enabled,
                AuthOptions = new SearchAadAuthDataPlaneAuthOptions(),
                Identity = new Azure.ResourceManager.Models.ManagedServiceIdentity(
                    Azure.ResourceManager.Models.ManagedServiceIdentityType.SystemAssigned),
            };
            var op = await rg.GetSearchServices().CreateOrUpdateAsync(WaitUntil.Completed, name, data);
            searchService = op.Value;
            Console.WriteLine($"  Created Search service: {searchService.Data.Name}");
        }
        else
        {
            // Existing service: ensure AAD-or-ApiKey auth is enabled. SDK internals are sealed for this
            // sub-property, so we use az CLI. The command is idempotent.
            Console.WriteLine($"  Ensuring AAD auth is enabled on existing service '{searchService.Data.Name}' via az CLI...");
            var psi = new System.Diagnostics.ProcessStartInfo("az",
                $"search service update --resource-group {cfg.ResourceGroup} --name {searchService.Data.Name} --auth-options aadOrApiKey --aad-auth-failure-mode http401WithBearerChallenge --output none")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = System.Diagnostics.Process.Start(psi)!;
            await proc.WaitForExitAsync();
            if (proc.ExitCode != 0)
            {
                var err = await proc.StandardError.ReadToEndAsync();
                throw new InvalidOperationException($"az search service update failed (exit {proc.ExitCode}): {err}");
            }
            Console.WriteLine($"  AAD-or-ApiKey auth confirmed on '{searchService.Data.Name}'.");
        }

        var searchName = searchService.Data.Name;
        var searchEndpoint = $"https://{searchName}.search.windows.net";
        state.SearchServiceName = searchName;
        state.SearchEndpoint = searchEndpoint;

        // 3. Grant the current user `Search Service Contributor` + `Search Index Data Contributor`
        //    on the search service so the data plane works for the rest of the demo.
        await EnsureRoleAssignmentsAsync(credential, arm, searchService);

        // 4. Make sure the Foundry account's managed identity also has Search Index Data Contributor,
        //    so the KB can ingest. Foundry account → system-assigned MI.
        var foundry = (await rg.GetCognitiveServicesAccountAsync(cfg.FoundryAccountName)).Value;
        if (foundry.Data.Identity?.PrincipalId is { } foundryPrincipalId)
        {
            await EnsureRoleAssignmentAsync(arm, searchService.Id, foundryPrincipalId.ToString(),
                roleDefinitionId: "8ebe5a00-799e-43f5-93ac-243d3dce84a7", // Search Index Data Contributor
                roleName: "Search Index Data Contributor",
                principalLabel: $"Foundry MI ({foundry.Data.Name})");
        }
        else
        {
            Console.WriteLine($"  WARNING: Foundry account '{foundry.Data.Name}' has no system-assigned identity; KB ingestion may fail.");
        }

        // 4b. The Search service MI needs Cognitive Services OpenAI User on the Foundry account
        //     so the KB can call chat.completions for query planning.
        if (searchService.Data.Identity?.PrincipalId is { } searchPrincipalId)
        {
            await EnsureRoleAssignmentAsync(arm, foundry.Id, searchPrincipalId.ToString(),
                roleDefinitionId: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd", // Cognitive Services OpenAI User
                roleName: "Cognitive Services OpenAI User",
                principalLabel: $"Search MI ({searchService.Data.Name})");
        }
        else
        {
            Console.WriteLine($"  WARNING: Search service '{searchService.Data.Name}' has no system-assigned identity; KB query planning may fail.");
        }

        // 4c. The calling user also needs OpenAI User so backend orchestration can chat-complete.
        await EnsureCurrentUserOpenAIRoleAsync(credential, arm, foundry.Id);

        // 5. Create / update a connection on the Foundry project pointing at this Search service.
        var connectionName = await EnsureProjectConnectionAsync(cfg, credential, arm, rg, searchService);
        state.SearchConnectionName = connectionName;

        state.Save(statePath);
        Console.WriteLine($"OK. SearchService={searchName}, Endpoint={searchEndpoint}, Connection={connectionName}");
        return 0;
    }

    private static (string PrincipalId, string Upn)? s_cachedUser;

    private static async Task<(string PrincipalId, string Upn)?> ResolveCurrentUserAsync(TokenCredential credential)
    {
        if (s_cachedUser.HasValue) return s_cachedUser;
        var token = await credential.GetTokenAsync(new TokenRequestContext(["https://graph.microsoft.com/.default"]), default);
        using var http = new HttpClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", token.Token);
        var resp = await http.GetAsync("https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName");
        var json = await resp.Content.ReadAsStringAsync();
        var doc = System.Text.Json.JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("id", out var idEl))
        {
            Console.WriteLine($"  WARNING: Could not resolve current user objectId from Graph (response: {json[..Math.Min(json.Length, 200)]})");
            return null;
        }
        var principalId = idEl.GetString()!;
        var upn = doc.RootElement.TryGetProperty("userPrincipalName", out var upnEl) ? upnEl.GetString() ?? "(unknown)" : "(unknown)";
        s_cachedUser = (principalId, upn);
        return s_cachedUser;
    }

    private static async Task EnsureCurrentUserOpenAIRoleAsync(TokenCredential credential, ArmClient arm, ResourceIdentifier foundryId)
    {
        var user = await ResolveCurrentUserAsync(credential);
        if (user is null) return;
        await EnsureRoleAssignmentAsync(arm, foundryId, user.Value.PrincipalId,
            roleDefinitionId: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd", // Cognitive Services OpenAI User
            roleName: "Cognitive Services OpenAI User",
            principalLabel: $"current user ({user.Value.Upn})");
        await EnsureRoleAssignmentAsync(arm, foundryId, user.Value.PrincipalId,
            roleDefinitionId: "a97b65f3-24c7-4388-baec-2e87135dc908", // Cognitive Services User
            roleName: "Cognitive Services User",
            principalLabel: $"current user ({user.Value.Upn})");
    }

    private static async Task EnsureRoleAssignmentsAsync(TokenCredential credential, ArmClient arm, SearchServiceResource searchService)
    {
        var user = await ResolveCurrentUserAsync(credential);
        if (user is null) return;

        await EnsureRoleAssignmentAsync(arm, searchService.Id, user.Value.PrincipalId,
            roleDefinitionId: "7ca78c08-252a-4471-8644-bb5ff32d4ba0", // Search Service Contributor
            roleName: "Search Service Contributor",
            principalLabel: $"current user ({user.Value.Upn})");

        await EnsureRoleAssignmentAsync(arm, searchService.Id, user.Value.PrincipalId,
            roleDefinitionId: "8ebe5a00-799e-43f5-93ac-243d3dce84a7", // Search Index Data Contributor
            roleName: "Search Index Data Contributor",
            principalLabel: $"current user ({user.Value.Upn})");
    }

    private static async Task EnsureRoleAssignmentAsync(ArmClient arm, ResourceIdentifier scope, string principalId, string roleDefinitionId, string roleName, string principalLabel)
    {
        var subId = scope.SubscriptionId!;
        var roleDefId = new ResourceIdentifier($"/subscriptions/{subId}/providers/Microsoft.Authorization/roleDefinitions/{roleDefinitionId}");
        var existing = arm.GetRoleAssignments(scope);
        await foreach (var ra in existing.GetAllAsync(filter: $"principalId eq '{principalId}'"))
        {
            if (ra.Data.RoleDefinitionId == roleDefId)
            {
                Console.WriteLine($"  Role '{roleName}' already assigned to {principalLabel}.");
                return;
            }
        }
        var name = Guid.NewGuid().ToString();
        var content = new RoleAssignmentCreateOrUpdateContent(roleDefId, Guid.Parse(principalId));
        try
        {
            await existing.CreateOrUpdateAsync(WaitUntil.Completed, name, content);
            Console.WriteLine($"  Assigned '{roleName}' to {principalLabel}.");
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            Console.WriteLine($"  Role '{roleName}' already assigned to {principalLabel} (409).");
        }
    }

    private static async Task<string> EnsureProjectConnectionAsync(InfraConfig cfg, TokenCredential credential, ArmClient arm, ResourceGroupResource rg, SearchServiceResource searchService)
    {
        // Use ARM control plane (Microsoft.CognitiveServices/accounts/projects/connections).
        var account = (await rg.GetCognitiveServicesAccountAsync(cfg.FoundryAccountName)).Value;
        var project = (await account.GetCognitiveServicesProjectAsync(cfg.ProjectName)).Value;
        var connections = project.GetCognitiveServicesProjectConnections();

        var searchResourceId = searchService.Id.ToString();
        await foreach (var existing in connections.GetAllAsync())
        {
            if (existing.Data.Properties is { } props
                && props.Category == Azure.ResourceManager.CognitiveServices.Models.CognitiveServicesConnectionCategory.CognitiveSearch
                && props.Metadata is { } md
                && md.TryGetValue("ResourceId", out var rid)
                && string.Equals(rid, searchResourceId, StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine($"  Foundry project connection '{existing.Data.Name}' already points to {searchService.Data.Name}.");
                return existing.Data.Name;
            }
        }

        var connName = $"srch-{searchService.Data.Name}";
        var connProps = new Azure.ResourceManager.CognitiveServices.Models.AadAuthTypeConnectionProperties
        {
            Category = Azure.ResourceManager.CognitiveServices.Models.CognitiveServicesConnectionCategory.CognitiveSearch,
            Target = $"https://{searchService.Data.Name}.search.windows.net",
            IsSharedToAll = true,
        };
        connProps.Metadata["ResourceId"] = searchResourceId;
        connProps.Metadata["ApiType"] = "Azure";
        connProps.Metadata["ApiVersion"] = "2024-07-01";
        connProps.Metadata["Location"] = searchService.Data.Location.ToString();

        var connData = new Azure.ResourceManager.CognitiveServices.CognitiveServicesConnectionData(connProps);
        await connections.CreateOrUpdateAsync(WaitUntil.Completed, connName, connData);
        Console.WriteLine($"  Created Foundry project connection '{connName}'.");
        return connName;
    }
}
