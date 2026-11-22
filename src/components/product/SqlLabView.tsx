import { useState, type FormEvent } from 'react';

import type { SavedQuery, SqlQueryResult } from '../../types/dataProduct.ts';
import {
  ROUTES,
  postEnvelope,
  useEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  ProductPanel,
} from './ProductPanel.tsx';

const DEFAULT_SQL =
  "SELECT target_id, basis, currency, count(*) AS observations\nFROM market_observations\nGROUP BY target_id, basis, currency\nORDER BY observations DESC\nLIMIT 50;";

/**
 * SQL Lab — read-only DuckDB analysis over the Parquet lake of first-party
 * trading-card evidence. Nothing here mutates canonical facts.
 */
export function SqlLabView() {
  const saved = useEnvelope<SavedQuery[]>(ROUTES.sqlSaved);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');

  async function handleRun(event: FormEvent) {
    event.preventDefault();
    if (!sql.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const envelope = await postEnvelope<SqlQueryResult>(ROUTES.sqlQuery, {
        sql,
        readOnly: true,
      });
      setResult(envelope.data);
    } catch (err) {
      setResult(null);
      setNotice(err instanceof Error ? err.message : 'Query failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!saveName.trim()) return;
    setNotice(null);
    try {
      await postEnvelope(ROUTES.sqlSaved, { name: saveName.trim(), sql });
      setSaveName('');
      saved.reload();
      setNotice('Query saved for this workspace.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed.');
    }
  }

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Analytics"
        title="SQL Lab"
        description="Query the Parquet lake with DuckDB over first-party trading-card evidence, observations and scored forecasts. The lab is read-only: deterministic analysis never writes canonical facts."
        endpoints={[ROUTES.sqlQuery, ROUTES.sqlSaved]}
      >
        <InlineNotice>
          Interpret results with explicit basis. A NULL amount means UNKNOWN —
          never zero. Shipping, fees, FX, grade and condition that were not
          observed remain NULL in the lake.
        </InlineNotice>
        <form onSubmit={handleRun} className="space-y-3">
          <textarea
            aria-label="Read-only SQL query"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={7}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 font-mono text-[11px] text-[#E2E8F0]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || !sql.trim()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Running…' : 'Run Query'}
            </button>
            <div className="flex gap-2">
              <input
                aria-label="Saved query name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Save as…"
                className="rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!saveName.trim()}
                className="rounded-md border border-[#243040] px-3 py-2 text-xs text-[#CBD5E1] disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
          {notice && <p className="text-[11px] text-[#94A3B8]">{notice}</p>}
        </form>

        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">Results</h3>
          {!result ? (
            <EmptyState message="Run a read-only query to inspect the trading-card evidence lake." />
          ) : result.columns.length === 0 ? (
            <EmptyState message="Query returned no columns." />
          ) : (
            <div className="overflow-x-auto rounded border border-[#1F2937]">
              <table className="w-full text-left font-mono text-[11px]">
                <thead className="bg-[#161D27] text-[#94A3B8]">
                  <tr>
                    {result.columns.map((column) => (
                      <th key={column} className="px-3 py-2 font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1F2937]">
                  {result.rows.map((row, index) => (
                    <tr key={index} className="text-[#CBD5E1]">
                      {result.columns.map((column) => (
                        <td key={column} className="px-3 py-2">
                          {row[column] === null || row[column] === undefined
                            ? 'UNKNOWN'
                            : String(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-[#1F2937] px-3 py-2 font-mono text-[10px] text-[#64748B]">
                rows={result.rowCount} · truncated={result.truncated}
              </p>
            </div>
          )}
        </div>
      </ProductPanel>

      <ProductPanel
        eyebrow="Saved queries"
        title="Saved Analysis"
        description="Reusable read-only analyses over the trading-card data product."
        endpoints={[ROUTES.sqlSaved]}
      >
        {saved.loading ? (
          <LoadingState />
        ) : saved.error ? (
          <ErrorState message={saved.error} onRetry={saved.reload} />
        ) : (saved.data ?? []).length === 0 ? (
          <EmptyState message="No saved queries yet." />
        ) : (
          <ul className="space-y-2">
            {(saved.data ?? []).map((query) => (
              <li
                key={query.id}
                className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
              >
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setSql(query.sql)}
                    className="text-xs text-[#E2E8F0] hover:text-emerald-300"
                  >
                    {query.name}
                  </button>
                  <span className="font-mono text-[10px] text-[#64748B]">
                    {query.createdAt}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ProductPanel>
    </div>
  );
}
