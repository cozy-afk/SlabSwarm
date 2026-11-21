import type { AssetNode } from '../types/graph.ts';

export const VISUAL_THEME_IMAGES: Record<AssetNode['visualTheme'], string> = {
  vintage_holo: '/src/assets/images/slab_vintage_tcg_holo_1795260233009.jpg',
  arcane_artifact: '/src/assets/images/slab_arcane_artifact_tcg_1795260232159.jpg',
  modern_foil: '/src/assets/images/slab_modern_manga_tcg_1795260232065.jpg',
  sports_chrome: '/src/assets/images/slab_graded_sports_rookie_1795260233009.jpg',
};

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}k`;
  return formatUsd(value);
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '0.0%';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function formatTimeShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
