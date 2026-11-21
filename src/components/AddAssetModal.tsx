import { useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  GradeLabel,
  MarketplaceId,
  MarketplaceNode,
  MarketSegment,
} from '../types/graph.ts';
import { apiFetch } from '../utils/apiClient.ts';

interface AddAssetModalProps {
  open: boolean;
  marketplaces: MarketplaceNode[];
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

export function AddAssetModal({
  open,
  marketplaces,
  onClose,
  onCreated,
}: AddAssetModalProps) {
  const [segment, setSegment] = useState<MarketSegment>('TCG');
  const [franchise, setFranchise] = useState('');
  const [title, setTitle] = useState('');
  const [setName, setSetName] = useState('');
  const [releaseYear, setReleaseYear] = useState(String(new Date().getFullYear()));
  const [cardNumber, setCardNumber] = useState('');
  const [variant, setVariant] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [topGradePop, setTopGradePop] = useState('');
  const [initialSalePriceUsd, setInitialSalePriceUsd] = useState('');
  const [initialSaleGrade, setInitialSaleGrade] = useState<GradeLabel>('PSA 10');
  const [initialSaleMarketplaceId, setInitialSaleMarketplaceId] =
    useState<MarketplaceId>('ebay_sold');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const parsedPop = Number(topGradePop);
      const parsedPrice = Number(initialSalePriceUsd);
      const res = await apiFetch('/api/graph/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segment,
          franchise,
          title,
          setName,
          releaseYear: Number(releaseYear) || new Date().getFullYear(),
          cardNumber: cardNumber.trim() || '#1',
          variant: variant.trim() || 'Base',
          subjectName: subjectName.trim() || title.trim(),
          topGradePop: Number.isFinite(parsedPop) && parsedPop > 0 ? parsedPop : 0,
          initialSalePriceUsd:
            Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : 0,
          initialSaleGrade,
          initialSaleMarketplaceId,
          initialSaleDate: new Date().toISOString().slice(0, 10),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to register asset');
      }
      await onCreated();
      setFranchise('');
      setTitle('');
      setSetName('');
      setCardNumber('');
      setVariant('');
      setSubjectName('');
      setTopGradePop('');
      setInitialSalePriceUsd('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to add collectible.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-[#1F2937] bg-[#11161D] text-[#F1F5F9]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[#F1F5F9]">
              Register Canonical Collectible
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Add a real TCG or sports collectible node to your persistent Knowledge Graph.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-md p-1.5 text-[#94A3B8] hover:bg-[#161D27] hover:text-[#F1F5F9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[#CBD5E1]">
              Asset Segment
            </label>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(['TCG', 'SPORTS'] as const).map((seg) => (
                <button
                  key={seg}
                  type="button"
                  onClick={() => setSegment(seg)}
                  className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                    segment === seg
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                      : 'border-[#243040] bg-[#0D1117] text-[#94A3B8] hover:text-[#E2E8F0]'
                  }`}
                >
                  {seg === 'TCG' ? 'Trading Card Game (TCG)' : 'Sports Collectible'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">
                Franchise or Sport *
              </label>
              <input
                type="text"
                required
                value={franchise}
                onChange={(e) => setFranchise(e.target.value)}
                placeholder={
                  segment === 'TCG'
                    ? 'e.g., Pokémon, Magic: The Gathering, One Piece'
                    : 'e.g., Basketball, Baseball, Football, F1'
                }
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">
                Subject (Character / Athlete) *
              </label>
              <input
                type="text"
                required
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                placeholder={
                  segment === 'TCG'
                    ? 'e.g., Charizard, Black Lotus'
                    : 'e.g., Michael Jordan, Shohei Ohtani'
                }
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">
                Canonical Card Title *
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Patrick Mahomes Optic Rated Rookie"
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">
                Set / Release Name *
              </label>
              <input
                type="text"
                required
                value={setName}
                onChange={(e) => setSetName(e.target.value)}
                placeholder="e.g., 2017 Donruss Optic"
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">Year</label>
              <input
                type="number"
                value={releaseYear}
                onChange={(e) => setReleaseYear(e.target.value)}
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">Card #</label>
              <input
                type="text"
                value={cardNumber}
                onChange={(e) => setCardNumber(e.target.value)}
                placeholder="e.g., #4/102"
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">Variant</label>
              <input
                type="text"
                value={variant}
                onChange={(e) => setVariant(e.target.value)}
                placeholder="Holo / Refractor"
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="space-y-2.5 border-t border-[#1F2937] pt-3">
            <div className="text-[11px] font-medium text-[#CBD5E1]">
              Optional: Opening Verified Comp &amp; Registry Pop (leave blank to await live feeds)
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <label className="block text-[11px] text-[#94A3B8]">Realized ($)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={initialSalePriceUsd}
                  onChange={(e) => setInitialSalePriceUsd(e.target.value)}
                  placeholder="Optional"
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#94A3B8]">Comp Grade</label>
                <select
                  value={initialSaleGrade}
                  onChange={(e) => setInitialSaleGrade(e.target.value as GradeLabel)}
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                >
                  <option value="PSA 10">PSA 10</option>
                  <option value="BGS 9.5">BGS 9.5</option>
                  <option value="SGC 10">SGC 10</option>
                  <option value="PSA 9">PSA 9</option>
                  <option value="Raw NM">Raw NM</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[#94A3B8]">Venue</label>
                <select
                  value={initialSaleMarketplaceId}
                  onChange={(e) =>
                    setInitialSaleMarketplaceId(e.target.value as MarketplaceId)
                  }
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                >
                  {marketplaces.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[#94A3B8]">Top Pop Count</label>
                <input
                  type="number"
                  min={0}
                  value={topGradePop}
                  onChange={(e) => setTopGradePop(e.target.value)}
                  placeholder="Optional"
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[#1F2937] pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#243040] px-4 py-2 text-xs font-medium text-[#CBD5E1] hover:bg-[#161D27]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{submitting ? 'Registering...' : 'Add to Knowledge Graph'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
