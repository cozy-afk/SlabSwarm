import { useCallback, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Database,
  FileText,
  Globe,
  GraduationCap,
  Link2,
  Menu,
  Search,
  Terminal,
  TrendingUp,
  X,
} from 'lucide-react';

import { ApiHermesView } from './components/product/ApiHermesView.tsx';
import { ActiveReportView } from './components/product/ActiveReportView.tsx';
import { CatalogView } from './components/product/CatalogView.tsx';
import { ForecastLabView } from './components/product/ForecastLabView.tsx';
import { LearningView } from './components/product/LearningView.tsx';
import { MarketIntelligenceView } from './components/product/MarketIntelligenceView.tsx';
import { ResearchSwarmView } from './components/product/ResearchSwarmView.tsx';
import { SourcesView } from './components/product/SourcesView.tsx';
import { SqlLabView } from './components/product/SqlLabView.tsx';
import { WebSourcesView } from './components/product/WebSourcesView.tsx';
import type { SwarmRoutingConfig } from './types/graph.ts';
import { apiFetch } from './utils/apiClient.ts';

type ActiveTab =
  | 'sources'
  | 'web-sources'
  | 'catalog'
  | 'intelligence'
  | 'active-report'
  | 'swarm'
  | 'forecast'
  | 'learning'
  | 'sql'
  | 'api';

const NAV_ITEMS: Array<{
  id: ActiveTab;
  label: string;
  sublabel: string;
  icon: typeof Database;
}> = [
  {
    id: 'sources',
    label: 'Sources',
    sublabel: 'Evidence & Observations',
    icon: Database,
  },
  {
    id: 'web-sources',
    label: 'Web Sources',
    sublabel: 'Harvest Review Queue',
    icon: Globe,
  },
  {
    id: 'catalog',
    label: 'Catalog',
    sublabel: 'Identity & Printings',
    icon: Search,
  },
  {
    id: 'intelligence',
    label: 'Market Intelligence',
    sublabel: 'Findings & Comps',
    icon: TrendingUp,
  },
  {
    id: 'active-report',
    label: 'Active Report',
    sublabel: 'Evidence-Backed Trading',
    icon: Activity,
  },
  {
    id: 'swarm',
    label: 'Research Swarm',
    sublabel: 'Evidence-First Roles',
    icon: Bot,
  },
  {
    id: 'forecast',
    label: 'Forecast Lab',
    sublabel: 'Bands & Scoring',
    icon: BarChart3,
  },
  {
    id: 'learning',
    label: 'Learning',
    sublabel: 'Calibration & Gates',
    icon: GraduationCap,
  },
  {
    id: 'sql',
    label: 'SQL Lab',
    sublabel: 'Parquet & DuckDB',
    icon: Terminal,
  },
  {
    id: 'api',
    label: 'API / Hermes',
    sublabel: 'OpenAPI 3.1 & Tools',
    icon: Link2,
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('sources');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [routing, setRouting] = useState<SwarmRoutingConfig>({
    entityResolution: 'gemini',
    outlierFilter: 'gemini',
    catalystSentiment: 'gemini',
    graphRagSynthesis: 'gemini',
  });
  const [routingNotice, setRoutingNotice] = useState<string | null>(null);

  const handleUpdateRouting = useCallback(
    async (patch: Partial<SwarmRoutingConfig>) => {
      const res = await apiFetch('/api/llm/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to update server routing.');
      }
      if (json.routing) setRouting(json.routing);
      setRoutingNotice('Server-side research routing updated.');
    },
    []
  );

  const activeNavMeta = NAV_ITEMS.find((item) => item.id === activeTab)!;

  function renderView() {
    switch (activeTab) {
      case 'sources':
        return <SourcesView />;
      case 'web-sources':
        return <WebSourcesView />;
      case 'catalog':
        return <CatalogView />;
      case 'intelligence':
        return <MarketIntelligenceView />;
      case 'active-report':
        return <ActiveReportView />;
      case 'swarm':
        return <ResearchSwarmView />;
      case 'forecast':
        return <ForecastLabView />;
      case 'learning':
        return <LearningView />;
      case 'sql':
        return <SqlLabView />;
      case 'api':
        return (
          <ApiHermesView
            routing={routing}
            onUpdateRouting={handleUpdateRouting}
            onRefreshState={() => undefined}
          />
        );
    }
  }

  return (
    <div className="flex min-h-screen bg-[#090C10] text-[#F1F5F9]">
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/65 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col border-r border-[#1F2937] bg-[#0D1117] transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-[#1F2937] px-5">
          <button
            type="button"
            onClick={() => {
              setActiveTab('sources');
              setMobileMenuOpen(false);
            }}
            className="font-display text-base font-bold tracking-tight text-[#F1F5F9] whitespace-nowrap shrink-0"
          >
            Slabswarm Data Product
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation"
            className="rounded p-1 text-[#94A3B8] hover:text-[#F1F5F9] lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav
          className="flex-1 space-y-1 overflow-y-auto p-3"
          aria-label="Data product sections"
        >
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'bg-[#161D27] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:bg-[#11161D] hover:text-[#E2E8F0]'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    isActive ? 'text-emerald-400' : 'text-[#64748B]'
                  }`}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{item.label}</div>
                  <div className="truncate text-[11px] text-[#64748B]">
                    {item.sublabel}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-[#1F2937] p-4 text-xs">
          <div className="text-[11px] font-medium text-[#94A3B8]">
            First-Party Trading Card Research
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[#64748B]">
            Raw evidence immutable. Simulations are hypotheses, never sales
            evidence. Missing fees, FX, grade and condition stay UNKNOWN.
          </p>
          <div className="mt-3 border-t border-[#1F2937] pt-3 font-mono text-[10px] text-[#94A3B8]">
            contract: 2026-11-22.1 · OpenAPI 3.1
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-[#1F2937] bg-[#090C10]/95 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="rounded-md border border-[#1F2937] p-1.5 text-[#94A3B8] hover:text-[#F1F5F9] lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-xs text-[#94A3B8]">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Trading Card Data Product</span>
              <span className="hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="truncate font-medium text-[#F1F5F9]">
                {activeNavMeta.label}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {routingNotice && (
              <span className="hidden text-[11px] text-emerald-300 md:inline">
                {routingNotice}
              </span>
            )}
            <span className="rounded border border-emerald-500/40 bg-emerald-950/25 px-2.5 py-1 font-mono text-[10px] text-emerald-300">
              OpenAPI 3.1
            </span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
          {renderView()}
        </main>
      </div>

      {routingNotice && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 rounded-md border border-emerald-500/40 bg-[#11161D] px-4 py-2.5 text-xs font-medium text-emerald-300 shadow-lg md:hidden"
        >
          {routingNotice}
        </div>
      )}
    </div>
  );
}
