import { randomUUID } from 'node:crypto';
import type {
  AlertDeliveryReceipt,
  AlertRule,
  ArbitrageOpportunity,
  AssetNode,
  AssetValuation,
  CommunitySummary,
  CypherQueryPlan,
  CypherSubgraphEdge,
  GradeLabel,
  GraphStatePayload,
  HistoryPoint,
  ListingSaleNode,
  MarketEventNode,
  MarketplaceId,
  MarketplaceNode,
  MarketSegment,
  PortfolioHolding,
  PortfolioHoldingValuation,
  PortfolioSummary,
  QueuedRawListing,
  SetReleaseNode,
  SubjectNode,
  SwarmRunRecord,
  TriggeredAlert,
  ResearchSourceNode,
  MarketBasis,
} from '../src/types/graph.ts';
import { getAlertChannelStatus } from './alertDispatcher.ts';
import {
  createEmptyDatabase,
  getStorageStatus,
  loadPersistedDatabase,
  savePersistedDatabase,
  type PersistedGraphDatabase,
  type StoredEmbeddingRecord,
} from './storage.ts';
import { computeVectorIndexStatus } from './vectorIndex.ts';

// Canonical marketplace venues (reference fee schedules — zero mock sales/assets)
const MARKETPLACES: MarketplaceNode[] = [
  {
    id: 'ebay_sold',
    name: 'eBay Sold',
    region: 'Global',
    sellerFeePct: 13.25,
    settlementType: 'Auction',
  },
  {
    id: 'tcgplayer',
    name: 'TCGplayer',
    region: 'North America',
    sellerFeePct: 10.75,
    settlementType: 'Orderbook',
  },
  {
    id: 'cardmarket',
    name: 'Cardmarket',
    region: 'Europe',
    sellerFeePct: 5.0,
    settlementType: 'Orderbook',
  },
  {
    id: 'pwcc',
    name: 'PWCC Vault',
    region: 'Global',
    sellerFeePct: 8.5,
    settlementType: 'Auction',
  },
  {
    id: 'goldin',
    name: 'Goldin',
    region: 'Global',
    sellerFeePct: 10.0,
    settlementType: 'Auction',
  },
  {
    id: 'fanatics',
    name: 'Fanatics Collect',
    region: 'North America',
    sellerFeePct: 9.0,
    settlementType: 'Buy-It-Now',
  },
];

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PreParseResult {
  extractedPriceUsd: number;
  detectedGradeHint: GradeLabel | null;
  editionFlags: string[];
  conditionRiskKeywords: string[];
  shillRiskKeywords: string[];
  tokenSavingsEstimatePct: number;
}

export class KnowledgeGraphEngine {
  private readonly marketplaces: MarketplaceNode[] = [...MARKETPLACES];
  private db: PersistedGraphDatabase;

  constructor() {
    this.db = loadPersistedDatabase();
  }

  private persist(): void {
    savePersistedDatabase(this.db);
  }

  public getAdminPasscodeHash(): string | null {
    return this.db.adminPasscodeHash;
  }

  public setAdminPasscodeHash(hash: string): void {
    this.db.adminPasscodeHash = hash;
    this.persist();
  }

  public setOnboardingCompleted(done: boolean): void {
    this.db.onboardingCompleted = done;
    this.persist();
  }

  public getEmbeddingsStore(): Record<string, StoredEmbeddingRecord> {
    return this.db.embeddings;
  }

  public persistEmbeddings(): void {
    this.persist();
  }

  public getAssets(): AssetNode[] {
    return this.db.assets;
  }

  public getEvents(): MarketEventNode[] {
    return this.db.events;
  }

  public getQueuedItem(id: string): QueuedRawListing | undefined {
    return this.db.queuedFeed.find((q) => q.id === id);
  }

