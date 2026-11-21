import { useState, type FormEvent } from 'react';
import { Briefcase, Plus, Trash2 } from 'lucide-react';
import type { GradeLabel, GraphStatePayload } from '../types/graph.ts';
import { apiFetch } from '../utils/apiClient.ts';
import { formatPct, formatUsd } from '../utils/visualAssets.ts';

interface PortfolioViewProps {
  state: GraphStatePayload;
  onSelectAsset: (assetId: string) => void;
  onRefreshState: (next: GraphStatePayload) => void;
  onOpenAddAsset: () => void;
}

export function PortfolioView({
  state,
  onSelectAsset,
  onRefreshState,
  onOpenAddAsset,
}: PortfolioViewProps) {
  const [assetId, setAssetId] = useState<string>(state.assets[0]?.id || '');
  const [grade, setGrade] = useState<GradeLabel>('PSA 10');
  const [quantity, setQuantity] = useState('1');
  const [costBasisUsd, setCostBasisUsd] = useState('');
  const [acquiredDate, setAcquiredDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [certNumber, setCertNumber] = useState('');
  const [vaultLocation, setVaultLocation] = useState('Personal Vault');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedAssetId = assetId || state.assets[0]?.id || '';
  const portfolio = state.portfolio;

  async function handleAddHolding(e: FormEvent) {
    e.preventDefault();
    if (!selectedAssetId) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/portfolio/holdings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: selectedAssetId,
          grade,
          quantity: Number(quantity) || 1,
          costBasisUsd: Number(costBasisUsd) || 0,
          acquiredDate,
          certNumber: certNumber.trim() || undefined,
          vaultLocation: vaultLocation.trim() || 'Personal Vault',
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to save holding.');
      if (json.state) onRefreshState(json.state);
      setCostBasisUsd('');
      setCertNumber('');
      setQuantity('1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add holding.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteHolding(id: string) {
    setError(null);
    try {
      const res = await apiFetch(`/api/portfolio/holdings/${id}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to delete holding.');
      if (json.state) onRefreshState(json.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete holding.');
    }
  }

  return (
    <div className="space-y-6">
      {/* Deterministic Portfolio KPI Strip */}
      <section className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[#1F2937] bg-[#1F2937] sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-[#11161D] p-5">
          <div className="text-xs font-medium text-[#94A3B8]">
            Verified Portfolio Value
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[#F1F5F9]">
            {formatUsd(portfolio.totalMarketValueUsd)}
          </div>
          <div className="mt-1 text-[11px] text-[#64748B]">
            Marked strictly to verified SOLD_ON comps
          </div>
        </div>

        <div className="bg-[#11161D] p-5">
          <div className="text-xs font-medium text-[#94A3B8]">Total Cost Basis</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-[#F1F5F9]">
            {formatUsd(portfolio.totalCostBasisUsd)}
          </div>
          <div className="mt-1 text-[11px] text-[#64748B]">
            {portfolio.totalHoldingsCount} positions · {portfolio.totalUnits} unit(s)
          </div>
        </div>

        <div className="bg-[#11161D] p-5">
          <div className="text-xs font-medium text-[#94A3B8]">Unrealized P&amp;L</div>
          <div
            className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${
              portfolio.totalUnrealizedPnlUsd >= 0
                ? 'text-emerald-400'
                : 'text-red-400'
            }`}
          >
            {portfolio.totalUnrealizedPnlUsd >= 0 ? '+' : ''}
            {formatUsd(portfolio.totalUnrealizedPnlUsd)}
          </div>
          <div
            className={`mt-1 font-mono text-xs tabular-nums ${
              portfolio.totalUnrealizedPnlPct >= 0
                ? 'text-emerald-400'
                : 'text-red-400'
            }`}
          >
            {formatPct(portfolio.totalUnrealizedPnlPct)} on priced positions
          </div>
        </div>

        <div className="bg-[#11161D] p-5">
          <div className="text-xs font-medium text-[#94A3B8]">
            Persistence Engine
          </div>
          <div className="mt-2 truncate font-mono text-sm font-semibold text-[#E2E8F0]">
            {state.storage.filePath}
          </div>
          <div className="mt-1 text-[11px] text-[#64748B]">
            Saved locally on your self-hosted server
          </div>
        </div>
      </section>

      {/* Add Holding Form */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1F2937] pb-3">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Add Graded Holding to Personal Vault
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Link your owned slabs or raw copies to canonical graph nodes for automatic deterministic valuation.
            </p>
          </div>
          {state.assets.length === 0 && (
            <button
              type="button"
              onClick={onOpenAddAsset}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Register Collectible First</span>
            </button>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-red-500/40 bg-red-950/35 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        {state.assets.length > 0 ? (
          <form onSubmit={handleAddHolding} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="lg:col-span-2">
              <label className="block text-[11px] text-[#94A3B8]">Canonical Asset</label>
              <select
                value={selectedAssetId}
                onChange={(e) => setAssetId(e.target.value)}
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
              >
                {state.assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title} ({a.franchise})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[#94A3B8]">Grade</label>
              <select
                value={grade}
                onChange={(e) => setGrade(e.target.value as GradeLabel)}
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
              >
                <option value="PSA 10">PSA 10</option>
                <option value="BGS 9.5">BGS 9.5</option>
                <option value="SGC 10">SGC 10</option>
                <option value="PSA 9">PSA 9</option>
                <option value="Raw NM">Raw NM</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] text-[#94A3B8]">Unit Cost Basis ($)</label>
              <input
                type="number"
                required
                min={0}
                step="0.01"
                value={costBasisUsd}
                onChange={(e) => setCostBasisUsd(e.target.value)}
                placeholder="e.g. 2400"
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-2 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[11px] text-[#94A3B8]">Qty &amp; Cert #</label>
              <div className="mt-1 flex gap-1.5">
                <input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-14 rounded-md border border-[#243040] bg-[#090C10] px-2 py-2 font-mono text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                />
                <input
                  type="text"
                  value={certNumber}
                  onChange={(e) => setCertNumber(e.target.value)}
                  placeholder="Cert #"
                  className="min-w-0 flex-1 rounded-md border border-[#243040] bg-[#090C10] px-2 py-2 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-[#94A3B8]">Vault &amp; Date</label>
              <div className="mt-1 flex gap-1.5">
                <input
                  type="text"
                  value={vaultLocation}
                  onChange={(e) => setVaultLocation(e.target.value)}
                  placeholder="Vault"
                  className="min-w-0 flex-1 rounded-md border border-[#243040] bg-[#090C10] px-2 py-2 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <input
                type="hidden"
                value={acquiredDate}
                onChange={(e) => setAcquiredDate(e.target.value)}
              />
            </div>
          </form>
        ) : (
          <p className="mt-4 text-xs text-[#94A3B8]">
            Register at least one canonical collectible in your Knowledge Graph before adding personal slab holdings.
          </p>
        )}
      </section>

      {/* Holdings Table */}
      <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="border-b border-[#1F2937] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-[#F1F5F9]">
            Vault Holdings Ledger ({portfolio.holdings.length})
          </h3>
        </div>

        {portfolio.holdings.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <Briefcase className="h-6 w-6 text-[#475569]" />
            <p className="text-xs font-medium text-[#CBD5E1]">
              No slab holdings recorded yet.
            </p>
            <p className="max-w-md text-xs text-[#64748B]">
              Add your owned graded cards above to track live unrealized P&amp;L marked automatically against verified marketplace comps.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#1F2937] text-[#94A3B8]">
                  <th className="px-5 py-3 font-medium">Collectible</th>
                  <th className="px-4 py-3 font-medium">Grade &amp; Cert</th>
                  <th className="px-4 py-3 font-medium">Vault</th>
                  <th className="px-4 py-3 text-right font-medium">Cost Basis</th>
                  <th className="px-4 py-3 text-right font-medium">Market Value</th>
                  <th className="px-4 py-3 text-right font-medium">Unrealized P&amp;L</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {portfolio.holdings.map((h) => (
                  <tr key={h.id} className="hover:bg-[#161D27]/70">
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        onClick={() => onSelectAsset(h.assetId)}
                        className="text-left font-medium text-[#F1F5F9] hover:text-emerald-400"
                      >
                        {h.assetTitle}
                      </button>
                      <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                        {h.franchise} · Qty {h.quantity} · Acquired {h.acquiredDate}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[#CBD5E1]">
                      <div>{h.grade}</div>
                      {h.certNumber && (
                        <div className="text-[11px] text-[#64748B]">
                          #{h.certNumber}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[#94A3B8]">{h.vaultLocation}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[#E2E8F0]">
                      {formatUsd(h.totalCostBasisUsd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-[#F1F5F9]">
                      {h.pricingSource === 'VERIFIED_GRADE_COMP' ? (
                        formatUsd(h.totalMarketValueUsd)
                      ) : (
                        <span className="text-[#64748B]">Awaiting comps</span>
                      )}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono tabular-nums ${
                        h.pricingSource !== 'VERIFIED_GRADE_COMP'
                          ? 'text-[#64748B]'
                          : h.unrealizedPnlUsd >= 0
                            ? 'text-emerald-400'
                            : 'text-red-400'
                      }`}
                    >
                      {h.pricingSource === 'VERIFIED_GRADE_COMP' ? (
                        <>
                          <div>
                            {h.unrealizedPnlUsd >= 0 ? '+' : ''}
                            {formatUsd(h.unrealizedPnlUsd)}
                          </div>
                          <div className="text-[11px]">
                            {formatPct(h.unrealizedPnlPct)}
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteHolding(h.id)}
                        aria-label="Remove holding"
                        className="rounded p-1.5 text-[#64748B] hover:bg-[#1F2937] hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
