using System.Text.RegularExpressions;

namespace Demo1.Agent.Governance;

/// <summary>
/// Deterministic content control for the "data egress" governance dimension.
///
/// The knowledge base fans out to an external Microsoft Learn MCP server, so a
/// search query is data that leaves the trust boundary. AGT's policy engine
/// governs <em>which</em> tool runs; this scanner governs <em>what</em> is
/// allowed to be sent to it. It flags queries that carry secrets, credentials,
/// private/PII identifiers, or internal network targets so the request is
/// blocked before anything is exfiltrated.
/// </summary>
internal sealed partial class SensitiveDataScanner
{
    public readonly record struct ScanResult(bool Hit, string Category, string Reason);

    private static readonly (Regex Pattern, string Category, string Reason)[] Rules =
    [
        (SecretAssignment(), "secret", "Query appears to contain a secret or credential (API key / password / token)."),
        (BearerToken(), "secret", "Query appears to contain a bearer or access token."),
        (OpenAiKey(), "secret", "Query appears to contain an API key."),
        (AzureConnString(), "secret", "Query appears to contain an Azure storage connection string or account key."),
        (PrivateKeyBlock(), "secret", "Query appears to contain a private key block."),
        (Ssn(), "pii", "Query appears to contain a national identifier (e.g. SSN)."),
        (CreditCard(), "pii", "Query appears to contain a payment-card number."),
        (ImdsEndpoint(), "egress", "Query targets the cloud instance-metadata endpoint (169.254.169.254)."),
        (PrivateHost(), "egress", "Query targets a private/internal network host."),
    ];

    public ScanResult Scan(string query)
    {
        if (string.IsNullOrWhiteSpace(query)) return new ScanResult(false, "", "");
        foreach (var (pattern, category, reason) in Rules)
        {
            if (pattern.IsMatch(query)) return new ScanResult(true, category, reason);
        }
        return new ScanResult(false, "", "");
    }

    [GeneratedRegex(@"(?i)\b(api[_-]?key|secret|password|passwd|pwd|client[_-]?secret)\b\s*[:=]\s*\S{4,}")]
    private static partial Regex SecretAssignment();

    [GeneratedRegex(@"(?i)\bbearer\s+[a-z0-9._\-]{16,}")]
    private static partial Regex BearerToken();

    [GeneratedRegex(@"\bsk-[A-Za-z0-9]{16,}\b")]
    private static partial Regex OpenAiKey();

    [GeneratedRegex(@"(?i)(AccountKey=[A-Za-z0-9+/=]{20,}|DefaultEndpointsProtocol=.*AccountKey=)")]
    private static partial Regex AzureConnString();

    [GeneratedRegex(@"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")]
    private static partial Regex PrivateKeyBlock();

    [GeneratedRegex(@"\b\d{3}-\d{2}-\d{4}\b")]
    private static partial Regex Ssn();

    [GeneratedRegex(@"\b(?:\d[ -]?){13,16}\b")]
    private static partial Regex CreditCard();

    [GeneratedRegex(@"\b169\.254\.169\.254\b")]
    private static partial Regex ImdsEndpoint();

    [GeneratedRegex(@"(?i)\b(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9.-]+\.(?:internal|local|corp))\b")]
    private static partial Regex PrivateHost();
}
