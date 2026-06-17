namespace ChatbotApi;

public sealed record ChatMessage(string Role, string Content);

public sealed record ChatRequest(string Question, IReadOnlyList<ChatMessage>? History = null);

public sealed record Citation(string Title, string Url, string? Snippet);

public sealed record ChatResponse(
    string Answer,
    IReadOnlyList<Citation> Citations,
    string Source,
    long ElapsedMs,
    string? TraceId);
