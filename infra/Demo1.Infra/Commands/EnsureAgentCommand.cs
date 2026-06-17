using System.Net.Http.Json;
using System.Text.Json;
using Azure.Identity;
using Azure.Search.Documents.KnowledgeBases;
using Azure.Search.Documents.KnowledgeBases.Models;

namespace Demo1.Infra.Commands;

/// <summary>
/// Verifies the end-to-end retrieval chain. The KB is the primary path; if the KB's
/// internal model call returns 401 (a known sticky cache issue on newly-granted Search
/// MIs), we still verify the underlying MCP server returns content — the backend's
/// orchestrator falls back to direct MCP retrieval in that case.
/// </summary>
public static class EnsureAgentCommand
{
    public static async Task<int> RunAsync(InfraConfig cfg, InfraState state, string statePath)
    {
        Console.WriteLine("=== ensure-agent ===");
        if (string.IsNullOrEmpty(state.SearchEndpoint))
        {
            Console.Error.WriteLine("  SearchEndpoint not set. Run 'ensure-search' first.");
            return 1;
        }
        if (string.IsNullOrEmpty(state.KnowledgeBaseId))
        {
            Console.Error.WriteLine("  KnowledgeBaseId not set. Run 'ensure-kb' first.");
            return 1;
        }

        Console.WriteLine("  This demo uses backend-side orchestration (no Foundry agent resource needed).");

        var credential = new DefaultAzureCredential();
        var question = "How do I list blobs with Azure.Storage.Blobs in C#?";
        var kbOk = false;
        var mcpOk = false;

        Console.WriteLine("  [1/2] Testing KB retrieval...");
        try
        {
            var retrieval = new KnowledgeBaseRetrievalClient(new Uri(state.SearchEndpoint), cfg.KnowledgeBaseName, credential);
            var request = new KnowledgeBaseRetrievalRequest
            {
                Messages =
                {
                    new KnowledgeBaseMessage(new KnowledgeBaseMessageContent[]
                    {
                        new KnowledgeBaseMessageTextContent(question)
                    })
                    { Role = "user" }
                }
            };
            var resp = await retrieval.RetrieveAsync(request);
            Console.WriteLine($"    KB returned {resp.Value.Response.Count} response item(s), {resp.Value.References.Count} references.");
            kbOk = true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"    KB retrieval failed (will exercise MCP fallback path): {ex.GetType().Name}: {ex.Message.Split('\n')[0]}");
        }

        Console.WriteLine("  [2/2] Testing direct MCP (the KB's underlying source)...");
        try
        {
            using var http = new HttpClient();
            var payload = new
            {
                jsonrpc = "2.0",
                id = 1,
                method = "tools/call",
                @params = new { name = "microsoft_docs_search", arguments = new { query = question } }
            };
            using var req = new HttpRequestMessage(HttpMethod.Post, cfg.McpServerUrl)
            {
                Content = JsonContent.Create(payload)
            };
            req.Headers.Accept.ParseAdd("application/json, text/event-stream");
            using var resp = await http.SendAsync(req);
            resp.EnsureSuccessStatusCode();
            var body = await resp.Content.ReadAsStringAsync();
            var json = body.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault(l => l.StartsWith("data:", StringComparison.Ordinal))?[5..].Trim() ?? body;
            using var doc = JsonDocument.Parse(json);
            var n = doc.RootElement.GetProperty("result").GetProperty("structuredContent").GetProperty("results").GetArrayLength();
            Console.WriteLine($"    MCP returned {n} result(s).");
            mcpOk = n > 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"    MCP smoke test failed: {ex.GetType().Name}: {ex.Message}");
        }

        state.Save(statePath);

        if (!mcpOk)
        {
            Console.Error.WriteLine("  FAIL: MCP is the minimum requirement for the chat backend.");
            return 1;
        }
        if (!kbOk)
        {
            Console.WriteLine("  OK (degraded): KB is provisioned but its model call is unreachable;");
            Console.WriteLine("  backend will use the direct-MCP fallback path.");
            return 0;
        }
        Console.WriteLine("  OK: KB retrieval and MCP both healthy.");
        return 0;
    }
}
