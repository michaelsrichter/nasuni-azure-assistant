using AgentGovernance;
using AgentGovernance.Audit;
using AgentGovernance.Security;
using AgentGovernance.Trust;

namespace Demo1.Agent.Governance;

/// <summary>
/// The governance decision returned for a single tool invocation. Serialized
/// into the tool output so the SPA can render policy/safety badges, and shaped
/// to read cleanly as camelCase JSON.
/// </summary>
internal sealed record GovernanceVerdict
{
    public required bool Enforced { get; init; }
    public required bool Allowed { get; init; }
    public required string Decision { get; init; }      // "allowed" | "blocked" | "disabled"
    public string? Category { get; init; }              // "capability" | "prompt_injection" | "data_egress"
    public required string Reason { get; init; }
    public required string Policy { get; init; }
    public string? Rule { get; init; }
    public required string AgentDid { get; init; }
    public long? AuditSeq { get; init; }
    public string? AuditHash { get; init; }
    public InjectionInfo? Injection { get; init; }
}

internal sealed record InjectionInfo(bool Detected, string Type, string ThreatLevel, double Confidence);

/// <summary>
/// Wraps the Microsoft Agent Governance Toolkit (AGT) into a single decision
/// point for the agent's one tool. It layers three deterministic controls:
///   1. Capability policy  — the AGT <see cref="GovernanceKernel"/> policy engine
///      (policy.yaml) decides whether the tool may run at all.
///   2. Prompt-injection    — AGT's built-in detector inspects the query.
///   3. Data-egress         — <see cref="SensitiveDataScanner"/> blocks secrets/PII
///      from being sent to the external Microsoft Learn MCP source.
/// Every decision is written to a tamper-evident, hash-chained audit log and
/// emitted on the kernel's event bus (which also records OpenTelemetry metrics).
/// </summary>
internal sealed class GovernanceGate : IDisposable
{
    private const string ToolName = "knowledge_base_search";

    private readonly GovernanceKernel _kernel;
    private readonly SensitiveDataScanner _scanner = new();
    private readonly AuditLogger _audit = new();
    private readonly AgentIdentity _identity;
    private readonly string _policyName;
    private readonly string? _auditPath;
    private readonly object _auditLock = new();

    public string AgentDid => _identity.Did;

    public GovernanceGate(string policyPath, string? auditPath = null)
    {
        _kernel = new GovernanceKernel(new GovernanceOptions
        {
            PolicyPaths = [policyPath],
            EnableAudit = true,
            EnableMetrics = true,
            EnablePromptInjectionDetection = true,
        });
        _policyName = "demo1-governance";
        _identity = AgentIdentity.Create(
            "demo1-kb-mslearn",
            sponsor: "demo1@contoso.com",
            capabilities: [ToolName]);
        _auditPath = auditPath;
    }

    /// <summary>
    /// Evaluate a knowledge-base search before it runs. When <paramref name="enforce"/>
    /// is false the call is allowed through ungoverned (the "governance OFF" demo state).
    /// </summary>
    public GovernanceVerdict Evaluate(string query, bool enforce, string sessionId)
    {
        if (!enforce)
        {
            return new GovernanceVerdict
            {
                Enforced = false,
                Allowed = true,
                Decision = "disabled",
                Reason = "Governance is turned off for this turn.",
                Policy = _policyName,
                AgentDid = _identity.Did,
            };
        }

        // 1. Capability policy (AGT policy engine + audit + metrics).
        var policy = _kernel.EvaluateToolCall(_identity.Did, ToolName, new Dictionary<string, object> { ["query"] = query });

        // 2. Prompt-injection detection.
        var detector = _kernel.InjectionDetector;
        var inj = detector is not null ? detector.Detect(query) : DetectionResult.Safe(query);
        var injection = new InjectionInfo(inj.IsInjection, inj.InjectionType.ToString(), inj.ThreatLevel.ToString(), inj.Confidence);

        // 3. Sensitive-data egress scan.
        var scan = _scanner.Scan(query);

        bool allowed;
        string? category;
        string reason;
        string? rule = policy.PolicyDecision?.MatchedRule;

        if (!policy.Allowed)
        {
            allowed = false;
            category = "capability";
            reason = $"Capability blocked by policy '{_policyName}': {policy.Reason}";
        }
        else if (inj.IsInjection && inj.ThreatLevel >= ThreatLevel.High)
        {
            allowed = false;
            category = "prompt_injection";
            reason = $"Prompt-injection blocked: {inj.InjectionType} ({inj.ThreatLevel}).";
        }
        else if (scan.Hit)
        {
            allowed = false;
            category = "data_egress";
            reason = scan.Reason;
        }
        else
        {
            allowed = true;
            category = null;
            reason = "Allowed: sanctioned capability, no prompt-injection or sensitive-data egress detected.";
        }

        var decision = allowed ? "allowed" : "blocked";
        var entry = AppendAudit(category is null ? ToolName : $"{ToolName}:{category}", decision);

        if (!allowed)
        {
            _kernel.Metrics?.RecordDecision(false, _identity.Did, ToolName, evaluationMs: 0, rateLimited: false);
            _kernel.AuditEmitter.Emit(
                GovernanceEventType.ToolCallBlocked,
                _identity.Did,
                sessionId,
                new Dictionary<string, object> { ["category"] = category ?? "policy", ["reason"] = reason },
                _policyName);
        }

        return new GovernanceVerdict
        {
            Enforced = true,
            Allowed = allowed,
            Decision = decision,
            Category = category,
            Reason = reason,
            Policy = _policyName,
            Rule = rule,
            AgentDid = _identity.Did,
            AuditSeq = entry?.Seq,
            AuditHash = entry?.Hash,
            Injection = injection,
        };
    }

    private AuditEntry? AppendAudit(string action, string decision)
    {
        lock (_auditLock)
        {
            var entry = _audit.Log(_identity.Did, action, decision);
            if (!string.IsNullOrWhiteSpace(_auditPath))
            {
                try { File.WriteAllText(_auditPath, _audit.ExportJson()); }
                catch (IOException) { /* best-effort evidence file */ }
            }
            return entry;
        }
    }

    public void Dispose() => _kernel.Dispose();
}
