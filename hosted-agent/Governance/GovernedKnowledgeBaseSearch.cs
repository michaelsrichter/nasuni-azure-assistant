using System.ComponentModel;
using System.Text.Json;
using Demo1.Agent.Tools;
using Microsoft.AspNetCore.Http;

namespace Demo1.Agent.Governance;

/// <summary>
/// The function actually registered with the agent. It applies the AGT
/// <see cref="GovernanceGate"/> to every knowledge-base search, then either
/// blocks the call or runs the underlying retrieval, returning a single JSON
/// payload of <c>{ results, governance }</c>. The governance toggle is read
/// per-request from the <c>x-agt-governance</c> header so the SPA can compare
/// the governed and ungoverned behaviour live.
/// </summary>
internal sealed class GovernedKnowledgeBaseSearch
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly KnowledgeBaseSearchTool _inner;
    private readonly GovernanceGate _gate;
    private readonly IHttpContextAccessor _http;

    public GovernedKnowledgeBaseSearch(KnowledgeBaseSearchTool inner, GovernanceGate gate, IHttpContextAccessor http)
    {
        _inner = inner;
        _gate = gate;
        _http = http;
    }

    [Description("Retrieve grounding passages from the knowledge base, which spans the Nasuni-on-Azure documentation PDFs and Microsoft Learn. Returns a JSON object { results: [ { index, title, url, source, snippet } ], governance: { ... } }. Use ONLY the `results` array for facts and citations.")]
    public async Task<string> SearchAsync(
        [Description("A focused search query derived from the user's question. Prefer specific API or product names.")]
        string query,
        CancellationToken ct = default)
    {
        var http = _http.HttpContext;
        var enforce = ReadEnforce(http);
        var sessionId = http?.TraceIdentifier ?? "demo1-session";

        var verdict = _gate.Evaluate(query, enforce, sessionId);

        if (!verdict.Allowed)
        {
            // Blocked: hand the model an empty result set plus the governance
            // metadata so it tells the user it could not retrieve grounding.
            return JsonSerializer.Serialize(new { results = Array.Empty<KbResult>(), governance = verdict }, JsonOptions);
        }

        var results = await _inner.SearchAsync(query, ct);
        return JsonSerializer.Serialize(new { results, governance = verdict }, JsonOptions);
    }

    private static bool ReadEnforce(HttpContext? http)
    {
        // Governance is ON by default; the SPA opts out by sending
        // `x-agt-governance: off`.
        var header = http?.Request.Headers["x-agt-governance"].ToString();
        return !string.Equals(header, "off", StringComparison.OrdinalIgnoreCase);
    }
}
