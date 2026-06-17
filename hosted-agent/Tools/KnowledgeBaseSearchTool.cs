using System.ComponentModel;
using System.Text.Json;
using Azure.Core;
using Azure.Search.Documents.KnowledgeBases;
using Azure.Search.Documents.KnowledgeBases.Models;

namespace Demo1.Agent.Tools;

/// <summary>
/// Wraps the Azure AI Search KB into a single function the LLM can call. Returns
/// a JSON string the model can read directly to cite <c>[n]</c> references.
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

    [Description("Retrieve grounding passages from the knowledge base, which spans the Nasuni-on-Azure documentation PDFs and Microsoft Learn. Returns a JSON array of { index, title, url, source, snippet } entries, where source is either \"Nasuni documentation\" or \"Microsoft Learn\".")]
    public async Task<string> SearchAsync(
        [Description("A focused search query derived from the user's question. Prefer specific API or product names.")]
        string query,
        CancellationToken ct = default)
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

        var payload = citations.Select((c, i) => new
        {
            index = i + 1,
            title = c.Title,
            url = c.Url,
            source = c.Source,
            snippet = string.IsNullOrEmpty(c.Snippet)
                ? null
                : (c.Snippet!.Length > 1500 ? c.Snippet[..1500] + "…" : c.Snippet),
        });

        return JsonSerializer.Serialize(payload);
    }
}
