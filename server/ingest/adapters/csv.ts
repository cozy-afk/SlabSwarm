// CSV adapter. Parsing and column mapping are deterministic and never infer
// a value: invalid prices/bases/currencies become null/UNKNOWN and are
// reported as row errors. This module writes nothing itself — the runner owns
// the evidence ledger.

import { computeChecksum } from '../evidence.ts';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  RawItem,
} from '../types.ts';

const VALID_BASES = new Set([
  'SOLD',
  'ASKING',
  'OFFER',
  'GUIDE',
  'CLAIM',
  'POPULATION',
  'UNKNOWN',
]);

export interface CsvRowError {
  row: number;
  message: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: Array<{ row: number; cells: string[] }>;
  errors: CsvRowError[];
}

/** Small RFC4180-style parser: quoted commas, doubled quotes and CRLF. */
export function parseCsv(csv: string): ParsedCsv {
  const text = typeof csv === 'string' ? csv : '';
  const allRows: Array<{ row: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let row = 1;
  let sawAny = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) {
      allRows.push({ row, cells });
    }
    cells = [];
    row += 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else {
      cell += ch;
    }
  }
  if (sawAny && (cell !== '' || cells.length > 0)) endRow();

  const headers = allRows.length ? [...allRows[0].cells] : [];
  const rows = allRows.slice(1);
  const errors: CsvRowError[] = [];
  for (const parsed of rows) {
    if (parsed.cells.length !== headers.length) {
      errors.push({
        row: parsed.row,
        message: `row ${parsed.row}: expected ${headers.length} columns/fields, got ${parsed.cells.length}`,
      });
    }
  }
  return { headers, rows, errors };
}

export interface CsvPreviewRow {
  // Index signature keeps preview rows usable as generic record maps.
  [key: string]: unknown;
  row: number;
  title: string | null;
  price: number | null;
  date: string | null;
  basis: string;
  currency: string;
  marketplace: string | null;
  url: string | null;
  grade: string | null;
  condition: string | null;
}

function finitePositive(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,\s]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

/** Map one structurally complete row to canonical, UNKNOWN-safe fields. */
export function mapCsvRow(row: { row: number; cells: string[] }, headers: string[]): CsvPreviewRow {
  const record: Record<string, string> = {};
  headers.forEach((header, index) => {
    record[header] = row.cells[index] ?? '';
  });
  const rawBasis = record.basis;
  const rawCurrency = record.currency;
  return {
    row: row.row,
    title: nonEmpty(record.title),
    price: finitePositive(record.price),
    date: nonEmpty(record.date) ?? nonEmpty(record.observedAt),
    basis: rawBasis && VALID_BASES.has(rawBasis) ? rawBasis : 'UNKNOWN',
    currency: rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'UNKNOWN',
    marketplace: nonEmpty(record.marketplace),
    url: validUrl(record.url ?? record.sourceUrl),
    grade: nonEmpty(record.grade),
    condition: nonEmpty(record.condition),
  };
}

export interface CsvPreview {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: CsvPreviewRow[];
  errors: CsvRowError[];
}

/** Preview never writes to the ledger. */
export function previewCsv(csv: string): CsvPreview {
  const parsed = parseCsv(csv);
  const errorsByRow = new Set(parsed.errors.map((e) => e.row));
  const rows = parsed.rows
    .filter((row) => !errorsByRow.has(row.row))
    .map((row) => mapCsvRow(row, parsed.headers));
  return {
    totalRows: parsed.rows.length,
    validRows: rows.length,
    invalidRows: parsed.errors.length,
    rows,
    errors: parsed.errors,
  };
}

export function createCsvAdapter(): IngestAdapter {
  return {
    id: 'csv',
    sourceId: 'csv',
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      const csv = ctx.options.csv;
      if (typeof csv !== 'string') {
        throw new Error('csv option is required for the csv adapter');
      }
      const parsed = parseCsv(csv);
      const errorsByRow = new Set(parsed.errors.map((e) => e.row));
      const items: RawItem[] = [];
      for (const sourceRow of parsed.rows) {
        if (errorsByRow.has(sourceRow.row)) continue;
        const mapped = mapCsvRow(sourceRow, parsed.headers);
        const payload: Record<string, unknown> = {
          source: 'csv',
          title: mapped.title,
          price: mapped.price,
          basis: mapped.basis,
          currency: mapped.currency,
          marketplace: mapped.marketplace,
          grade: mapped.grade,
          condition: mapped.condition,
          observedAt: mapped.date ?? ctx.capturedAt,
        };
        items.push({
          nativeId: `row:${sourceRow.row}`,
          observedAt: mapped.date ?? ctx.capturedAt,
          payload,
          sourceUri: mapped.url,
          checksum: computeChecksum(payload),
          mimeType: 'text/csv',
        });
      }
      return {
        items,
        meta: {
          totalRows: parsed.rows.length,
          validRows: items.length,
          invalidRows: parsed.errors.length,
          parseErrors: parsed.errors.map((error) => ({
            nativeId: `row:${error.row}`,
            message: error.message,
          })),
        },
      };
    },
  };
}
