using Azure.AI.Projects;
using Azure.Identity;
using Demo1.Agent;
using Demo1.Agent.Tools;
using DotNetEnv;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Foundry.Hosting;
using Microsoft.Extensions.AI;

Env.TraversePath().Load();

var projectEndpoint = new Uri(Environment.GetEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT")
    ?? throw new InvalidOperationException("FOUNDRY_PROJECT_ENDPOINT is not set."));
var deployment = Environment.GetEnvironmentVariable("AZURE_AI_MODEL_DEPLOYMENT_NAME")
    ?? throw new InvalidOperationException("AZURE_AI_MODEL_DEPLOYMENT_NAME is not set.");
var searchEndpoint = new Uri(Environment.GetEnvironmentVariable("DEMO1_SEARCH_ENDPOINT")
    ?? throw new InvalidOperationException("DEMO1_SEARCH_ENDPOINT is not set."));
var knowledgeBaseName = Environment.GetEnvironmentVariable("DEMO1_KNOWLEDGE_BASE_NAME")
    ?? throw new InvalidOperationException("DEMO1_KNOWLEDGE_BASE_NAME is not set.");

var credential = new DefaultAzureCredential();
var kbTool = new KnowledgeBaseSearchTool(searchEndpoint, knowledgeBaseName, credential);

AIAgent agent = new AIProjectClient(projectEndpoint, credential)
    .AsAIAgent(
        model: deployment,
        instructions: Instructions.System,
        name: "demo1-kb-mslearn",
        description: "Microsoft developer-platform assistant grounded via the kb-mslearn knowledge base.",
        tools:
        [
            AIFunctionFactory.Create(kbTool.SearchAsync, "knowledge_base_search"),
        ]);

var builder = AgentHost.CreateBuilder(args);
builder.Services.AddFoundryResponses(agent);
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
