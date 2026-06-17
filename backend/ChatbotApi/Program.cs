using Azure.Core;
using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using ChatbotApi;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

var opts = builder.Configuration.GetSection("Demo1").Get<Demo1Options>() ?? new Demo1Options();
builder.Services.AddSingleton(opts);
builder.Services.AddSingleton<TokenCredential>(_ => new Azure.Identity.DefaultAzureCredential());

builder.Services.AddHttpClient<McpDocsClient>();
if (opts.UseHostedAgent)
{
    builder.Services.AddSingleton<IChatService, AgentChatService>();
}
else
{
    builder.Services.AddSingleton<IChatService, ChatService>();
}

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? ["http://localhost:5173"])
    .AllowAnyHeader()
    .AllowAnyMethod()));

builder.Services.AddOpenApi();

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("ChatbotApi"))
    .WithTracing(t => t
        .AddSource("ChatbotApi")
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation());

if (!string.IsNullOrWhiteSpace(opts.ApplicationInsightsConnectionString))
{
    builder.Services.AddOpenTelemetry().UseAzureMonitor(o =>
        o.ConnectionString = opts.ApplicationInsightsConnectionString);
}

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseCors();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/api/chat", async (ChatRequest req, IChatService svc, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(req.Question))
        return Results.BadRequest(new { error = "Question is required." });
    try
    {
        var resp = await svc.AnswerAsync(req, ct);
        return Results.Ok(resp);
    }
    catch (Exception ex)
    {
        return Results.Problem(title: "Chat failed", detail: ex.Message, statusCode: 500);
    }
});

app.Run();

public partial class Program { }
