# Data coverage — 2026-11-23

Read-only census of the durable ingest ledger. No evidence, candidate or
observation is mutated by this report. UNKNOWN stays UNKNOWN; a missing
amount is catalog-only, never zero. Raw parse status is reported as stored,
independent of promotion.

## Ledger totals

| Table | Rows |
| --- | ---: |
| Evidence | 147 |
| Candidates | 147 |
| Market observations | 58 |
| Ingest runs | 9 |

## Coverage

| Metric | Count |
| --- | ---: |
| Priced candidates | 58 |
| Catalog-only candidates | 89 |
| Promoted observations | 58 |
| Priced candidates without observation | 0 |
| Duplicate observation keys | 0 |

## Candidates by source

| Source | Candidates |
| --- | ---: |
| legacy-graph | 40 |
| tcgapis | 107 |

## Candidates by basis

| Basis | Candidates |
| --- | ---: |
| GUIDE | 51 |
| SOLD | 7 |
| UNKNOWN | 89 |

## Evidence by raw parse status

| Parse status | Rows |
| --- | ---: |
| PENDING | 147 |

## Evidence by trust tier

| Trust tier | Rows |
| --- | ---: |
| UNKNOWN | 147 |

## Machine-readable snapshot

```json
{
  "tables": {
    "evidence": 147,
    "candidates": 147,
    "observations": 58,
    "runs": 9
  },
  "bySource": {
    "legacy-graph": 40,
    "tcgapis": 107
  },
  "byBasis": {
    "GUIDE": 51,
    "SOLD": 7,
    "UNKNOWN": 89
  },
  "byParseStatus": {
    "PENDING": 147
  },
  "byTrustTier": {
    "UNKNOWN": 147
  },
  "pricedCandidates": 58,
  "catalogOnly": 89,
  "promotedObservations": 58,
  "pricedWithoutObservation": 0,
  "duplicateObservationKeys": 0
}
```
