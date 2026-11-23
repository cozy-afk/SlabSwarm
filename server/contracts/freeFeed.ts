/** Frozen contract for free catalog feed adapters. Controller-owned so the
 * adapter, operator route and identity lanes can work from identical names.
 * No canonical facts live here. */

import type { MarketBasis } from './dataProduct.ts';

export type FeedVertical = 'TRADING_CARD_GAME' | 'SPORTS_CARD' | 'COMIC_BOOK';

export interface FreeFeedRecord {
  sourceId: string;
  externalId: string;
  vertical: FeedVertical;
  property: string | 'UNKNOWN';
  set: string | 'UNKNOWN';
  name: string;
  number: string | 'UNKNOWN';
  finish: string | 'UNKNOWN';
  currency: string | 'UNKNOWN';
  amount: number | 'UNKNOWN';
  basis: MarketBasis;
  observedAt: string;
  sourceUrl: string;
  license: string;
  attribution: string;
}

export interface FreeFeedConfig {
  sourceId: string;
  vertical: FeedVertical;
  baseUrl: string;
  rateLimitMs: number;
  license: string;
  attributionRequired: boolean;
  /** Name of a server-side env var holding an optional key; never the value. */
  apiKeyEnv?: string;
}