  public enqueueRawItem(item: Omit<QueuedRawListing, 'id'>): QueuedRawListing {
    const record: QueuedRawListing = {
      ...item,
      id: `Q-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    };
    this.db.queuedFeed.unshift(record);
    this.persist();
    return record;
  }

  public removeQueuedItem(id: string): void {
    this.db.queuedFeed = this.db.queuedFeed.filter((q) => q.id !== id);
    this.persist();
  }

  public deterministicPreParse(
    rawTitle: string,
    priceUsd: number,
    notes = ''
  ): PreParseResult {
    const combined = `${rawTitle} ${notes}`.toLowerCase();

    let detectedGradeHint: GradeLabel | null = null;
    if (/psa\s*10|gem\s*mint\s*10/i.test(combined)) detectedGradeHint = 'PSA 10';
    else if (/bgs\s*9\.5|beckett\s*9\.5/i.test(combined))
      detectedGradeHint = 'BGS 9.5';
    else if (/sgc\s*10/i.test(combined)) detectedGradeHint = 'SGC 10';
    else if (/psa\s*9|mint\s*9/i.test(combined)) detectedGradeHint = 'PSA 9';
    else if (/raw|ungraded|nm\b|near\s*mint/i.test(combined))
      detectedGradeHint = 'Raw NM';

    const editionFlags: string[] = [];
    for (const kw of [
      'reprint',
      '25th',
      'proxy',
      'celebrations',
      'world championship',
      'custom',
      'art card',
    ]) {
      if (combined.includes(kw)) editionFlags.push(kw);
    }

    const conditionRiskKeywords: string[] = [];
    for (const kw of [
      'crease',
      'damaged',
      'trimmed',
      'altered',
      'dent',
      'heavy play',
      'hp',
      'bent',
      'no returns',
    ]) {
      if (combined.includes(kw)) conditionRiskKeywords.push(kw);
    }

    const shillRiskKeywords: string[] = [];
    for (const kw of [
      '0 feedback',
      'relisted',
      'retracted',
      'pop 1???',
      '1/1??',
      'investment',
    ]) {
      if (combined.includes(kw)) shillRiskKeywords.push(kw);
    }

    return {
      extractedPriceUsd: Number(priceUsd) || 0,
      detectedGradeHint,
      editionFlags,
      conditionRiskKeywords,
      shillRiskKeywords,
      tokenSavingsEstimatePct: 86,
    };
  }

  public computeAssetValuation(assetId: string): AssetValuation {
    const asset = this.db.assets.find((a) => a.id === assetId);
    if (!asset) {
      throw new Error(`Unknown assetId: ${assetId}`);
    }

    const allSales = this.db.sales.filter((s) => s.assetId === assetId);
    const verified = allSales
      .filter((s) => s.status === 'VERIFIED')
      .sort((a, b) => a.date.localeCompare(b.date));
    const quarantined = allSales.filter((s) => s.status === 'QUARANTINED');

    const topGradeObj = asset.grades[0] || {
      grade: 'PSA 10' as GradeLabel,
      popCount: 0,
      gemRatePct: 0,
    };
    const topGradeLabel = topGradeObj.grade;

    const topSales = verified.filter((s) => s.grade === topGradeLabel);
    const midSales = verified.filter((s) => s.grade === 'PSA 9');
    const rawSales = verified.filter((s) => s.grade === 'Raw NM');

    const topPrices = topSales.map((s) => s.priceUsd);
    const midPrices = midSales.map((s) => s.priceUsd);
    const rawPrices = rawSales.map((s) => s.priceUsd);

    const topGradeAvg = round2(avg(topPrices));
    const topGradeMedian = round2(median(topPrices));
    const midGradeAvg = round2(avg(midPrices));
    const rawAvg = round2(avg(rawPrices));

    const gradeMultiplier =
      midGradeAvg > 0 && topGradeAvg > 0
        ? round2(topGradeAvg / midGradeAvg)
        : 0;

    // Deterministic moving averages strictly over actual verified sales
    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const withinDays = (days: number) =>
      topSales
        .filter((s) => {
          const ts = Date.parse(s.date);
          return !Number.isNaN(ts) && nowMs - ts <= days * dayMs;
        })
        .map((s) => s.priceUsd);

    const p7 = withinDays(7);
    const p30 = withinDays(30);
    const p90 = withinDays(90);

    const movingAvg7d = round2(
      avg(p7.length ? p7 : topSales.slice(-2).map((s) => s.priceUsd))
    );
    const movingAvg30d = round2(
      avg(p30.length ? p30 : topSales.slice(-5).map((s) => s.priceUsd))
    );
    const movingAvg90d = round2(avg(p90.length ? p90 : topPrices));

    // Deterministic change strictly from earliest to latest verified top-grade sale
    let change30dPct = 0;
    if (topSales.length >= 2) {
      const oldest = topSales[0].priceUsd;
      const newest = topSales[topSales.length - 1].priceUsd;
      change30dPct =
        oldest > 0 ? round2(((newest - oldest) / oldest) * 100) : 0;
    }

    const minTop = topPrices.length ? Math.min(...topPrices) : 0;
    const maxTop = topPrices.length ? Math.max(...topPrices) : 0;
    const bidAskSpreadPct =
      topGradeAvg > 0 ? round2(((maxTop - minTop) / topGradeAvg) * 100) : 0;

    // Build 100% genuine chronological history directly from verified ListingSale & MarketEvent nodes
    const linkedEvents = this.db.events.filter((e) =>
      e.impactedAssetIds.includes(assetId)
    );
    const eventByDate = new Map<string, string>();
    for (const ev of linkedEvents) {
      eventByDate.set(ev.date, ev.title);
    }

    const byDate = new Map<
      string,
      { top: number[]; mid: number[]; raw: number[] }
    >();
    for (const s of verified) {
      const bucket = byDate.get(s.date) || { top: [], mid: [], raw: [] };
      if (s.grade === topGradeLabel) bucket.top.push(s.priceUsd);
      else if (s.grade === 'PSA 9') bucket.mid.push(s.priceUsd);
      else if (s.grade === 'Raw NM') bucket.raw.push(s.priceUsd);
      else bucket.top.push(s.priceUsd);
      byDate.set(s.date, bucket);
    }

    const sortedDates = Array.from(byDate.keys()).sort((a, b) =>
      a.localeCompare(b)
    );

    let lastTop = 0;
    let lastMid = 0;
    let lastRaw = 0;
    const history: HistoryPoint[] = sortedDates.map((d) => {
      const b = byDate.get(d)!;
      if (b.top.length) lastTop = round2(avg(b.top));
      if (b.mid.length) lastMid = round2(avg(b.mid));
      if (b.raw.length) lastRaw = round2(avg(b.raw));
      const matchedEvent = eventByDate.get(d);
      return {
        date: d.length >= 10 ? d.slice(5) : d,
        psa10: lastTop,
        psa9: lastMid,
        raw: lastRaw,
        ...(matchedEvent ? { eventTitle: matchedEvent } : {}),
      };
    });

    const assetArbs = this.computeArbitrageOpportunities(true).filter(
      (a) => a.assetId === assetId
    );
    const bestArbSpreadPct = assetArbs.length ? assetArbs[0].netSpreadPct : 0;

    return {
      assetId,
      topGradeLabel,
      topGradeAvg,
      topGradeMedian,
      midGradeAvg,
      rawAvg,
      gradeMultiplier,
      movingAvg7d,
      movingAvg30d,
      movingAvg90d,
      bidAskSpreadPct,
      change30dPct,
      verifiedSaleCount: verified.length,
      quarantinedCount: quarantined.length,
      topGradePop: topGradeObj.popCount,
      gemRatePct: topGradeObj.gemRatePct,
      bestArbSpreadPct,
      history,
    };
  }

  public computeArbitrageOpportunities(
    includeSellerFees = true
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];
    const verified = this.db.sales.filter((s) => s.status === 'VERIFIED');

    for (const asset of this.db.assets) {
      const assetSales = verified.filter((s) => s.assetId === asset.id);
      const grades = Array.from(new Set(assetSales.map((s) => s.grade)));

      for (const grade of grades) {
        const gradeSales = assetSales.filter((s) => s.grade === grade);
        const byMarket = new Map<MarketplaceId, number[]>();

        for (const s of gradeSales) {
          const list = byMarket.get(s.marketplaceId) || [];
          list.push(s.priceUsd);
          byMarket.set(s.marketplaceId, list);
        }

        if (byMarket.size < 2) continue;

        const marketEntries = Array.from(byMarket.entries())
          .map(([mId, prices]) => {
            const mp = this.marketplaces.find((m) => m.id === mId);
            if (!mp) return null;
            return {
              marketplace: mp,
              avgPrice: round2(avg(prices)),
              count: prices.length,
            };
          })
          .filter((x): x is NonNullable<typeof x> => Boolean(x));

        if (marketEntries.length < 2) continue;

        marketEntries.sort((a, b) => a.avgPrice - b.avgPrice);
        const lowest = marketEntries[0];
        const highest = marketEntries[marketEntries.length - 1];

        const feePct = includeSellerFees ? highest.marketplace.sellerFeePct : 0;
        const netSellProceeds = round2(highest.avgPrice * (1 - feePct / 100));
        const netProfitUsd = round2(netSellProceeds - lowest.avgPrice);
        const netSpreadPct =
          lowest.avgPrice > 0
            ? round2((netProfitUsd / lowest.avgPrice) * 100)
            : 0;

        if (netSpreadPct > 1.5) {
          opportunities.push({
            id: `ARB-${asset.id}-${grade.replace(/\s+/g, '')}`,
            assetId: asset.id,
            assetTitle: asset.title,
            franchise: asset.franchise,
            segment: asset.segment,
            grade,
            buyMarketplaceId: lowest.marketplace.id,
            buyMarketplaceName: lowest.marketplace.name,
            buyAvgPrice: lowest.avgPrice,
            sellMarketplaceId: highest.marketplace.id,
            sellMarketplaceName: highest.marketplace.name,
            sellAvgPrice: highest.avgPrice,
            sellerFeePct: feePct,
            netSellProceeds,
            netProfitUsd,
            netSpreadPct,
            supportingSales: lowest.count + highest.count,
          });
        }
      }
    }

    return opportunities.sort((a, b) => b.netSpreadPct - a.netSpreadPct);
  }

  public computeCommunitySummaries(
    valuations: Record<string, AssetValuation>
  ): CommunitySummary[] {
    const definitions: Array<{
      id: string;
      title: string;
      segment: MarketSegment | 'CROSS_MARKET';
      eraLabel: string;
    }> = [
      {
        id: 'COM-VINTAGE-TCG',
        title: 'Vintage TCG Graded Blue Chips',
        segment: 'TCG',
        eraLabel: 'Pre-2005 Classic TCG Releases',
      },
      {
        id: 'COM-MODERN-CHASE',
        title: 'Modern Chase Parallels & Tournament Meta',
        segment: 'TCG',
        eraLabel: '2005+ Modern TCG & Competitive Sets',
      },
      {
        id: 'COM-SPORTS-BLUECHIP',
        title: 'Graded Sports Rookies & Numbered Chrome',
        segment: 'SPORTS',
        eraLabel: 'Multi-Sport Vintage & Modern Slabs',
      },
    ];

    return definitions.map((def) => {
      const members = this.db.assets.filter((a) => a.communityId === def.id);
      const memberIds = members.map((m) => m.id);
      const vals = memberIds.map((id) => valuations[id]).filter(Boolean);

      const memberSales = this.db.sales.filter(
        (s) => s.status === 'VERIFIED' && memberIds.includes(s.assetId)
      );
      const activeCatalysts = this.db.events.filter((e) =>
        e.impactedAssetIds.some((id) => memberIds.includes(id))
      ).length;

      const meta = this.db.customCommunityNarratives[def.id] || {
        narrative:
          members.length === 0
            ? 'No canonical collectibles assigned to this cluster yet. Add assets and verified comps, then refresh to synthesize.'
            : `${members.length} canonical asset(s) tracked with ${memberSales.length} verified comp(s). Click refresh to synthesize a GraphRAG cluster narrative with your active LLM.`,
        lastUpdated: new Date().toISOString(),
        providerUsed: 'Deterministic Graph Stats',
      };

      return {
        id: def.id,
        title: def.title,
        segment: def.segment,
        eraLabel: def.eraLabel,
        assetIds: memberIds,
        deterministicStats: {
          assetCount: members.length,
          avg30dChangePct: round2(avg(vals.map((v) => v.change30dPct))),
          avgGradeMultiplier: round2(
            avg(vals.map((v) => v.gradeMultiplier).filter((m) => m > 0))
          ),
          totalVerifiedVolumeUsd: Math.round(
            memberSales.reduce((acc, s) => acc + s.priceUsd, 0)
          ),
          activeCatalysts,
        },
        narrative: meta.narrative,
        lastUpdated: meta.lastUpdated,
        providerUsed: meta.providerUsed,
      };
    });
  }

  public updateCommunityNarrative(
    communityId: string,
    narrative: string,
    providerUsed: string
  ): void {
    this.db.customCommunityNarratives[communityId] = {
      narrative,
      lastUpdated: new Date().toISOString(),
      providerUsed,
    };
    this.persist();
  }

  public evaluateTriggeredAlerts(
    valuations: Record<string, AssetValuation>,
    arbitrage: ArbitrageOpportunity[]
  ): TriggeredAlert[] {
    const alerts: TriggeredAlert[] = [];
    const nowIso = new Date().toISOString();

    for (const rule of this.db.alertRules) {
      if (!rule.active) continue;

      if (rule.metric === 'ARB_SPREAD_PCT') {
        const matches = arbitrage.filter(
          (a) =>
            a.netSpreadPct >= rule.threshold &&
            (rule.scopeSegment === 'ALL' || a.segment === rule.scopeSegment)
        );
        for (const m of matches.slice(0, 6)) {
          alerts.push({
            id: `ALT-${rule.id}-${m.id}`,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: m.netSpreadPct >= 15 ? 'CRITICAL' : 'HIGH',
            channel: rule.channel,
            assetId: m.assetId,
            assetTitle: m.assetTitle,
            headline: `+${m.netSpreadPct.toFixed(1)}% net spread on ${m.assetTitle} (${m.grade})`,
            deterministicDetail: `Buy ${m.buyMarketplaceName} ($${m.buyAvgPrice.toLocaleString()}) -> Sell ${m.sellMarketplaceName} ($${m.sellAvgPrice.toLocaleString()} gross / $${m.netSellProceeds.toLocaleString()} net after ${m.sellerFeePct}% fee) = +$${m.netProfitUsd.toLocaleString()} edge.`,
            timestamp: nowIso,
            webhookPayload: {
              channel: rule.channel,
              event: 'ARBITRAGE_EDGE_DETECTED',
              canonicalId: m.assetId,
              grade: m.grade,
              buyVenue: m.buyMarketplaceName,
              sellVenue: m.sellMarketplaceName,
              netSpreadPct: m.netSpreadPct,
              netProfitUsd: m.netProfitUsd,
            },
          });
        }
      }

      if (rule.metric === 'PRICE_SWING_30D') {
        for (const asset of this.db.assets) {
          if (rule.scopeSegment !== 'ALL' && asset.segment !== rule.scopeSegment)
            continue;
          const v = valuations[asset.id];
          if (v && v.verifiedSaleCount >= 2 && Math.abs(v.change30dPct) >= rule.threshold) {
            alerts.push({
              id: `ALT-${rule.id}-${asset.id}`,
              ruleId: rule.id,
              ruleName: rule.name,
              severity: Math.abs(v.change30dPct) >= 18 ? 'HIGH' : 'MEDIUM',
              channel: rule.channel,
              assetId: asset.id,
              assetTitle: asset.title,
              headline: `${v.change30dPct > 0 ? '+' : ''}${v.change30dPct.toFixed(1)}% move on ${asset.title}`,
              deterministicDetail: `${v.topGradeLabel} average reached $${v.topGradeAvg.toLocaleString()} (${v.gradeMultiplier}x over PSA 9, Pop ${v.topGradePop.toLocaleString()}).`,
              timestamp: nowIso,
              webhookPayload: {
                channel: rule.channel,
                event: 'PRICE_BREAKOUT_TRIGGER',
                canonicalId: asset.id,
                change30dPct: v.change30dPct,
                topGradeAvgUsd: v.topGradeAvg,
                gradeMultiplier: v.gradeMultiplier,
              },
            });
          }
        }
      }

      if (rule.metric === 'OUTLIER_DETECTED') {
        const quarantined = this.db.sales.filter((s) => s.status === 'QUARANTINED');
        for (const q of quarantined.slice(0, 6)) {
          const asset = this.db.assets.find((a) => a.id === q.assetId);
          if (
            asset &&
            rule.scopeSegment !== 'ALL' &&
            asset.segment !== rule.scopeSegment
          ) {
            continue;
          }
          alerts.push({
            id: `ALT-${rule.id}-${q.id}`,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: 'CRITICAL',
            channel: rule.channel,
            assetId: q.assetId,
            assetTitle: asset?.title || q.assetId,
            headline: `Quarantined outlier on ${asset?.title || q.assetId} ($${q.priceUsd.toLocaleString()})`,
            deterministicDetail:
              q.outlierReason ||
              'Anomalous listing quarantined prior to valuation write.',
            timestamp: `${q.date}T00:00:00Z`,
            webhookPayload: {
              channel: rule.channel,
              event: 'FRAUD_OUTLIER_QUARANTINED',
              saleId: q.id,
              canonicalId: q.assetId,
              flaggedPriceUsd: q.priceUsd,
              reason: q.outlierReason,
            },
          });
        }
      }

      if (rule.metric === 'CATALYST_IMPACT') {
        for (const ev of this.db.events) {
          if (Math.abs(ev.priceDeltaPct) >= rule.threshold) {
            alerts.push({
              id: `ALT-${rule.id}-${ev.id}`,
              ruleId: rule.id,
              ruleName: rule.name,
              severity: Math.abs(ev.priceDeltaPct) >= 14 ? 'HIGH' : 'MEDIUM',
              channel: rule.channel,
              assetId: ev.impactedAssetIds[0],
              assetTitle: this.db.assets.find(
                (a) => a.id === ev.impactedAssetIds[0]
              )?.title,
              headline: `Catalyst (${ev.priceDeltaPct > 0 ? '+' : ''}${ev.priceDeltaPct}%): ${ev.title}`,
              deterministicDetail: ev.summary,
              timestamp: `${ev.date}T00:00:00Z`,
              webhookPayload: {
                channel: rule.channel,
                event: 'MARKET_CATALYST_NODE_INJECTED',
                eventId: ev.id,
                category: ev.category,
                impactedAssets: ev.impactedAssetIds,
                priceDeltaPct: ev.priceDeltaPct,
              },
            });
          }
        }
      }
    }

    return alerts;
  }

  public computePortfolioSummary(
    valuations: Record<string, AssetValuation>
  ): PortfolioSummary {
    const assetMap = new Map(this.db.assets.map((a) => [a.id, a]));
    const verifiedSales = this.db.sales.filter((s) => s.status === 'VERIFIED');

    const holdings: PortfolioHoldingValuation[] = this.db.portfolioHoldings
      .map((h) => {
        const asset = assetMap.get(h.assetId);
        if (!asset) return null;

        const gradeSales = verifiedSales.filter(
          (s) => s.assetId === h.assetId && s.grade === h.grade
        );
        let unitMarketValueUsd = 0;
        let pricingSource: 'VERIFIED_GRADE_COMP' | 'NO_VERIFIED_COMPS' =
          'NO_VERIFIED_COMPS';

        if (gradeSales.length > 0) {
          unitMarketValueUsd = round2(avg(gradeSales.map((s) => s.priceUsd)));
          pricingSource = 'VERIFIED_GRADE_COMP';
        } else {
          const v = valuations[h.assetId];
          if (v) {
            if (h.grade === v.topGradeLabel && v.topGradeAvg > 0) {
              unitMarketValueUsd = v.topGradeAvg;
              pricingSource = 'VERIFIED_GRADE_COMP';
            } else if (h.grade === 'PSA 9' && v.midGradeAvg > 0) {
              unitMarketValueUsd = v.midGradeAvg;
              pricingSource = 'VERIFIED_GRADE_COMP';
            } else if (h.grade === 'Raw NM' && v.rawAvg > 0) {
              unitMarketValueUsd = v.rawAvg;
              pricingSource = 'VERIFIED_GRADE_COMP';
            }
          }
        }

        const totalCostBasisUsd = round2(h.costBasisUsd * h.quantity);
        const totalMarketValueUsd = round2(unitMarketValueUsd * h.quantity);
        const unrealizedPnlUsd =
          pricingSource === 'VERIFIED_GRADE_COMP'
            ? round2(totalMarketValueUsd - totalCostBasisUsd)
            : 0;
        const unrealizedPnlPct =
          pricingSource === 'VERIFIED_GRADE_COMP' && totalCostBasisUsd > 0
            ? round2((unrealizedPnlUsd / totalCostBasisUsd) * 100)
            : 0;

        return {
          ...h,
          assetTitle: asset.title,
          franchise: asset.franchise,
          segment: asset.segment,
          unitMarketValueUsd,
          totalCostBasisUsd,
          totalMarketValueUsd,
          unrealizedPnlUsd,
          unrealizedPnlPct,
          pricingSource,
        };
      })
      .filter((x): x is PortfolioHoldingValuation => Boolean(x));

    const totalUnits = holdings.reduce((acc, h) => acc + h.quantity, 0);
    const totalCostBasisUsd = round2(
      holdings.reduce((acc, h) => acc + h.totalCostBasisUsd, 0)
    );
    const totalMarketValueUsd = round2(
      holdings.reduce((acc, h) => acc + h.totalMarketValueUsd, 0)
    );
    const pricedHoldings = holdings.filter(
      (h) => h.pricingSource === 'VERIFIED_GRADE_COMP'
    );
    const pricedCost = pricedHoldings.reduce(
      (acc, h) => acc + h.totalCostBasisUsd,
      0
    );
    const pricedVal = pricedHoldings.reduce(
      (acc, h) => acc + h.totalMarketValueUsd,
      0
    );
    const totalUnrealizedPnlUsd = round2(pricedVal - pricedCost);
    const totalUnrealizedPnlPct =
      pricedCost > 0 ? round2((totalUnrealizedPnlUsd / pricedCost) * 100) : 0;

    return {
      holdings,
      totalHoldingsCount: holdings.length,
      totalUnits,
      totalCostBasisUsd,
      totalMarketValueUsd,
      totalUnrealizedPnlUsd,
      totalUnrealizedPnlPct,
    };
  }

  public addPortfolioHolding(
    input: Omit<PortfolioHolding, 'id'>
  ): PortfolioHolding {
    const asset = this.db.assets.find((a) => a.id === input.assetId);
    if (!asset) {
      throw new Error('Selected canonical asset does not exist in the graph.');
    }
    const holding: PortfolioHolding = {
      ...input,
      id: `HLD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    };
    this.db.portfolioHoldings.unshift(holding);
    this.persist();
    return holding;
  }

