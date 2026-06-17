using System.Text.Json;
using Azure.Search.Documents.KnowledgeBases.Models;

namespace Demo1.Agent.Tools;

/// <summary>
/// KB retrieve responses put the real data in <c>Response[0].Content[0].Text</c>
/// as a JSON array whose entries' <c>content</c> field is itself a JSON string
/// containing <c>{ title, content, contentUrl }</c>. <c>References[].SourceData</c>
/// is empty for the MCP knowledge source, so don't bother reading it.
/// </summary>
internal static class KbCitationParser
{
    public static List<KbCitation> Extract(KnowledgeBaseRetrievalResponse resp)
    {
        var citations = new List<KbCitation>();
        foreach (var msg in resp.Response ?? [])
        {
            foreach (var content in msg.Content ?? [])
            {
                if (content is not KnowledgeBaseMessageTextContent text || string.IsNullOrWhiteSpace(text.Text))
                    continue;
                ParseTextPayload(text.Text, citations);
            }
        }
        return citations;
    }

    private static void ParseTextPayload(string json, List<KbCitation> citations)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(json); }
        catch (JsonException) { return; }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return;
            foreach (var entry in doc.RootElement.EnumerateArray())
            {
                string? title = null, url = null, snippet = null;

                // The outer entry carries the knowledge-source hints (MCP chunks
                // have a toolName and a "ks-mslearn-..." title); file chunks don't.
                string? toolName = null, outerTitle = null;
                if (entry.TryGetProperty("toolName", out var tn) && tn.ValueKind == JsonValueKind.String)
                    toolName = tn.GetString();
                if (entry.TryGetProperty("title", out var ot) && ot.ValueKind == JsonValueKind.String)
                    outerTitle = ot.GetString();

                if (entry.TryGetProperty("content", out var innerProp))
                {
                    if (innerProp.ValueKind == JsonValueKind.String)
                        TryParseInner(innerProp.GetString(), out title, out url, out snippet);
                    else if (innerProp.ValueKind == JsonValueKind.Object)
                        ReadInnerObject(innerProp, out title, out url, out snippet);
                }

                if (string.IsNullOrEmpty(title) && !string.IsNullOrEmpty(outerTitle))
                    title = outerTitle;

                var source = DetermineSource(toolName, outerTitle, url);
                citations.Add(new KbCitation(title ?? "", url ?? "", snippet, source));
            }
        }
    }

    // Label each retrieved chunk with the knowledge source it came from so the UI
    // can show whether a fact is grounded in the Nasuni PDFs or Microsoft Learn.
    // MS Learn (MCP) chunks carry toolName "microsoft_docs_search", an outer title
    // prefixed "ks-mslearn-", and/or a learn.microsoft.com URL. Nasuni file chunks
    // have none of those.
    private static string DetermineSource(string? toolName, string? outerTitle, string? url)
    {
        if (!string.IsNullOrEmpty(toolName) && toolName.Contains("microsoft_docs", StringComparison.OrdinalIgnoreCase))
            return "Microsoft Learn";
        if (!string.IsNullOrEmpty(outerTitle) && outerTitle.StartsWith("ks-mslearn", StringComparison.OrdinalIgnoreCase))
            return "Microsoft Learn";
        if (!string.IsNullOrEmpty(url) && url.Contains("learn.microsoft.com", StringComparison.OrdinalIgnoreCase))
            return "Microsoft Learn";
        return "Nasuni documentation";
    }

    private static void TryParseInner(string? raw, out string? title, out string? url, out string? snippet)
    {
        title = url = snippet = null;
        if (string.IsNullOrWhiteSpace(raw)) return;
        try
        {
            using var d = JsonDocument.Parse(raw);
            if (d.RootElement.ValueKind == JsonValueKind.Object)
                ReadInnerObject(d.RootElement, out title, out url, out snippet);
        }
        catch (JsonException)
        {
            snippet = raw;
        }
    }

    private static void ReadInnerObject(JsonElement obj, out string? title, out string? url, out string? snippet)
    {
        title = url = snippet = null;
        if (obj.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String) title = t.GetString();
        if (obj.TryGetProperty("contentUrl", out var u) && u.ValueKind == JsonValueKind.String) url = u.GetString();
        else if (obj.TryGetProperty("url", out var u2) && u2.ValueKind == JsonValueKind.String) url = u2.GetString();
        if (obj.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String) snippet = c.GetString();
        else if (obj.TryGetProperty("snippet", out var s) && s.ValueKind == JsonValueKind.String) snippet = s.GetString();
    }
}

internal sealed record KbCitation(string Title, string Url, string? Snippet, string Source);
