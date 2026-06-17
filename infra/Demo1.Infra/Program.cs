using Demo1.Infra;
using Demo1.Infra.Commands;

if (args.Length == 0)
{
    Console.WriteLine("Usage: dotnet run --project infra/Demo1.Infra -- <command>");
    Console.WriteLine("Commands:");
    Console.WriteLine("  ensure-search      Provision/detect Azure AI Search and connect to the Foundry project");
    Console.WriteLine("  ensure-kb          Create the knowledge source and knowledge base");
    Console.WriteLine("  ensure-agent       Smoke-test the KB end-to-end (KB -> MCP -> grounded answer)");
    Console.WriteLine("  ensure-all         Run ensure-search, ensure-kb, ensure-agent in sequence");
    return 1;
}

var configPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
if (!File.Exists(configPath))
{
    var src = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "appsettings.json"));
    if (File.Exists(src)) configPath = src;
}
var cfg = InfraConfig.Load(configPath);

var statePath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "state.json"));
var state = InfraState.Load(statePath);

try
{
    return args[0] switch
    {
        "ensure-search" => await EnsureSearchCommand.RunAsync(cfg, state, statePath),
        "ensure-kb" => await EnsureKnowledgeBaseCommand.RunAsync(cfg, state, statePath),
        "ensure-agent" => await EnsureAgentCommand.RunAsync(cfg, state, statePath),
        "ensure-all" => await EnsureAll(cfg, state, statePath),
        _ => Fail($"Unknown command: {args[0]}"),
    };
}
catch (Exception ex)
{
    Console.Error.WriteLine($"FAIL: {ex.GetType().Name}: {ex.Message}");
    Console.Error.WriteLine(ex.StackTrace);
    return 2;
}

static int Fail(string msg)
{
    Console.Error.WriteLine(msg);
    return 1;
}

static async Task<int> EnsureAll(InfraConfig cfg, InfraState state, string statePath)
{
    var rc = await EnsureSearchCommand.RunAsync(cfg, state, statePath);
    if (rc != 0) return rc;
    rc = await EnsureKnowledgeBaseCommand.RunAsync(cfg, state, statePath);
    if (rc != 0) return rc;
    return await EnsureAgentCommand.RunAsync(cfg, state, statePath);
}
