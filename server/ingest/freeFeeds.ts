// Registry of free, publicly documented catalog feeds. Controller-owned
// contract names only: this module holds no key material and makes no calls.
// A config without a license is disabled by the adapter.

import type { FreeFeedConfig } from '../contracts/freeFeed.ts';

export const FREE_FEEDS: FreeFeedConfig[] = [
  {
    sourceId: 'scryfall',
    vertical: 'TRADING_CARD_GAME',
    baseUrl: 'https://api.scryfall.com',
    rateLimitMs: 100,
    license: 'SCRYFALL_API_TERMS',
    attributionRequired: false,
  },
  {
    sourceId: 'pokemontcg',
    vertical: 'TRADING_CARD_GAME',
    baseUrl: 'https://api.pokemontcg.io',
    rateLimitMs: 100,
    license: 'POKEMON_TCG_API_TERMS',
    attributionRequired: false,
  },
  {
    sourceId: 'carddex',
    vertical: 'TRADING_CARD_GAME',
    baseUrl: 'https://api.carddex.io',
    rateLimitMs: 250,
    license: 'CARDEX_API_TERMS_ATTRIBUTION_REQUIRED',
    attributionRequired: true,
    // The NAME of a server-side env var, never the key itself.
    apiKeyEnv: 'CARDEX_API_KEY',
  },
  {
    sourceId: 'cardex',
    vertical: 'SPORTS_CARD',
    baseUrl: 'https://www.cardex.com',
    rateLimitMs: 1000,
    license: 'CARDEX_PUBLIC_CATALOG_TERMS',
    attributionRequired: false,
  },
];

export function getFreeFeed(sourceId: string): FreeFeedConfig | undefined {
  return FREE_FEEDS.find((config) => config.sourceId === sourceId);
}
