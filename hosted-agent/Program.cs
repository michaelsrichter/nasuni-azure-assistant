using Azure.AI.Projects;
using Demo1.Agent;
using Demo1.Agent.Governance;
using Demo1.Agent.Tools;
using DotNetEnv;
using Microsoft.AspNetCore.Http;
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

var credential = CredentialFactory.Create();
var kbTool = new KnowledgeBaseSearchTool(searchEndpoint, knowledgeBaseName, credential);

// Agent Governance Toolkit: deterministic policy enforcement, prompt-injection
// detection, sensitive-data egress control, and a tamper-evident audit log
// applied to every knowledge-base search. The governance toggle is read from
// the per-request `x-agt-governance` header via IHttpContextAccessor.
var policyPath = Path.Combine(AppContext.BaseDirectory, "policy.yaml");
if (!File.Exists(policyPath)) policyPath = Path.Combine(Directory.GetCurrentDirectory(), "policy.yaml");
var auditPath = Environment.GetEnvironmentVariable("AGT_AUDIT_PATH")
    ?? Path.Combine(Directory.GetCurrentDirectory(), "agt-audit.json");
var gate = new GovernanceGate(policyPath, auditPath);
var httpContextAccessor = new HttpContextAccessor();
var governedKb = new GovernedKnowledgeBaseSearch(kbTool, gate, httpContextAccessor);

AIAgent agent = new AIProjectClient(projectEndpoint, credential)
    .AsAIAgent(
        model: deployment,
        instructions: Instructions.System,
        name: "demo1-kb-mslearn",
        description: "Microsoft developer-platform assistant grounded via the kb-mslearn knowledge base.",
        tools:
        [
            AIFunctionFactory.Create(governedKb.SearchAsync, "knowledge_base_search"),
        ]);

var builder = AgentHost.CreateBuilder(args);
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<IHttpContextAccessor>(httpContextAccessor);
builder.Services.AddSingleton(gate);
builder.Services.AddFoundryResponses(agent);
builder.RegisterProtocol("responses", endpoints => endpoints.MapFoundryResponses());

var app = builder.Build();
app.Run();
