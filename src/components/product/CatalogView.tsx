import { useState, type FormEvent } from 'react';

import type { CatalogItem, PrintingView } from '../../types/dataProduct.ts';
import {
  ROUTES,
  buildRoute,
  withQuery,
  useEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  ConfidenceChip,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  ProductPanel,
  ProvenanceLine,
} from './ProductPanel.tsx';

/**
 * Catalog — deterministic identity resolution for trading cards before any
 * swarm adjudication. Identity is a first-party fact, never an LLM guess.
 */
export function CatalogView() {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const searchPath = query
    ? withQuery(ROUTES.catalogSearch, { q: query })
    : ROUTES.catalogSearch;
  const search = useEnvelope<CatalogItem[]>(searchPath);
  const detail = useEnvelope<CatalogItem>(
    selectedId ? buildRoute(ROUTES.catalogById, { id: selectedId }) : null
  );
  const printings = useEnvelope<PrintingView[]>(
    selectedId ? buildRoute(ROUTES.catalogPrintings, { id: selectedId }) : null
  );

  function handleSearch(event: FormEvent) {
    event.preventDefault();
    setQuery(term.trim());
  }

  const results = search.data ?? [];

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Identity layer"
        title="Trading Card Catalog"
        description="Search canonical cards, sets and printings. Identity resolution is deterministic and runs before swarm adjudication; ambiguous candidates are quarantined until evidence supports a decision."
        endpoints={[ROUTES.catalogSearch, ROUTES.catalogById, ROUTES.catalogPrintings]}
      >
        <InlineNotice>
          A printing is only promoted to canonical identity when its evidence is
          sufficient. Unresolved trading-card variants remain UNKNOWN rather than
          being merged by similarity alone.
        </InlineNotice>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            aria-label="Search the trading card catalog"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Card name, set, number or game"
            className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white"
          >
            Search
          </button>
        </form>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
              Catalog results
            </h3>
            {search.loading ? (
              <LoadingState />
            ) : search.error ? (
              <ErrorState message={search.error} onRetry={search.reload} />
            ) : results.length === 0 ? (
              <EmptyState message="No canonical trading cards matched. Adjust the search or ingest evidence in Sources." />
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto">
                {results.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                        selectedId === item.id
                          ? 'border-emerald-500/60 bg-emerald-950/20'
                          : 'border-[#1F2937] bg-[#090C10] hover:border-[#243040]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-[#E2E8F0]">
                          {item.name}
                        </span>
                        <ConfidenceChip value={item.identityConfidence} />
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-[#64748B]">
                        {item.game} · {item.set} · #{item.number}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
              Selected printing set
            </h3>
            {!selectedId ? (
              <EmptyState message="Select a trading card to inspect its canonical printings." />
            ) : detail.loading || printings.loading ? (
              <LoadingState />
            ) : detail.error ? (
              <ErrorState message={detail.error} onRetry={detail.reload} />
            ) : (
              <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
                <p className="text-sm font-medium text-[#F1F5F9]">
                  {detail.data?.name ?? selectedId}
                </p>
                <ProvenanceLine provenance={detail.data?.provenance} />
                {printings.error ? (
                  <div className="mt-3">
                    <ErrorState message={printings.error} onRetry={printings.reload} />
                  </div>
                ) : (printings.data ?? []).length === 0 ? (
                  <p className="mt-3 text-[11px] text-[#64748B]">
                    No printings resolved. Population data stays UNKNOWN.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {(printings.data ?? []).map((printing) => (
                      <li
                        key={printing.id}
                        className="flex items-center justify-between gap-2 border-t border-[#1F2937] pt-2 text-[11px]"
                      >
                        <span className="truncate text-[#CBD5E1]">
                          {printing.label} · {printing.finish} · {printing.language}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-[#94A3B8]">
                          pop={printing.gradingPopulation ?? 'UNKNOWN'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </ProductPanel>
    </div>
  );
}
