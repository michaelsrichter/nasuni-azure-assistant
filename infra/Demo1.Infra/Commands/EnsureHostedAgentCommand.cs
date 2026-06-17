using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Identity;

namespace Demo1.Infra.Commands;

/// <summary>
/// Creates (or updates) a Foundry Hosted Agent that grounds answers via the
/// MS Learn MCP server. The agent appears in the Foundry portal under the
/// project's Agents tab and can be invoked through the Persistent Agents API
/// (the classic Foundry Agents / Assistants surface).
///
/// The KB (<c>kb-mslearn</c>) ultimately wraps the same MCP endpoint, so an
/// MCP-tool hosted agent gives the same grounding without the extra KB hop
/// (and avoids the sticky-cache 401 we sometimes see on freshly-granted
/// Search managed identities).
/// </summary>
public static class EnsureHostedAgentCommand
{
    public static async Task<int> RunAsync(InfraConfig cfg, InfraState state, string statePath)
    {
        Console.WriteLine("=== ensure-hosted-agent ===");

        var credential = new DefaultAzureCredential();
        var client = new PersistentAgentsClient(cfg.ProjectEndpoint, credential);

        string? existingId = null;
        await foreach (var existing in client.Administration.GetAgentsAsync())
        {
            if (string.Equals(existing.Name, cfg.HostedAgentName, StringComparison.Ordinal))
            {
                existingId = existing.Id;
                break;
            }
        }

        var instructions = """
            You are an expert assistant for Microsoft Azure, .NET, and the broader Microsoft developer platform.
            Answer the user's question using ONLY information returned by the mslearn MCP server.
            Call the microsoft_docs_search tool with a focused query derived from the user's question.
            Cite every factual claim with a numbered reference like [1] that maps to the source URLs.
            If the MCP server returns nothing relevant, say so plainly rather than guessing.
            Keep answers concise and developer-focused, with code samples when they help.
            """;

        var tools = new List<ToolDefinition>
        {
            new MCPToolDefinition("mslearn", cfg.McpServerUrl),
        };

        Response<PersistentAgent> response;
        if (existingId is not null)
        {
            Console.WriteLine($"  Found existing hosted agent '{cfg.HostedAgentName}' (id={existingId}); updating.");
            response = await client.Administration.UpdateAgentAsync(
                assistantId: existingId,
                model: cfg.ModelDeploymentName,
                name: cfg.HostedAgentName,
                description: "Grounds answers via the MS Learn MCP server.",
                instructions: instructions,
                tools: tools);
        }
        else
        {
            Console.WriteLine($"  Creating hosted agent '{cfg.HostedAgentName}'.");
            response = await client.Administration.CreateAgentAsync(
                model: cfg.ModelDeploymentName,
                name: cfg.HostedAgentName,
                description: "Grounds answers via the MS Learn MCP server.",
                instructions: instructions,
                tools: tools);
        }

        var agent = response.Value;
        state.HostedAgentId = agent.Id;
        state.Save(statePath);

        Console.WriteLine($"  OK: agent id={agent.Id}");
        Console.WriteLine($"  Visit https://ai.azure.com → project '{cfg.ProjectName}' → Agents to see '{agent.Name}'.");
        return 0;
    }
}
