import { estimateCost, formatCost, type TokenUsage } from '../pricing';

interface UsageFooterProps {
  model: string;
  usage: TokenUsage;
  elapsedMs?: number;
}

export function UsageFooter({ model, usage, elapsedMs }: UsageFooterProps) {
  const cost = estimateCost(model, usage);
  return (
    <div className="usage-footer" aria-label="token usage and estimated cost">
      <span>{fmt(usage.inputTokens)} in</span>
      <span className="sep">·</span>
      <span>{fmt(usage.outputTokens)} out</span>
      <span className="sep">·</span>
      <span title={`${model} list pricing`}>{formatCost(cost)}</span>
      {elapsedMs != null && (
        <>
          <span className="sep">·</span>
          <span>{elapsedMs} ms</span>
        </>
      )}
      {model && (
        <>
          <span className="sep">·</span>
          <span className="model">{model}</span>
        </>
      )}
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString();
}
