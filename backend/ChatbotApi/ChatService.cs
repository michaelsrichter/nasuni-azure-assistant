using System.ClientModel;
using System.Diagnostics;
using System.Text;
using Azure.AI.OpenAI;
using Azure.Core;
using Azure.Identity;
using Azure.Search.Documents.KnowledgeBases;
using Azure.Search.Documents.KnowledgeBases.Models;
using OpenAI.Chat;

namespace ChatbotApi;

public interface IChatService
{
    Task<ChatResponse> AnswerAsync(ChatRequest request, CancellationToken ct);
}

public sealed class ChatService : IChatService
{
    private static readonly ActivitySource s_activity = new("ChatbotApi");

    private readonly Demo1Options _opts;
    private readonly TokenCredential _credential;
    private readonly McpDocsClient _mcp;
    private readonly ILogger<ChatService> _log;
    private readonly ChatClient _chat;
    private readonly KnowledgeBaseRetrievalClient? _kb;

    public ChatService(
        Demo1Options opts,
        TokenCredential credential,
        McpDocsClient mcp,
        ILogger<ChatService> log)
    {
        _opts = opts;
        _credential = credential;
        _mcp = mcp;
        _log = log;

        var azureClient = new AzureOpenAIClient(new Uri(opts.FoundryOpenAIEndpoint), credential);
        _chat = azureClient.GetChatClient(opts.ChatDeployment);

        if (!string.IsNullOrWhiteSpace(opts.SearchEndpoint) &&
            !string.IsNullOrWhiteSpace(opts.KnowledgeBaseName))
        {
            _kb = new KnowledgeBaseRetrievalClient(
                new Uri(opts.SearchEndpoint),
                opts.KnowledgeBaseName,
                credential);
        }
    }

    public async Task<ChatResponse> AnswerAsync(ChatRequest request, CancellationToken ct)
    {
        using var activity = s_activity.StartActivity("chat.answer");
        activity?.SetTag("chat.question.length", request.Question.Length);
        var sw = Stopwatch.StartNew();

        var (citations, source) = await RetrieveGroundingAsync(request.Question, ct);
        activity?.SetTag("chat.citations.count", citations.Count);
        activity?.SetTag("chat.retrieval.source", source);

        var messages = BuildMessages(request, citations);
        var completion = await _chat.CompleteChatAsync(messages, cancellationToken: ct);
        var answer = completion.Value.Content.Count > 0
            ? completion.Value.Content[0].Text
            : "(no answer)";

        sw.Stop();
        var traceId = activity?.TraceId.ToString();
        _log.LogInformation("chat.answer ok source={Source} citations={Count} ms={Ms}",
            source, citations.Count, sw.ElapsedMilliseconds);
        return new ChatResponse(answer, citations, source, sw.ElapsedMilliseconds, traceId);
    }

    private async Task<(IReadOnlyList<Citation> Citations, string Source)> RetrieveGroundingAsync(
        string question, CancellationToken ct)
    {
        if (_kb is not null)
        {
            try
            {
                using var act = s_activity.StartActivity("kb.retrieve");
                var req = new KnowledgeBaseRetrievalRequest
                {
                    Messages =
                    {
                        new KnowledgeBaseMessage(new KnowledgeBaseMessageContent[] { new KnowledgeBaseMessageTextContent(question) }) { Role = "user" }
                    }
                };
                var resp = await _kb.RetrieveAsync(req, cancellationToken: ct);
                var citations = KbCitationParser.Extract(resp.Value);
                if (citations.Count > 0)
                {
                    act?.SetTag("kb.citations.count", citations.Count);
                    return (citations, "knowledgeBase");
                }
                _log.LogWarning("KB returned no citations; falling back to direct MCP.");
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "KB retrieval failed; falling back to direct MCP.");
            }
        }
        var mcp = await _mcp.SearchDocsAsync(question, ct);
        return (mcp, "mcp");
    }

    private static List<Citation> ExtractCitations(KnowledgeBaseRetrievalResponse resp)
        => KbCitationParser.Extract(resp).ToList();

    private List<OpenAI.Chat.ChatMessage> BuildMessages(ChatRequest req, IReadOnlyList<Citation> citations)
    {
        var sb = new StringBuilder();
        sb.AppendLine("You are a helpful assistant that answers questions about Microsoft developer APIs.");
        sb.AppendLine("Use ONLY the grounding context below. Cite source titles when relevant.");
        sb.AppendLine("If the context is insufficient, say so plainly.");
        if (citations.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("Grounding context:");
            foreach (var (c, i) in citations.Select((c, i) => (c, i + 1)))
            {
                sb.AppendLine($"[{i}] {c.Title} ({c.Url})");
                if (!string.IsNullOrEmpty(c.Snippet))
                {
                    var snip = c.Snippet.Length > 1200 ? c.Snippet[..1200] + "…" : c.Snippet;
                    sb.AppendLine(snip);
                }
                sb.AppendLine();
            }
        }

        var messages = new List<OpenAI.Chat.ChatMessage>
        {
            new SystemChatMessage(sb.ToString())
        };
        if (req.History is { Count: > 0 })
        {
            foreach (var h in req.History)
            {
                messages.Add(h.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase)
                    ? new AssistantChatMessage(h.Content)
                    : new UserChatMessage(h.Content));
            }
        }
        messages.Add(new UserChatMessage(req.Question));
        return messages;
    }
}
