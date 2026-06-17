namespace ChatbotApi;

public sealed class Demo1Options
{
    public string SearchEndpoint { get; init; } = "";
    public string KnowledgeBaseName { get; init; } = "";
    public string FoundryOpenAIEndpoint { get; init; } = "";
    public string ChatDeployment { get; init; } = "";
    public string McpServerUrl { get; init; } = "";
    public string ApplicationInsightsConnectionString { get; init; } = "";
}
