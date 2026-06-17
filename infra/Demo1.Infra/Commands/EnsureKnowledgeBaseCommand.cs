using Azure;
using Azure.Identity;
using Azure.Search.Documents.Indexes;
using Azure.Search.Documents.Indexes.Models;
using Azure.Search.Documents.KnowledgeBases;
using Azure.Search.Documents.KnowledgeBases.Models;

namespace Demo1.Infra.Commands;

public static class EnsureKnowledgeBaseCommand
{
    public static async Task<int> RunAsync(InfraConfig cfg, InfraState state, string statePath)
    {
        Console.WriteLine("=== ensure-kb ===");
        if (string.IsNullOrEmpty(state.SearchEndpoint))
        {
            Console.Error.WriteLine("  SearchEndpoint not set in state.json. Run 'ensure-search' first.");
            return 1;
        }

        var credential = new DefaultAzureCredential();
        var indexClient = new SearchIndexClient(new Uri(state.SearchEndpoint), credential);

        // 1. Create / update the MCP knowledge source for MS Learn.
        var ks = new McpServerKnowledgeSource(
            name: cfg.KnowledgeSourceName,
            mcpServerParameters: new McpServerKnowledgeSourceParameters(
                serverURL: cfg.McpServerUrl,
                tools: new[]
                {
                    new McpServerTool { Name = "microsoft_docs_search" },
                    new McpServerTool { Name = "microsoft_code_sample_search" },
                    new McpServerTool { Name = "microsoft_docs_fetch" },
                }))
        {
            Description = "MS Learn MCP server (public).",
        };

        try
        {
            var ksResp = await indexClient.CreateOrUpdateKnowledgeSourceAsync(ks, onlyIfUnchanged: false);
            Console.WriteLine($"  Knowledge source upserted: {ksResp.Value.Name}");
            state.KnowledgeSourceId = ksResp.Value.Name;
        }
        catch (RequestFailedException ex)
        {
            Console.Error.WriteLine($"  Failed to upsert knowledge source: HTTP {ex.Status} {ex.ErrorCode}: {ex.Message}");
            throw;
        }

        // 2. Create / update the knowledge base referencing the MCP knowledge source.
        var kb = new KnowledgeBase(
            name: cfg.KnowledgeBaseName,
            knowledgeSources: new[] { new KnowledgeSourceReference(cfg.KnowledgeSourceName) })
        {
            Description = "Microsoft Learn KB grounded via MCP.",
        };

        // Add an Azure OpenAI model so the KB can call the LLM for query planning / answer synthesis.
        kb.Models.Add(new KnowledgeBaseAzureOpenAIModel(new AzureOpenAIVectorizerParameters
        {
            ResourceUri = new Uri($"https://{cfg.FoundryAccountName}.cognitiveservices.azure.com/"),
            DeploymentName = cfg.ModelDeploymentName,
            ModelName = AzureOpenAIModelName.Gpt41Mini,
        }));

        try
        {
            var kbResp = await indexClient.CreateOrUpdateKnowledgeBaseAsync(kb, onlyIfUnchanged: false);
            Console.WriteLine($"  Knowledge base upserted: {kbResp.Value.Name}");
            state.KnowledgeBaseId = kbResp.Value.Name;
        }
        catch (RequestFailedException ex)
        {
            Console.Error.WriteLine($"  Failed to upsert knowledge base: HTTP {ex.Status} {ex.ErrorCode}: {ex.Message}");
            throw;
        }

        state.Save(statePath);
        Console.WriteLine($"OK. KnowledgeSource={state.KnowledgeSourceId}, KnowledgeBase={state.KnowledgeBaseId}");
        return 0;
    }
}
