using System.Net.Http.Json;
using System.Text.Json;

namespace ChatbotApi;

/// <summary>
/// Minimal MCP client that calls a remote streaming-HTTP MCP server (Microsoft Learn).
/// Used as a fallback retrieval path when the AI Search KB is unavailable, and for E2E
/// verification that the orchestration calls the MCP server end-to-end.
/// </summary>
public sealed class McpDocsClient
{
    private readonly HttpClient _http;
    private readonly string _serverUrl;
    private readonly ILogger<McpDocsClient> _log;
    private int _id;

    public McpDocsClient(HttpClient http, IConfiguration cfg, ILogger<McpDocsClient> log)
    {
        _http = http;
        _serverUrl = cfg["Demo1:McpServerUrl"] ?? "https://learn.microsoft.com/api/mcp";
        _log = log;
    }

    public async Task<IReadOnlyList<Citation>> SearchDocsAsync(string query, CancellationToken ct)
    {
        var payload = new
        {
            jsonrpc = "2.0",
            id = Interlocked.Increment(ref _id),
            method = "tools/call",
            @params = new { name = "microsoft_docs_search", arguments = new { query } }
        };
        using var req = new HttpRequestMessage(HttpMethod.Post, _serverUrl)
        {
            Content = JsonContent.Create(payload),
        };
        req.Headers.Accept.ParseAdd("application/json, text/event-stream");
        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct);
        return ParseSearchResults(body);
    }

    private static List<Citation> ParseSearchResults(string body)
    {
        // body is text/event-stream: "event: message\ndata: {json}\n\n"
        var line = body
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault(l => l.StartsWith("data:", StringComparison.Ordinal));
        var json = line is null ? body : line[5..].Trim();
        using var doc = JsonDocument.Parse(json);
        var citations = new List<Citation>();
        if (!doc.RootElement.TryGetProperty("result", out var result)) return citations;
        // The tool can return either { content: [{ text: "..." }] } or { structuredContent: { results: [...] } }
        if (result.TryGetProperty("structuredContent", out var sc) &&
            sc.TryGetProperty("results", out var results) &&
            results.ValueKind == JsonValueKind.Array)
        {
            foreach (var r in results.EnumerateArray())
            {
                citations.Add(new Citation(
                    r.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "",
                    r.TryGetProperty("contentUrl", out var u) ? u.GetString() ?? "" : "",
                    r.TryGetProperty("content", out var c) ? c.GetString() : null));
            }
            return citations;
        }
        if (result.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in content.EnumerateArray())
            {
                if (c.TryGetProperty("text", out var text))
                {
                    var inner = text.GetString() ?? "";
                    try
                    {
                        using var idoc = JsonDocument.Parse(inner);
                        if (idoc.RootElement.TryGetProperty("results", out var ir) &&
                            ir.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var r in ir.EnumerateArray())
                            {
                                citations.Add(new Citation(
                                    r.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "",
                                    r.TryGetProperty("contentUrl", out var u) ? u.GetString() ?? "" : "",
                                    r.TryGetProperty("content", out var cc) ? cc.GetString() : null));
                            }
                        }
                    }
                    catch (JsonException)
                    {
                        citations.Add(new Citation("MS Learn", "", inner));
                    }
                }
            }
        }
        return citations;
    }
}
