import type {
  GraphStatePayload,
  SwarmRoutingConfig,
} from '../../types/graph.ts';
import { HermesConnectView } from '../HermesConnectView.tsx';
import {
  InlineNotice,
  ProductPanel,
} from './ProductPanel.tsx';

interface ApiHermesViewProps {
  routing: SwarmRoutingConfig;
  onUpdateRouting: (patch: Partial<SwarmRoutingConfig>) => Promise<void>;
  onRefreshState: (nextState: GraphStatePayload) => void;
}

/** Stable Hermes tool IDs. Renaming any of these is a breaking change. */
export const STABLE_HERMES_TOOL_IDS = [
  'get_collectible_valuation',
  'scan_arbitrage_spreads',
  'query_knowledge_graph',
  'ingest_market_listing',
] as const;

/**
 * API / Hermes — the machine-readable OpenAPI 3.1 contract and the stable
 * Hermes gateway surface for the trading-card data product.
 */
export function ApiHermesView({
  routing,
  onUpdateRouting,
  onRefreshState,
}: ApiHermesViewProps) {
  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Integrations"
        title="API & Hermes"
        description="The trading-card data product exposes a versioned OpenAPI 3.1 contract and a stable Hermes tool bridge. Agents consume first-party evidence; they never write canonical facts directly."
        endpoints={['docs/openapi.json', '/api/hermes/status']}
      >
        <InlineNotice>
          Basis is explicit (SOLD / ASKING / OFFER / GUIDE / CLAIM / POPULATION /
          UNKNOWN) and every fact carries source, observed_at, captured_at,
          lineage and confidence. Missing data stays UNKNOWN.
        </InlineNotice>
        <h3 className="text-xs font-semibold text-[#E2E8F0]">
          Stable Hermes tool IDs
        </h3>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {STABLE_HERMES_TOOL_IDS.map((tool) => (
            <li
              key={tool}
              className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2 font-mono text-[11px] text-[#7DD3FC]"
            >
              {tool}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-[#94A3B8]">
          The full machine-readable contract (catalog, pricing, comps, market,
          intelligence, swarm, forecast, learning, SQL Lab, evidence/ingest)
          lives in <code className="font-mono text-[#CBD5E1]">docs/openapi.json</code>.
        </p>
      </ProductPanel>

      <HermesConnectView
        routing={routing}
        onUpdateRouting={onUpdateRouting}
        onRefreshState={onRefreshState}
      />
    </div>
  );
}
