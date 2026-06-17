using System.Diagnostics;
using System.Text.Json;
using Azure.AI.Agents.Persistent;
using Azure.Core;
using Azure.Search.Documents.KnowledgeBases;
using Azure.Search.Documents.KnowledgeBases.Models;

namespace ChatbotApi;

/// <summary>
/// Chat service that delegates orchestration to a portal-visible Foundry hosted
/// agent. The agent's only tool is a function named
/// <see cref="EnsureHostedAgentToolName"/>; when the run reaches
/// <c>RequiresAction</c>, this service calls the KB's <c>RetrieveAsync</c> and
/// submits the references as the function's output. The agent then writes the
/// final answer, which we return to the UI.
///
/// The KB orchestrates its own grounding internally (KB → MCP, and any other
/// knowledge sources added to it later), so this service contains zero
/// MCP-specific or per-source logic.
/// </summary>
public sealed class AgentChatService : IChatService
{
    public const string EnsureHostedAgentToolName = "knowledge_base_search";

    private static readonly ActivitySource s_activity = new("ChatbotApi");

    private readonly Demo1Options _opts;
    private readonly PersistentAgentsClient _agents;
    private readonly KnowledgeBaseRetrievalClient _kb;
    private readonly ILogger<AgentChatService> _log;

    public AgentChatService(
        Demo1Options opts,
        TokenCredential credential,
        ILogger<AgentChatService> log)
    {
        if (string.IsNullOrWhiteSpace(opts.ProjectEndpoint))
            throw new InvalidOperationException("Demo1:ProjectEndpoint is required when UseHostedAgent=true.");
        if (string.IsNullOrWhiteSpace(opts.HostedAgentId))
            throw new InvalidOperationException("Demo1:HostedAgentId is required when UseHostedAgent=true.");
        if (string.IsNullOrWhiteSpace(opts.SearchEndpoint) || string.IsNullOrWhiteSpace(opts.KnowledgeBaseName))
            throw new InvalidOperationException("Demo1:SearchEndpoint and Demo1:KnowledgeBaseName are required to execute the agent's KB tool.");

        _opts = opts;
        _log = log;
        _agents = new PersistentAgentsClient(opts.ProjectEndpoint, credential);
        _kb = new KnowledgeBaseRetrievalClient(new Uri(opts.SearchEndpoint), opts.KnowledgeBaseName, credential);
    }

