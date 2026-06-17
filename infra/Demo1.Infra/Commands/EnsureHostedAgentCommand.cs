using Azure;
using Azure.AI.Agents.Persistent;
using Azure.Identity;

namespace Demo1.Infra.Commands;

/// <summary>
/// Creates (or updates) a Foundry Hosted Agent that grounds answers via the
/// MS Learn KB (kb-mslearn → ks-mslearn-mcp → MS Learn MCP server). The agent
/// is portal-visible (project → Agents) and is invoked by the backend through
/// the standard threads + runs flow.
///
/// Tool design: the agent exposes a single function tool `knowledge_base_search`.
/// When the agent invokes it, the backend (acting as the tool executor) calls
/// the KB's <c>RetrieveAsync</c> and returns the references as the tool output.
/// This keeps the KB as the authoritative grounding surface (so additional
/// knowledge sources added to the KB later are picked up automatically) while
/// the agent owns the orchestration / answer synthesis.
/// </summary>
public static class EnsureHostedAgentCommand
{
    public const string KnowledgeBaseToolName = "knowledge_base_search";

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

            For every user question:
              1. Call the `knowledge_base_search` function with a focused query derived from the question.
              2. Read the returned references and write an answer using ONLY information from those references.
              3. Cite every factual claim with a bracketed number like [1] that maps to the references the tool returned, in order.
              4. If the references do not contain the answer, say so plainly rather than guessing.

            Keep answers concise and developer-focused, with code samples when they help.
            """;

        var parametersJson = """
            {
              "type": "object",
              "properties": {
                "query": {
                  "type": "string",
                  "description": "A focused search query derived from the user's question. Prefer specific API or product names."
                }
              },
              "required": ["query"]
            }
            """;

        var tools = new List<ToolDefinition>
        {
            new FunctionToolDefinition(
                name: KnowledgeBaseToolName,
                description: $"Retrieve grounding passages from the Microsoft Learn knowledge base ({cfg.KnowledgeBaseName}). Returns a JSON array of {{ index, title, url, snippet }} entries.",
                parameters: BinaryData.FromString(parametersJson)),
        };

        Response<PersistentAgent> response;
        if (existingId is not null)
        {
            Console.WriteLine($"  Found existing hosted agent '{cfg.HostedAgentName}' (id={existingId}); updating.");
            response = await client.Administration.UpdateAgentAsync(
                assistantId: existingId,
                model: cfg.ModelDeploymentName,
                name: cfg.HostedAgentName,
                description: $"Grounds answers via the '{cfg.KnowledgeBaseName}' knowledge base (backend-executed function tool).",
                instructions: instructions,
                tools: tools);
        }
        else
        {
            Console.WriteLine($"  Creating hosted agent '{cfg.HostedAgentName}'.");
            response = await client.Administration.CreateAgentAsync(
                model: cfg.ModelDeploymentName,
                name: cfg.HostedAgentName,
                description: $"Grounds answers via the '{cfg.KnowledgeBaseName}' knowledge base (backend-executed function tool).",
                instructions: instructions,
                tools: tools);
        }

        var agent = response.Value;
        state.HostedAgentId = agent.Id;
        state.Save(statePath);

        Console.WriteLine($"  OK: agent id={agent.Id}, tool='{KnowledgeBaseToolName}'");
        Console.WriteLine($"  Visit https://ai.azure.com → project '{cfg.ProjectName}' → Agents to see '{agent.Name}'.");
        return 0;
    }
}
