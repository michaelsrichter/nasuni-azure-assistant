using System.Text.Json;
using System.Text.Json.Serialization;

namespace Demo1.Infra;

public sealed class InfraConfig
{
    public required string SubscriptionId { get; init; }
    public required string ResourceGroup { get; init; }
    public required string Location { get; init; }
    public required string FoundryAccountName { get; init; }
    public required string ProjectName { get; init; }
    public required string ProjectEndpoint { get; init; }
    public required string ModelDeploymentName { get; init; }
    public required string McpServerUrl { get; init; }
    public required string KnowledgeBaseName { get; init; }
    public required string KnowledgeSourceName { get; init; }
    public required string AgentName { get; init; }
    public required string HostedAgentName { get; init; }
    public required string AppInsightsConnectionName { get; init; }

    private static readonly JsonSerializerOptions s_options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public static InfraConfig Load(string path)
    {
        var text = File.ReadAllText(path);
        return JsonSerializer.Deserialize<InfraConfig>(text, s_options)
            ?? throw new InvalidOperationException($"Failed to parse {path}");
    }
}

public sealed class InfraState
{
    public string? SearchServiceName { get; set; }
    public string? SearchEndpoint { get; set; }
    public string? SearchConnectionName { get; set; }
    public string? KnowledgeSourceId { get; set; }
    public string? KnowledgeBaseId { get; set; }
    public string? HostedAgentId { get; set; }
    public string? AppInsightsConnectionString { get; set; }
    public DateTimeOffset? LastUpdated { get; set; }

    private static readonly JsonSerializerOptions s_options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static InfraState Load(string path)
    {
        if (!File.Exists(path)) return new InfraState();
        var text = File.ReadAllText(path);
        return JsonSerializer.Deserialize<InfraState>(text, s_options) ?? new InfraState();
    }

    public void Save(string path)
    {
        LastUpdated = DateTimeOffset.UtcNow;
        File.WriteAllText(path, JsonSerializer.Serialize(this, s_options));
    }
}
