#!/usr/bin/env python3
"""Pull real card comps from TCG API and push them into SlabGraph.

No secrets in this file. Reads TCGAPI_KEY, SLABGRAPH_URL and SLABGRAPH_TOKEN
from the environment. SLABGRAPH_QUERIES is a JSON list of [query, game_slug]
pairs. Re-running skips titles already present in the graph.
"""
import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request

TCG_BASE = "https://api.tcgapi.dev/v1"
SLAB_URL = os.environ.get("SLABGRAPH_URL", "http://10.99.0.1:3010").rstrip("/")
TOKEN = os.environ.get("SLABGRAPH_TOKEN", "").strip()
KEY = os.environ.get("TCGAPI_KEY", "").strip()
MIN_PRICE = float(os.environ.get("TCG_MIN_PRICE", "100"))
MAX_PER_QUERY = int(os.environ.get("TCG_MAX_PER_QUERY", "4"))
QUERIES = json.loads(
    os.environ.get(
        "SLABGRAPH_QUERIES",
        '[["umbreon","pokemon"],["pikachu","pokemon"],'
        '["zoro","one-piece-card-game"],["sanji","one-piece-card-game"]]',
    )
)

if not KEY:
    raise SystemExit("TCGAPI_KEY is required")
if not TOKEN:
    raise SystemExit("SLABGRAPH_TOKEN is required")


def get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(url, payload, headers=None):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


state = get_json(f"{SLAB_URL}/api/graph/state")
existing = {
    (a.get("title", "").lower().strip(), a.get("setName", "").lower().strip())
    for a in state.get("assets", [])
}
print(f"existing assets: {len(existing)}")

seen = set()
assets = []
for query, game in QUERIES:
    params = urllib.parse.urlencode({"q": query, "game": game})
    try:
        data = get_json(f"{TCG_BASE}/search?{params}", {"X-API-Key": KEY})
    except urllib.error.HTTPError as exc:
        print(f"search failed for {query}/{game}: HTTP {exc.code}")
        continue
    remaining = data.get("rate_limit", {}).get("daily_remaining", "?")
    picked = 0
    for row in data.get("data", []):
        if row.get("product_type") != "Cards":
            continue
        price = float(row.get("market_price") or 0)
        if price < MIN_PRICE:
            continue
        name = str(row.get("name") or "").strip()
        set_name = str(row.get("set_name") or "").strip()
        printing = str(row.get("printing") or "").strip()
        number = str(row.get("number") or "").strip()
        if not name or not set_name:
            continue
        title = f"{name} {number}".strip()
        key = (title.lower(), set_name.lower(), printing.lower())
        if key in seen or (title.lower(), set_name.lower()) in existing:
            continue
        seen.add(key)
        assets.append({
            "segment": "TCG",
            "franchise": str(row.get("game_name") or game).strip(),
            "title": title,
            "setName": set_name,
            "cardNumber": number or "#1",
            "variant": " ".join(
                x for x in (row.get("rarity"), printing) if x
            ).strip() or "Base",
            "subjectName": name,
            "initialSalePriceUsd": round(price, 2),
            "initialSaleGrade": "Raw NM",
            "initialSaleMarketplaceId": "tcgplayer",
            "initialSaleDate": row.get("market_price_as_of")
            or dt.date.today().isoformat(),
        })
        picked += 1
        if picked >= MAX_PER_QUERY:
            break
    print(f"{query}/{game}: picked {picked}, api remaining={remaining}")

if not assets:
    raise SystemExit("no new cards to import")

result = post_json(
    f"{SLAB_URL}/api/graph/import",
    {"assets": assets},
    {"Authorization": f"Bearer {TOKEN}"},
)
print("imported:", result.get("importedAssets"), "assets")
for a in assets:
    print(f"  {a['title']} | {a['setName']} | ${a['initialSalePriceUsd']}")
