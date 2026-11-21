import { useEffect, useState } from 'react';
import { Check, Copy, Server, ShieldCheck } from 'lucide-react';
import type { LLMProviderInfo } from '../types/graph.ts';

interface SchemaBlueprintViewProps {
  providers: LLMProviderInfo[];
}

export function SchemaBlueprintView({ providers }: SchemaBlueprintViewProps) {
  const [cypherSchema, setCypherSchema] = useState('');
  const [swarmAdapterCode, setSwarmAdapterCode] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/blueprint')
      .then((r) => r.json())
      .then((data) => {
        setCypherSchema(data.cypherSchema || '');
        setSwarmAdapterCode(data.swarmAdapterCode || '');
      })
      .catch(() => {});
  }, []);

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Fallback ignored gracefully
    }
  }

  return (
    <div className="space-y-6">
      {/* Architecture Pitfall Safeguards */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-5">
        <h2 className="text-sm font-semibold text-[#F1F5F9]">
          Architectural Safeguards & Pitfall Prevention
        </h2>
        <p className="mt-0.5 text-xs text-[#94A3B8]">
          Core engineering invariants enforced across every layer of this collectibles GraphRAG & Swarm terminal.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
              <ShieldCheck className="h-4 w-4" />
              <span>Zero LLM Math</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#CBD5E1]">
              All moving averages, medians, grade multipliers, population rates, and fee-adjusted arbitrage spreads execute deterministically in the graph engine. The LLM only synthesizes narrative over verified numbers.
            </p>
          </div>

          <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <ShieldCheck className="h-4 w-4" />
              <span>Canonical Primary Keys</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#CBD5E1]">
              Universal ID scheme (<span className="font-mono text-[#F1F5F9]">SEGMENT-FRANCHISE-SET-NUM</span>) spans any TCG or sports release, blocking duplicate node bloat from seller title typos.
            </p>
          </div>

          <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-400">
              <Server className="h-4 w-4" />
              <span>Deterministic Pre-Parsing</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#CBD5E1]">
              Lightweight regex extraction parses price, grade hints, and reprint/damage signals before invoking your chosen server-side LLM, preventing token burn on raw marketplace pages.
            </p>
          </div>
        </div>
      </section>

      {/* Server-Side LLM Provider Environment Matrix */}
      <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="border-b border-[#1F2937] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-[#F1F5F9]">
            Server-Side LLM Provider Compatibility
          </h3>
          <p className="mt-0.5 text-xs text-[#94A3B8]">
            Configure environment variables in your server deployment to activate additional LLM backends for the Multi-Agent Swarm.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[#1F2937] bg-[#0D1117] text-[#94A3B8]">
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium">Default Model</th>
                <th className="px-4 py-3 font-medium">Server Env Variables</th>
                <th className="px-4 py-3 font-medium">Server Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1F2937]">
              {providers.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3 font-medium text-[#F1F5F9]">{p.label}</td>
                  <td className="px-4 py-3 font-mono text-[#CBD5E1]">{p.defaultModel}</td>
                  <td className="px-4 py-3 font-mono text-[#94A3B8]">{p.envHint}</td>
                  <td className="px-4 py-3 font-mono">
                    {p.configured ? (
                      <span className="text-emerald-400">Active on Server</span>
                    ) : (
                      <span className="text-[#64748B]">Standby (Env Unset)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Cypher Ontology DDL & Swarm Adapter Code */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
          <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
            <div>
              <h3 className="text-sm font-semibold text-[#F1F5F9]">
                Neo4j Cypher Ontology Schema
              </h3>
              <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                Universal TCG & Sports Collectibles node constraints and deterministic arbitrage query.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleCopy('cypher', cypherSchema)}
              className="inline-flex items-center gap-1.5 rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs text-[#E2E8F0] hover:border-emerald-500/50"
            >
              {copiedKey === 'cypher' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy Cypher</span>
                </>
              )}
            </button>
          </div>
          <pre className="max-h-[420px] overflow-auto bg-[#090C10] p-4 font-mono text-[11px] leading-relaxed text-emerald-300/90">
            {cypherSchema || 'Loading Cypher DDL...'}
          </pre>
        </section>

        <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
          <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
            <div>
              <h3 className="text-sm font-semibold text-[#F1F5F9]">
                Pluggable Server Swarm Adapter Blueprint
              </h3>
              <p className="mt-0.5 text-[11px] text-[#94A3B8]">
                Vendor-agnostic multi-agent handoff routine with deterministic pre-parsing.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleCopy('adapter', swarmAdapterCode)}
              className="inline-flex items-center gap-1.5 rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs text-[#E2E8F0] hover:border-emerald-500/50"
            >
              {copiedKey === 'adapter' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy TypeScript</span>
                </>
              )}
            </button>
          </div>
          <pre className="max-h-[420px] overflow-auto bg-[#090C10] p-4 font-mono text-[11px] leading-relaxed text-[#CBD5E1]">
            {swarmAdapterCode || 'Loading adapter blueprint...'}
          </pre>
        </section>
      </div>
    </div>
  );
}