    public async Task<ChatResponse> AnswerAsync(ChatRequest request, CancellationToken ct)
    {
        using var activity = s_activity.StartActivity("agent.answer");
        activity?.SetTag("agent.id", _opts.HostedAgentId);
        var sw = Stopwatch.StartNew();

        var threadResp = await _agents.Threads.CreateThreadAsync(messages: null, toolResources: null, metadata: null, ct);
        var threadId = threadResp.Value.Id;
        activity?.SetTag("agent.thread.id", threadId);

        if (request.History is { Count: > 0 })
        {
            foreach (var h in request.History)
            {
                var role = h.Role.Equals("assistant", StringComparison.OrdinalIgnoreCase) ? MessageRole.Agent : MessageRole.User;
                await _agents.Messages.CreateMessageAsync(threadId, role, h.Content, attachments: null, metadata: null, ct);
            }
        }
        await _agents.Messages.CreateMessageAsync(threadId, MessageRole.User, request.Question, attachments: null, metadata: null, ct);

        var runResp = await _agents.Runs.CreateRunAsync(
            threadId: threadId,
            assistantId: _opts.HostedAgentId,
            overrideModelName: null,
            overrideInstructions: null,
            additionalInstructions: null,
            additionalMessages: null,
            overrideTools: null,
            stream: null,
            temperature: null,
            topP: null,
            maxPromptTokens: null,
            maxCompletionTokens: null,
            truncationStrategy: null,
            toolChoice: null,
            responseFormat: null,
            parallelToolCalls: null,
            metadata: null,
            include: null,
            cancellationToken: ct);
        var run = runResp.Value;

        var allCitations = new List<Citation>();

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (run.Status == RunStatus.Queued || run.Status == RunStatus.InProgress)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(400), ct);
                run = (await _agents.Runs.GetRunAsync(threadId, run.Id, ct)).Value;
                continue;
            }

            if (run.Status == RunStatus.RequiresAction
                && run.RequiredAction is SubmitToolOutputsAction submit)
            {
                var outputs = new List<ToolOutput>(submit.ToolCalls.Count);
                foreach (var call in submit.ToolCalls)
                {
                    if (call is RequiredFunctionToolCall fn && fn.Name == EnsureHostedAgentToolName)
                    {
                        var (json, citations) = await CallKnowledgeBaseAsync(fn.Arguments, ct);
                        allCitations.AddRange(citations);
                        outputs.Add(new ToolOutput(fn.Id, json));
                    }
                    else
                    {
                        outputs.Add(new ToolOutput(call.Id, "{\"error\":\"unsupported tool call\"}"));
                    }
                }
                run = (await _agents.Runs.SubmitToolOutputsToRunAsync(run, outputs, ct)).Value;
                continue;
            }

            if (run.Status == RunStatus.Completed) break;

            var detail = run.LastError is not null
                ? $"{run.LastError.Code}: {run.LastError.Message}"
                : run.Status.ToString();
            throw new InvalidOperationException($"Agent run ended with status {run.Status}. {detail}");
        }

        var answer = await GetLatestAssistantTextAsync(threadId, run.Id, ct);

        sw.Stop();
        var traceId = activity?.TraceId.ToString();
        _log.LogInformation("agent.answer ok thread={Thread} run={Run} citations={Count} ms={Ms}",
            threadId, run.Id, allCitations.Count, sw.ElapsedMilliseconds);

        return new ChatResponse(answer, DedupeCitations(allCitations), "agent", sw.ElapsedMilliseconds, traceId);
    }

    private async Task<(string Json, IReadOnlyList<Citation> Citations)> CallKnowledgeBaseAsync(string argumentsJson, CancellationToken ct)
    {
        using var act = s_activity.StartActivity("agent.tool.kb_retrieve");
        var query = ExtractQuery(argumentsJson);
        act?.SetTag("kb.query", query);

        var req = new KnowledgeBaseRetrievalRequest
        {
            Messages =
            {
                new KnowledgeBaseMessage(new KnowledgeBaseMessageContent[] { new KnowledgeBaseMessageTextContent(query) }) { Role = "user" }
            }
        };
        var resp = await _kb.RetrieveAsync(req, cancellationToken: ct);
        var citations = ExtractCitations(resp.Value);
        act?.SetTag("kb.citations.count", citations.Count);

        var payload = citations.Select((c, i) => new
        {
            index = i + 1,
            title = c.Title,
            url = c.Url,
            snippet = string.IsNullOrEmpty(c.Snippet) ? null : (c.Snippet!.Length > 1500 ? c.Snippet[..1500] + "…" : c.Snippet),
        });
        var json = JsonSerializer.Serialize(payload);
        return (json, citations);
    }

    private static string ExtractQuery(string argumentsJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(argumentsJson);
            if (doc.RootElement.TryGetProperty("query", out var q) && q.ValueKind == JsonValueKind.String)
                return q.GetString() ?? "";
        }
        catch (JsonException) { }
        return argumentsJson;
    }

    private static List<Citation> ExtractCitations(KnowledgeBaseRetrievalResponse resp)
        => KbCitationParser.Extract(resp).ToList();

    private static IReadOnlyList<Citation> DedupeCitations(IEnumerable<Citation> citations)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<Citation>();
        foreach (var c in citations)
        {
            var key = string.IsNullOrEmpty(c.Url) ? c.Title : c.Url;
            if (seen.Add(key)) list.Add(c);
        }
        return list;
    }

    private async Task<string> GetLatestAssistantTextAsync(string threadId, string runId, CancellationToken ct)
    {
        await foreach (var msg in _agents.Messages.GetMessagesAsync(threadId, runId: runId, limit: 20, order: ListSortOrder.Descending, after: null, before: null, ct))
        {
            if (msg.Role != MessageRole.Agent) continue;
            var sb = new System.Text.StringBuilder();
            foreach (var item in msg.ContentItems)
            {
                if (item is MessageTextContent text) sb.AppendLine(text.Text);
            }
            var s = sb.ToString().Trim();
            if (!string.IsNullOrEmpty(s)) return s;
        }
        return "(no answer)";
    }
}