  public deletePortfolioHolding(id: string): boolean {
    const before = this.db.portfolioHoldings.length;
    this.db.portfolioHoldings = this.db.portfolioHoldings.filter(
      (h) => h.id !== id
    );
    const changed = this.db.portfolioHoldings.length < before;
    if (changed) this.persist();
    return changed;
  }

  public commitSale(sale: Omit<ListingSaleNode, 'id'>): ListingSaleNode {
    const record: ListingSaleNode = {
      ...sale,
      id: `SL-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    };
    this.db.sales.unshift(record);
    this.persist();
    return record;
  }

  public injectMarketEvent(
    event: Omit<MarketEventNode, 'id'>
  ): MarketEventNode {
    const record: MarketEventNode = {
      ...event,
      id: `EVT-${Date.now()}`,
    };
    this.db.events.unshift(record);
    this.persist();
    return record;
  }

  public addSwarmRun(run: SwarmRunRecord): void {
    this.db.swarmRuns.unshift(run);
    if (this.db.swarmRuns.length > 60) {
      this.db.swarmRuns = this.db.swarmRuns.slice(0, 60);
    }
    this.persist();
  }

  public addAlertRule(rule: Omit<AlertRule, 'id'>): AlertRule {
    const record: AlertRule = {
      ...rule,
      id: `RULE-${Date.now()}`,
    };
    this.db.alertRules.unshift(record);
    this.persist();
    return record;
  }

  public toggleAlertRule(id: string): AlertRule | null {
    const found = this.db.alertRules.find((r) => r.id === id);
    if (!found) return null;
    found.active = !found.active;
    this.persist();
    return found;
  }

  public deleteAlertRule(id: string): boolean {
    const before = this.db.alertRules.length;
    this.db.alertRules = this.db.alertRules.filter((r) => r.id !== id);
    const changed = this.db.alertRules.length < before;
    if (changed) this.persist();
    return changed;
  }

  public recordAlertDelivery(receipt: AlertDeliveryReceipt): void {
    this.db.alertDeliveries.unshift(receipt);
    if (this.db.alertDeliveries.length > 40) {
      this.db.alertDeliveries = this.db.alertDeliveries.slice(0, 40);
    }
    this.persist();
  }

  public registerCanonicalAsset(input: {
    title: string;
    segment: MarketSegment;
    franchise: string;
    setName: string;
    releaseYear: number;
    cardNumber: string;
    variant: string;
    subjectName: string;
    topGradeLabel?: GradeLabel;
    topGradePop?: number;
    gemRatePct?: number;
    initialSalePriceUsd?: number;
    initialSaleGrade?: GradeLabel;
    initialSaleMarketplaceId?: MarketplaceId;
    initialSaleDate?: string;
  }): AssetNode {
    // The millisecond suffix alone collided when bulk-importing several cards
    // inside one second. Add a UUID slice so every canonical node has a unique id.
    const slug = `${input.segment}-${input.franchise.slice(0, 3).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}-${Date.now().toString().slice(-4)}-${randomUUID().slice(0, 8)}`;
    const setId = `SET-${slug}`;
    const subjectId = `SUB-${slug}`;

    this.db.sets.push({
      id: setId,
      name: input.setName,
      franchise: input.franchise,
      segment: input.segment,
      releaseYear: input.releaseYear,
      eraCluster:
        input.segment === 'SPORTS'
          ? 'Graded Sports Collectibles'
          : input.releaseYear < 2005
            ? 'Vintage TCG'
            : 'Modern TCG',
    });

    this.db.subjects.push({
      id: subjectId,
      name: input.subjectName,
      role: input.segment === 'SPORTS' ? 'Athlete / Icon' : 'Featured Subject',
      segment: input.segment,
      franchise: input.franchise,
    });

    const topGrade: GradeLabel = input.topGradeLabel || 'PSA 10';
    const topPop = Math.max(0, Number(input.topGradePop) || 0);
    const gemRate = Math.max(0, Math.min(100, Number(input.gemRatePct) || 0));

    const asset: AssetNode = {
      id: slug,
      title: input.title,
      segment: input.segment,
      franchise: input.franchise,
      setId,
      setName: input.setName,
      releaseYear: input.releaseYear,
      cardNumber: input.cardNumber,
      variant: input.variant,
      subjectId,
      subjectName: input.subjectName,
      communityId:
        input.segment === 'SPORTS'
          ? 'COM-SPORTS-BLUECHIP'
          : input.releaseYear < 2005
            ? 'COM-VINTAGE-TCG'
            : 'COM-MODERN-CHASE',
      visualTheme:
        input.segment === 'SPORTS'
          ? 'sports_chrome'
          : input.releaseYear < 2005
            ? 'vintage_holo'
            : 'modern_foil',
      grades: [
        {
          grade: topGrade,
          gradingCompany: topGrade.startsWith('BGS')
            ? 'BGS'
            : topGrade.startsWith('SGC')
              ? 'SGC'
              : topGrade === 'Raw NM'
                ? 'Raw'
                : 'PSA',
          popCount: topPop,
          gemRatePct: gemRate,
        },
        { grade: 'PSA 9', gradingCompany: 'PSA', popCount: 0, gemRatePct: 0 },
        { grade: 'Raw NM', gradingCompany: 'Raw', popCount: 0, gemRatePct: 0 },
      ],
    };

    this.db.assets.unshift(asset);

    // Optional opening verified comp ONLY if explicitly supplied by the user (zero fabricated sales)
    const initPrice = Number(input.initialSalePriceUsd) || 0;
    if (initPrice > 0) {
      const validMarket = this.marketplaces.some(
        (m) => m.id === input.initialSaleMarketplaceId
      )
        ? (input.initialSaleMarketplaceId as MarketplaceId)
        : 'ebay_sold';
      const grade: GradeLabel = input.initialSaleGrade || topGrade;
      const saleDate =
        input.initialSaleDate || new Date().toISOString().slice(0, 10);

      this.db.sales.unshift({
        id: `SL-${Date.now()}-INIT`,
        assetId: asset.id,
        rawTitle: `${input.releaseYear} ${input.setName} ${input.title} ${input.cardNumber} ${grade}`,
        grade,
        priceUsd: initPrice,
        marketplaceId: validMarket,
        date: saleDate,
        status: 'VERIFIED',
        sourceNotes: 'Operator opening verified comp',
      });
    }

    this.persist();
    return asset;
  }

  public importCatalog(payload: {
    assets?: Array<{
      title: string;
      segment?: MarketSegment;
      franchise: string;
      setName: string;
      releaseYear?: number;
      cardNumber?: string;
      variant?: string;
      subjectName?: string;
      topGradePop?: number;
      initialSalePriceUsd?: number;
      initialSaleGrade?: GradeLabel;
      initialSaleMarketplaceId?: MarketplaceId;
      initialSaleDate?: string;
    }>;
    sales?: Array<{
      assetId: string;
      rawTitle?: string;
      grade?: GradeLabel;
      priceUsd: number;
      marketplaceId?: MarketplaceId;
      date?: string;
    }>;
  }): { importedAssets: number; importedSales: number } {
    let importedAssets = 0;
    let importedSales = 0;

    if (Array.isArray(payload.assets)) {
      for (const a of payload.assets.slice(0, 250)) {
        if (!a?.title || !a?.franchise || !a?.setName) continue;
        this.registerCanonicalAsset({
          title: String(a.title).trim(),
          segment: a.segment === 'SPORTS' ? 'SPORTS' : 'TCG',
          franchise: String(a.franchise).trim(),
          setName: String(a.setName).trim(),
          releaseYear: Number(a.releaseYear) || new Date().getFullYear(),
          cardNumber: String(a.cardNumber || '#1').trim(),
          variant: String(a.variant || 'Base').trim(),
          subjectName: String(a.subjectName || a.title).trim(),
          topGradePop: Number(a.topGradePop) || 0,
          initialSalePriceUsd: Number(a.initialSalePriceUsd) || 0,
          initialSaleGrade: a.initialSaleGrade,
          initialSaleMarketplaceId: a.initialSaleMarketplaceId,
          initialSaleDate: a.initialSaleDate,
        });
        importedAssets += 1;
      }
    }

    if (Array.isArray(payload.sales)) {
      const assetIds = new Set(this.db.assets.map((a) => a.id));
      for (const s of payload.sales.slice(0, 1000)) {
        if (!s?.assetId || !assetIds.has(s.assetId) || !(Number(s.priceUsd) > 0)) {
          continue;
        }
        const marketId = this.marketplaces.some((m) => m.id === s.marketplaceId)
          ? (s.marketplaceId as MarketplaceId)
          : 'ebay_sold';
        this.commitSale({
          assetId: s.assetId,
          rawTitle: String(s.rawTitle || `${s.assetId} imported sale`),
          grade: s.grade || 'PSA 10',
          priceUsd: Number(s.priceUsd),
          marketplaceId: marketId,
          date: s.date || new Date().toISOString().slice(0, 10),
          status: 'VERIFIED',
          sourceNotes: 'Bulk catalog import',
        });
        importedSales += 1;
      }
    }

    return { importedAssets, importedSales };
  }

  public exportDatabaseSnapshot(): Record<string, unknown> {
    // Strip adminPasscodeHash and raw embedding float arrays from user-facing export
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: this.db.schemaVersion,
      assets: this.db.assets,
      sets: this.db.sets,
      subjects: this.db.subjects,
      sales: this.db.sales,
      events: this.db.events,
      alertRules: this.db.alertRules,
      portfolioHoldings: this.db.portfolioHoldings,
    };
  }

  public resetAllData(): void {
    const existingPasscodeHash = this.db.adminPasscodeHash;
    this.db = createEmptyDatabase();
    this.db.adminPasscodeHash = existingPasscodeHash;
    this.persist();
  }

  public runDeterministicGraphQuery(question: string): {
    cypherQuery: string;
    matchedAssetIds: string[];
    matchedEventIds: string[];
    facts: Array<{ label: string; value: string; context: string }>;
  } {
    const q = question.toLowerCase();
    const valuations: Record<string, AssetValuation> = {};
    for (const a of this.db.assets) {
      valuations[a.id] = this.computeAssetValuation(a.id);
    }
    const arbs = this.computeArbitrageOpportunities(true);

    if (this.db.assets.length === 0) {
      return {
        cypherQuery: `MATCH (a:Asset)\nRETURN count(a) AS canonicalAssets;`,
        matchedAssetIds: [],
        matchedEventIds: [],
        facts: [
          {
            label: 'Empty Knowledge Graph',
            value: '0 assets',
            context:
              'Register canonical collectibles and ingest verified comps via Setup Guide or Layer 1 Swarm.',
          },
        ],
      };
    }

    if (/arb|spread|cardmarket|ebay|discrepanc|profit/i.test(q)) {
      const top = arbs.slice(0, 4);
      return {
        cypherQuery: `MATCH (a:Asset)<-[:IS_INSTANCE_OF]-(l:ListingSale {status: 'VERIFIED'})-[s:SOLD_ON]->(m:Marketplace)\nWITH a, l.grade AS grade, m.name AS venue, avg(s.price) AS mean_usd, m.sellerFeePct AS fee\nORDER BY mean_usd ASC\nRETURN a.title, grade, collect({venue: venue, mean_usd: round(mean_usd,2), fee: fee}) AS spreads;`,
        matchedAssetIds: top.map((t) => t.assetId),
        matchedEventIds: [],
        facts:
          top.length > 0
            ? top.map((t) => ({
                label: `${t.assetTitle} (${t.grade})`,
                value: `+${t.netSpreadPct.toFixed(1)}% (+$${t.netProfitUsd.toLocaleString()})`,
                context: `Buy ${t.buyMarketplaceName} at $${t.buyAvgPrice.toLocaleString()} -> Sell ${t.sellMarketplaceName} at $${t.sellAvgPrice.toLocaleString()} (${t.sellerFeePct}% fee)`,
              }))
            : [
                {
                  label: 'Cross-Venue Arbitrage',
                  value: '0 spreads > 1.5%',
                  context:
                    'Ingest verified comps across at least 2 marketplaces for the same asset and grade to compute spreads.',
                },
              ],
      };
    }

    if (/catalyst|event|tournament|mvp|championship|ban|release/i.test(q)) {
      const topEvents = this.db.events.slice(0, 4);
      const impacted = Array.from(
        new Set(topEvents.flatMap((e) => e.impactedAssetIds))
      );
      return {
        cypherQuery: `MATCH (e:MarketEvent)-[r:IMPACTED]->(a:Asset)\nRETURN e.title, e.category, e.priceDeltaPct, e.windowDays, a.title, a.franchise\nORDER BY abs(e.priceDeltaPct) DESC;`,
        matchedAssetIds: impacted,
        matchedEventIds: topEvents.map((e) => e.id),
        facts:
          topEvents.length > 0
            ? topEvents.map((e) => ({
                label: e.title,
                value: `${e.priceDeltaPct >= 0 ? '+' : ''}${e.priceDeltaPct}% (${e.windowDays}d)`,
                context: `${e.category} · Impacted: ${e.impactedAssetIds.join(', ')}`,
              }))
            : [
                {
                  label: 'Market Catalyst Nodes',
                  value: '0 events',
                  context:
                    'Inject tournament, ban-list, or milestone catalysts via Layer 1 Swarm Studio.',
                },
              ],
      };
    }

    if (/outlier|shill|fraud|quarantine|damage|reprint/i.test(q)) {
      const quarantined = this.db.sales.filter(
        (s) => s.status === 'QUARANTINED'
      );
      return {
        cypherQuery: `MATCH (l:ListingSale {status: 'QUARANTINED'})-[:IS_INSTANCE_OF]->(a:Asset)\nRETURN a.title, l.rawTitle, l.priceUsd, l.outlierReason;`,
        matchedAssetIds: Array.from(new Set(quarantined.map((s) => s.assetId))),
        matchedEventIds: [],
        facts:
          quarantined.length > 0
            ? quarantined.map((s) => {
                const a = this.db.assets.find((x) => x.id === s.assetId);
                return {
                  label: a?.title || s.assetId,
                  value: `$${s.priceUsd.toLocaleString()} Quarantined`,
                  context: s.outlierReason || 'Flagged by Outlier & Fraud Filter',
                };
              })
            : [
                {
                  label: 'Quarantined Outliers',
                  value: '0 flagged',
                  context:
                    'No fraudulent or mislabeled listings have been quarantined yet.',
                },
              ],
      };
    }

    const sortedByMult = [...this.db.assets]
      .sort(
        (a, b) =>
          (valuations[b.id]?.gradeMultiplier || 0) -
          (valuations[a.id]?.gradeMultiplier || 0)
      )
      .slice(0, 5);

    return {
      cypherQuery: `MATCH (a:Asset)<-[:IS_INSTANCE_OF]-(l:ListingSale {status: 'VERIFIED'})\nWITH a, avg(CASE WHEN l.grade IN ['PSA 10','BGS 9.5','SGC 10'] THEN l.price END) AS topAvg,\n        avg(CASE WHEN l.grade = 'PSA 9' THEN l.price END) AS psa9Avg\nRETURN a.franchise, a.title, round(topAvg,2) AS topAvg, round(topAvg/psa9Avg,2) AS multiplier\nORDER BY multiplier DESC LIMIT 5;`,
      matchedAssetIds: sortedByMult.map((a) => a.id),
      matchedEventIds: this.db.events
        .filter((e) =>
          e.impactedAssetIds.some((id) =>
            sortedByMult.some((a) => a.id === id)
          )
        )
        .map((e) => e.id),
      facts: sortedByMult.map((a) => {
        const v = valuations[a.id];
        return {
          label: `${a.title} (${a.franchise})`,
          value:
            v.gradeMultiplier > 0
              ? `${v.gradeMultiplier.toFixed(2)}x (${v.topGradeLabel}: $${v.topGradeAvg.toLocaleString()})`
              : v.topGradeAvg > 0
                ? `${v.topGradeLabel}: $${v.topGradeAvg.toLocaleString()}`
                : 'Awaiting comps',
          context: `PSA 9 avg $${v.midGradeAvg.toLocaleString()} · Verified comps: ${v.verifiedSaleCount}`,
        };
      }),
    };
  }

  public executeCypherPlan(rawPlan: Partial<CypherQueryPlan>): {
    plan: CypherQueryPlan;
    matchedAssetIds: string[];
    matchedMarketplaceIds: string[];
    matchedEventIds: string[];
    relationships: CypherSubgraphEdge[];
  } {
    const plan: CypherQueryPlan = {
      segment:
        rawPlan.segment === 'TCG' || rawPlan.segment === 'SPORTS'
          ? rawPlan.segment
          : 'ALL',
      franchises: Array.isArray(rawPlan.franchises)
        ? rawPlan.franchises.map((f) => String(f).trim()).filter(Boolean)
        : [],
      assetIds: Array.isArray(rawPlan.assetIds)
        ? rawPlan.assetIds.map((id) => String(id).trim()).filter(Boolean)
        : [],
      marketplaceIds: Array.isArray(rawPlan.marketplaceIds)
        ? rawPlan.marketplaceIds.map((id) => String(id).trim()).filter(Boolean)
        : [],
      eventIds: Array.isArray(rawPlan.eventIds)
        ? rawPlan.eventIds.map((id) => String(id).trim()).filter(Boolean)
        : [],
      includeSoldOn: rawPlan.includeSoldOn !== false,
      includeImpacted: rawPlan.includeImpacted !== false,
      minMultiplier: Math.max(0, Number(rawPlan.minMultiplier) || 0),
      minTopGradeUsd: Math.max(0, Number(rawPlan.minTopGradeUsd) || 0),
      minArbSpreadPct: Math.max(0, Number(rawPlan.minArbSpreadPct) || 0),
      onlyWithQuarantined: Boolean(rawPlan.onlyWithQuarantined),
    };

    const valuations: Record<string, AssetValuation> = {};
    for (const a of this.db.assets) {
      valuations[a.id] = this.computeAssetValuation(a.id);
    }

    const assetIdFilter = new Set(plan.assetIds);
    const franchiseLower = plan.franchises.map((f) => f.toLowerCase());
    const marketFilterSet = new Set(plan.marketplaceIds);
    const eventFilterSet = new Set(plan.eventIds);

    let matchedAssets = this.db.assets.filter((a) => {
      if (plan.segment !== 'ALL' && a.segment !== plan.segment) return false;
      if (assetIdFilter.size > 0 && !assetIdFilter.has(a.id)) return false;
      if (
        franchiseLower.length > 0 &&
        !franchiseLower.some(
          (f) =>
            a.franchise.toLowerCase().includes(f) ||
            a.title.toLowerCase().includes(f) ||
            a.subjectName.toLowerCase().includes(f)
        )
      ) {
        return false;
      }
      const v = valuations[a.id];
      if (!v) return false;
      if (plan.minMultiplier > 0 && v.gradeMultiplier < plan.minMultiplier)
        return false;
      if (plan.minTopGradeUsd > 0 && v.topGradeAvg < plan.minTopGradeUsd)
        return false;
      if (
        plan.minArbSpreadPct > 0 &&
        v.bestArbSpreadPct < plan.minArbSpreadPct
      )
        return false;
      if (plan.onlyWithQuarantined && v.quarantinedCount === 0) return false;
      return true;
    });

    if (eventFilterSet.size > 0) {
      const impactedBySelectedEvents = new Set(
        this.db.events
          .filter((ev) => eventFilterSet.has(ev.id))
          .flatMap((ev) => ev.impactedAssetIds)
      );
      matchedAssets = matchedAssets.filter((a) =>
        impactedBySelectedEvents.has(a.id)
      );
    }

    if (marketFilterSet.size > 0 && plan.includeSoldOn) {
      const assetsInSelectedMarkets = new Set(
        this.db.sales
          .filter(
            (s) =>
              (plan.onlyWithQuarantined
                ? s.status === 'QUARANTINED'
                : s.status === 'VERIFIED') &&
              marketFilterSet.has(s.marketplaceId)
          )
          .map((s) => s.assetId)
      );
      matchedAssets = matchedAssets.filter((a) =>
        assetsInSelectedMarkets.has(a.id)
      );
    }

    const assetMap = new Map(matchedAssets.map((a) => [a.id, a]));
    const marketMap = new Map(this.marketplaces.map((m) => [m.id, m]));
    const matchedMarketplaceSet = new Set<string>();
    const matchedEventSet = new Set<string>();
    const relationships: CypherSubgraphEdge[] = [];

    if (plan.includeSoldOn) {
      const grouped = new Map<
        string,
        {
          assetId: string;
          marketId: MarketplaceId;
          prices: number[];
          quarantined: number;
        }
      >();

      for (const s of this.db.sales) {
        if (!assetMap.has(s.assetId)) continue;
        if (plan.onlyWithQuarantined) {
          if (s.status !== 'QUARANTINED') continue;
        } else if (s.status !== 'VERIFIED') {
          continue;
        }
        if (marketFilterSet.size > 0 && !marketFilterSet.has(s.marketplaceId)) {
          continue;
        }
        const key = `${s.assetId}__${s.marketplaceId}`;
        const entry = grouped.get(key) || {
          assetId: s.assetId,
          marketId: s.marketplaceId,
          prices: [],
          quarantined: 0,
        };
        entry.prices.push(s.priceUsd);
        if (s.status === 'QUARANTINED') entry.quarantined += 1;
        grouped.set(key, entry);
      }

      for (const [key, g] of grouped.entries()) {
        const asset = assetMap.get(g.assetId)!;
        const market = marketMap.get(g.marketId);
        if (!market) continue;
        matchedMarketplaceSet.add(market.id);
        const meanPrice = Math.round(avg(g.prices));
        relationships.push({
          id: `Q-SOLD-${key}`,
          fromId: asset.id,
          fromLabel: asset.title,
          fromType: 'ASSET',
          toId: market.id,
          toLabel: market.name,
          toType: 'MARKETPLACE',
          edgeType: 'SOLD_ON',
          relationLabel:
            g.quarantined > 0
              ? `QUARANTINED (${g.quarantined})`
              : `SOLD_ON (${g.prices.length})`,
          metricText: `$${meanPrice.toLocaleString()} avg`,
        });
      }
    }

    if (plan.includeImpacted) {
      for (const ev of this.db.events) {
        if (eventFilterSet.size > 0 && !eventFilterSet.has(ev.id)) continue;
        for (const aid of ev.impactedAssetIds) {
          if (!assetMap.has(aid)) continue;
          const asset = assetMap.get(aid)!;
          matchedEventSet.add(ev.id);
          relationships.push({
            id: `Q-IMP-${ev.id}-${aid}`,
            fromId: ev.id,
            fromLabel: ev.title,
            fromType: 'EVENT',
            toId: asset.id,
            toLabel: asset.title,
            toType: 'ASSET',
            edgeType: 'IMPACTED',
            relationLabel: `IMPACTED (${ev.windowDays}d)`,
            metricText: `${ev.priceDeltaPct >= 0 ? '+' : ''}${ev.priceDeltaPct}%`,
          });
        }
      }
    }

    return {
      plan,
      matchedAssetIds: matchedAssets.map((a) => a.id),
      matchedMarketplaceIds: Array.from(matchedMarketplaceSet),
      matchedEventIds: Array.from(matchedEventSet),
      relationships,
    };
  }

  public parseAndExecuteRawCypher(cypherQuery: string): {
    plan: CypherQueryPlan;
    matchedAssetIds: string[];
    matchedMarketplaceIds: string[];
    matchedEventIds: string[];
    relationships: CypherSubgraphEdge[];
  } {
    const text = cypherQuery;
    const lower = text.toLowerCase();

    let segment: 'ALL' | 'TCG' | 'SPORTS' = 'ALL';
    if (/segment\s*[:=]\s*['"]sports['"]/i.test(text)) segment = 'SPORTS';
    else if (/segment\s*[:=]\s*['"]tcg['"]/i.test(text)) segment = 'TCG';

    const assetIds = this.db.assets
      .filter((a) => text.includes(a.id))
      .map((a) => a.id);

    const marketplaceIds = this.marketplaces
      .filter(
        (m) =>
          lower.includes(m.id.toLowerCase()) ||
          lower.includes(m.name.toLowerCase()) ||
          (m.id === 'ebay_sold' && /\bebay\b/i.test(text))
      )
      .map((m) => m.id);

    const eventIds = this.db.events
      .filter((e) => text.includes(e.id))
      .map((e) => e.id);

    const franchises = Array.from(
      new Set(this.db.assets.map((a) => a.franchise))
    ).filter((f) => lower.includes(f.toLowerCase()));

    const multMatch = text.match(/multiplier\s*>=?\s*(\d+(?:\.\d+)?)/i);
    const priceMatch = text.match(
      /(?:price|avg|mean_usd)\s*>=?\s*(\d+(?:\.\d+)?)/i
    );
    const spreadMatch = text.match(/spread\w*\s*>=?\s*(\d+(?:\.\d+)?)/i);

    const mentionsSoldOn = /sold_on|marketplace/i.test(text);
    const mentionsImpacted = /impacted|marketevent/i.test(text);

    return this.executeCypherPlan({
      segment,
      franchises,
      assetIds,
      marketplaceIds,
      eventIds,
      includeSoldOn: mentionsSoldOn || !mentionsImpacted,
      includeImpacted: mentionsImpacted || !mentionsSoldOn,
      minMultiplier: multMatch ? Number(multMatch[1]) : 0,
      minTopGradeUsd: priceMatch ? Number(priceMatch[1]) : 0,
      minArbSpreadPct: spreadMatch ? Number(spreadMatch[1]) : 0,
      onlyWithQuarantined: /quarantined/i.test(text),
    });
  }

  public generateCypherSchema(): string {
    return `// SlabGraph Universal TCG & Sports Collectibles Ontology (Neo4j Cypher DDL)
CREATE CONSTRAINT asset_canonical_id IF NOT EXISTS FOR (a:Asset) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT set_release_id IF NOT EXISTS FOR (s:SetRelease) REQUIRE s.id IS UNIQUE;
CREATE CONSTRAINT marketplace_id IF NOT EXISTS FOR (m:Marketplace) REQUIRE m.id IS UNIQUE;
CREATE CONSTRAINT listing_sale_id IF NOT EXISTS FOR (l:ListingSale) REQUIRE l.id IS UNIQUE;
CREATE CONSTRAINT market_event_id IF NOT EXISTS FOR (e:MarketEvent) REQUIRE e.id IS UNIQUE;

// Canonical Asset -> SetRelease & Grade Nodes
MERGE (s:SetRelease {id: $setId, franchise: $franchise, segment: $segment, releaseYear: $releaseYear})
MERGE (a:Asset {id: $assetId, title: $title, segment: $segment, franchise: $franchise})
MERGE (a)-[:BELONGS_TO]->(s)
MERGE (a)-[:GRADED_AS {popCount: $popCount, gemRatePct: $gemRatePct}]->(:ConditionGrade {label: $gradeLabel});

// Verified Sale Edge (Quarantined outliers carry status: 'QUARANTINED' and are excluded from math)
MATCH (a:Asset {id: $assetId}), (m:Marketplace {id: $marketplaceId})
CREATE (l:ListingSale {id: $saleId, status: $status, grade: $grade, rawTitle: $rawTitle})
CREATE (l)-[:IS_INSTANCE_OF {grade: $grade}]->(a)
CREATE (l)-[:SOLD_ON {price: $priceUsd, currency: 'USD', date: date($date)}]->(m);

// Deterministic Arbitrage & Grade Multiplier Query (Zero LLM Math)
MATCH (a:Asset)<-[:IS_INSTANCE_OF]-(l:ListingSale {status: 'VERIFIED'})-[r:SOLD_ON]->(m:Marketplace)
WITH a, l.grade AS grade, m.name AS venue, m.sellerFeePct AS feePct, avg(r.price) AS avgPrice
ORDER BY avgPrice ASC
WITH a, grade, collect({venue: venue, avgPrice: avgPrice, feePct: feePct}) AS venues
WHERE size(venues) >= 2
WITH a, grade, head(venues) AS buy, last(venues) AS sell
WITH a, grade, buy, sell, (sell.avgPrice * (1 - sell.feePct / 100.0)) - buy.avgPrice AS netProfit
WHERE netProfit > 0
RETURN a.id, a.franchise, a.title, grade, buy.venue, sell.venue,
       round(netProfit, 2) AS netProfitUsd,
       round((netProfit / buy.avgPrice) * 100, 2) AS netSpreadPct
ORDER BY netSpreadPct DESC;`;
  }

  public generateSwarmAdapterBlueprint(): string {
    return `// Self-Hosted SlabGraph Swarm Ingestion & Webhook Connector Blueprint
// Point your eBay, TCGplayer, Cardmarket, or Hermes scraper at POST /api/swarm/ingest

export async function pushListingToSlabGraph(listing: {
  rawTitle: string;
  marketplaceId: 'ebay_sold' | 'tcgplayer' | 'cardmarket' | 'pwcc' | 'goldin' | 'fanatics';
  priceUsd: number;
  sellerNotes?: string;
  date?: string;
}) {
  const res = await fetch(\`\${process.env.SLABGRAPH_URL}/api/swarm/ingest\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SLABGRAPH_BEARER_TOKEN
        ? { Authorization: \`Bearer \${process.env.SLABGRAPH_BEARER_TOKEN}\` }
        : {}),
    },
    body: JSON.stringify({ kind: 'LISTING', ...listing }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}`;
  }

  // --- First-party research source ingest (Task 3) ------------------------
  // Additive methods backed by Task 2 collections. Raw source text is stored
  // immutably; a basis is never inferred from content (UNKNOWN means not supplied).
  public addResearchSource(input: {
    type: ResearchSourceNode['type'];
    title: string;
    rawText: string;
    tags?: string[];
    basis?: MarketBasis;
    tenantId?: string;
    raw_payload?: Record<string, unknown>;
    checksum_sha256?: string | null;
    source_url?: string | null;
  }): ResearchSourceNode {
    const source: ResearchSourceNode = {
      id: `src-${randomUUID()}`,
      type: input.type,
      title: input.title,
      rawText: input.rawText,
      tags: input.tags ?? [],
      // Basis is required on the schema; UNKNOWN is an explicit sentinel for
      // "not supplied", never a silent promotion to SOLD/ASKING/GUIDE.
      basis: input.basis ?? 'UNKNOWN',
      capturedAt: new Date().toISOString(),
      tenantId: input.tenantId,
      raw_payload: input.raw_payload,
      checksum_sha256: input.checksum_sha256 ?? null,
      source_url: input.source_url ?? null,
    };
    this.db.researchSources.push(source);
    this.persist();
    return source;
  }

  public getResearchState(): {
    researchSources: ResearchSourceNode[];
    researchObservations: PersistedGraphDatabase['researchObservations'];
    researchNotes: PersistedGraphDatabase['researchNotes'];
    researchProjections: PersistedGraphDatabase['researchProjections'];
    mediaAssets: PersistedGraphDatabase['mediaAssets'];
    marketObservations: PersistedGraphDatabase['marketObservations'];
    identityDecisions: PersistedGraphDatabase['identityDecisions'];
    counts: {
      researchSources: number;
      researchObservations: number;
      researchNotes: number;
      researchProjections: number;
      mediaAssets: number;
      marketObservations: number;
      identityDecisions: number;
    };
  } {
    return {
      researchSources: this.db.researchSources,
      researchObservations: this.db.researchObservations,
      researchNotes: this.db.researchNotes,
      researchProjections: this.db.researchProjections,
      mediaAssets: this.db.mediaAssets,
      marketObservations: this.db.marketObservations,
      identityDecisions: this.db.identityDecisions,
      counts: {
        researchSources: this.db.researchSources.length,
        researchObservations: this.db.researchObservations.length,
        researchNotes: this.db.researchNotes.length,
        researchProjections: this.db.researchProjections.length,
        mediaAssets: this.db.mediaAssets.length,
        marketObservations: this.db.marketObservations.length,
        identityDecisions: this.db.identityDecisions.length,
      },
    };
  }

  public getState(includeFees = true): GraphStatePayload {
    const valuations: Record<string, AssetValuation> = {};
    for (const asset of this.db.assets) {
      valuations[asset.id] = this.computeAssetValuation(asset.id);
    }

    const arbitrage = this.computeArbitrageOpportunities(includeFees);
    const communities = this.computeCommunitySummaries(valuations);
    const triggeredAlerts = this.evaluateTriggeredAlerts(valuations, arbitrage);
    const portfolio = this.computePortfolioSummary(valuations);
    const vectorIndex = computeVectorIndexStatus(
      this.db.assets,
      this.db.events,
      this.db.embeddings
    );

    const verifiedSales = this.db.sales.filter(
      (s) => s.status === 'VERIFIED'
    ).length;
    const quarantinedOutliers = this.db.sales.filter(
      (s) => s.status === 'QUARANTINED'
    ).length;

    const trackedFranchises = Array.from(
      new Set(this.db.assets.map((a) => a.franchise))
    ).sort();

    return {
      assets: this.db.assets,
      sets: this.db.sets,
      subjects: this.db.subjects,
      marketplaces: this.marketplaces,
      sales: this.db.sales,
      events: this.db.events,
      valuations,
      arbitrage,
      communities,
      queuedFeed: this.db.queuedFeed,
      swarmRuns: this.db.swarmRuns,
      alertRules: this.db.alertRules,
      triggeredAlerts,
      alertDeliveries: this.db.alertDeliveries,
      alertChannels: getAlertChannelStatus(),
      portfolio,
      vectorIndex,
      storage: getStorageStatus(),
      onboardingCompleted: this.db.onboardingCompleted,
      kpis: {
        canonicalAssets: this.db.assets.length,
        verifiedSales,
        quarantinedOutliers,
        activeArbitrageCount: arbitrage.length,
        topArbitrageSpreadPct: arbitrage.length ? arbitrage[0].netSpreadPct : 0,
        trackedFranchises,
      },
    };
  }
}

export const graphEngine = new KnowledgeGraphEngine();
