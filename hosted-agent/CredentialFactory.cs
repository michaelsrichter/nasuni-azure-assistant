using Azure.Core;
using Azure.Identity;

namespace Demo1.Agent;

/// <summary>
/// Builds the <see cref="TokenCredential"/> used to authenticate to Azure
/// services (the Knowledge Base / Foundry project).
///
/// In Azure we use <see cref="ManagedIdentityCredential"/> directly instead of
/// <see cref="DefaultAzureCredential"/>. DefaultAzureCredential walks a chain of
/// credential types (Environment → WorkloadIdentity → ManagedIdentity → Azure
/// CLI → …) until one succeeds, which can add cold-start latency and the
/// occasional IMDS probe delay. Selecting the managed identity directly is
/// deterministic and skips that probing.
///
/// Locally (when <c>AZURE_USE_MANAGED_IDENTITY</c> is not set) we fall back to
/// DefaultAzureCredential so <c>az login</c> continues to work for development.
/// </summary>
internal static class CredentialFactory
{
    public static TokenCredential Create()
    {
        var useManagedIdentity = Environment.GetEnvironmentVariable("AZURE_USE_MANAGED_IDENTITY");
        var enabled = string.Equals(useManagedIdentity, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(useManagedIdentity, "1", StringComparison.Ordinal);

        if (!enabled)
        {
            return new DefaultAzureCredential();
        }

        // A user-assigned identity is selected by its client id; an empty value
        // means use the system-assigned identity (the default for this demo).
        var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        return string.IsNullOrWhiteSpace(clientId)
            ? new ManagedIdentityCredential()
            : new ManagedIdentityCredential(ManagedIdentityId.FromUserAssignedClientId(clientId));
    }
}
