import type { ReactNode } from 'react';

import type { ConfidenceBand, MarketBasis, Provenance } from '../../types/dataProduct.ts';

interface ProductPanelProps {
  eyebrow: string;
  title: string;
  description: string;
  endpoints?: string[];
  children: ReactNode;
}

const cardClass =
  'rounded-lg border border-[#1F2937] bg-[#0D1117] p-5';

export function ProductPanel({
  eyebrow,
  title,
  description,
  endpoints = [],
  children,
}: ProductPanelProps) {
  return (
    <section className={cardClass} aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1F2937] pb-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-400">
            {eyebrow}
          </div>
          <h2 className="mt-1 font-display text-lg font-semibold text-[#F1F5F9]">
            {title}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[#94A3B8]">
            {description}
          </p>
        </div>
        {endpoints.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {endpoints.map((endpoint) => (
              <code
                key={endpoint}
                className="rounded border border-[#243040] bg-[#090C10] px-2 py-1 font-mono text-[10px] text-[#7DD3FC]"
              >
                {endpoint}
              </code>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function LoadingState({ label = 'Loading first-party data…' }: { label?: string }) {
  return (
    <div className="animate-pulse space-y-2" role="status" aria-label={label}>
      <div className="h-4 w-1/3 rounded bg-[#1F2937]" />
      <div className="h-16 rounded bg-[#161D27]" />
      <p className="text-[11px] text-[#64748B]">{label}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-amber-500/40 bg-amber-950/25 px-3 py-2.5 text-xs text-amber-200"
    >
      <div className="flex items-center justify-between gap-3">
        <span>
          Endpoint unavailable or contract not yet deployed: {message}
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded border border-amber-500/50 px-2 py-1 font-medium hover:bg-amber-500/10"
          >
            Retry
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-amber-200/70">
        No placeholder values are substituted. Missing data stays UNKNOWN.
      </p>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-[#243040] px-3 py-6 text-center text-xs text-[#64748B]">
      {message}
    </div>
  );
}

export function BasisChip({ basis }: { basis: MarketBasis }) {
  const known = basis !== 'UNKNOWN';
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
        known
          ? 'bg-sky-500/10 text-sky-300'
          : 'bg-slate-500/10 text-slate-400'
      }`}
      title="Basis is explicit and never defaulted"
    >
      {basis}
    </span>
  );
}

export function ConfidenceChip({ value }: { value: ConfidenceBand }) {
  const tone: Record<ConfidenceBand, string> = {
    HIGH: 'text-emerald-300',
    MEDIUM: 'text-sky-300',
    LOW: 'text-amber-300',
    UNKNOWN: 'text-slate-400',
  };
  return <span className={`font-mono text-[10px] ${tone[value]}`}>{value}</span>;
}

export function ProvenanceLine({ provenance }: { provenance?: Provenance }) {
  if (!provenance) {
    return (
      <p className="mt-1 font-mono text-[10px] text-[#64748B]">
        provenance: UNKNOWN
      </p>
    );
  }
  return (
    <p className="mt-1 truncate font-mono text-[10px] text-[#64748B]">
      source={provenance.source} · observed={provenance.observedAt} · captured=
      {provenance.capturedAt} · lineage={provenance.lineage.length} · confidence=
      {provenance.confidence}
    </p>
  );
}

export function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 rounded border border-[#243040] bg-[#090C10] px-3 py-2 text-[11px] leading-relaxed text-[#94A3B8]">
      {children}
    </p>
  );
}
