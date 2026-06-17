namespace ChatbotApi;

public sealed class Demo1Options
{
    public string SearchEndpoint { get; init; } = "";
    public string KnowledgeBaseName { get; init; } = "";
    public string FoundryOpenAIEndpoint { get; init; } = "";
    public string ChatDeployment { get; init; } = "";
    public string McpServerUrl { get; init; } = "";
    public string ApplicationInsightsConnectionString { get; init; } = "";

    // Optional: route chat through a portal-visible Foundry hosted agent that
    // calls the KB via a function tool executed by this backend.
    public bool UseHostedAgent { get; init; }
    public string ProjectEndpoint { get; init; } = "";
    public string HostedAgentId { get; init; } = "";
}
