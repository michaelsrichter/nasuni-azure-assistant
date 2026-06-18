using Azure.Core;
using Azure.Search.Documents.KnowledgeBases;
using Azure.Search.Documents.KnowledgeBases.Models;

namespace Demo1.Agent.Tools;

/// <summary>
/// A single grounding passage returned from the knowledge base. Property names
/// are lower-case so the serialized JSON matches the contract the SPA and the
/// model already expect (<c>{ index, title, url, source, snippet }</c>).
/// </summary>
internal sealed record KbResult(int index, string title, string url, string source, string? snippet);

/// <summary>
/// Wraps the Azure AI Search KB into a single retrieval call. Returns structured
/// <see cref="KbResult"/> entries; the governed wrapper is responsible for
/// serializing the final tool payload (results + governance metadata).
/// The KB owns its own fan-out to MCP and any future knowledge sources, so this
/// tool stays a thin pass-through.
/// </summary>
internal sealed class KnowledgeBaseSearchTool
{
    private readonly KnowledgeBaseRetrievalClient _kb;

    public KnowledgeBaseSearchTool(Uri searchEndpoint, string knowledgeBaseName, TokenCredential credential)
    {
        _kb = new KnowledgeBaseRetrievalClient(searchEndpoint, knowledgeBaseName, credential);
    }

    public async Task<IReadOnlyList<KbResult>> SearchAsync(string query, CancellationToken ct = default)
    {
        var req = new KnowledgeBaseRetrievalRequest
        {
            Messages =
            {
                new KnowledgeBaseMessage(new KnowledgeBaseMessageContent[] { new KnowledgeBaseMessageTextContent(query) }) { Role = "user" }
            }
        };

        var resp = await _kb.RetrieveAsync(req, cancellationToken: ct);
        var citations = KbCitationParser.Extract(resp.Value);

        return citations.Select((c, i) => new KbResult(
            index: i + 1,
            title: c.Title,
            url: c.Url,
            source: c.Source,
            snippet: string.IsNullOrEmpty(c.Snippet)
                ? null
                : (c.Snippet!.Length > 1500 ? c.Snippet[..1500] + "…" : c.Snippet))).ToList();
    }
}
