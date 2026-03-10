import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// Helper: replaces all {R(()=>{ return <JSX/> })} IIFEs which break the artifact Babel transpiler
const R = fn => fn();

// ─── LIVE API CONFIG ───────────────────────────────────────
const API_CONFIG = {
  kalshi: { baseUrl: "https://api.elections.kalshi.com/trade-api/v2" },
  predict: { baseUrl: "https://api.predict.fun", apiKey: null },
  local: {
    baseUrl: import.meta.env.VITE_API_URL || "https://web-production-7e05d.up.railway.app",
    wsUrl: import.meta.env.VITE_WS_URL || "wss://web-production-7e05d.up.railway.app"
  }
};

async function fetchWithFallback(fetchFn, mockData, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fetchFn(); }
    catch (err) {
      if (i === retries) { console.warn("API failed, using fallback:", err); return mockData; }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchKalshiMarkets(options = {}) {
  const { status = "open", limit = 200, cursor = null } = options;
  const params = new URLSearchParams({ limit, status });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${API_CONFIG.kalshi.baseUrl}/markets?${params}`);
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  return res.json();
}

async function fetchPredictMarkets(apiKey, options = {}) {
  const { first = 100, after = null } = options;
  const params = new URLSearchParams();
  if (first) params.set("first", first);
  if (after) params.set("after", after);
  const res = await fetch(`${API_CONFIG.predict.baseUrl}/v1/markets?${params}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Predict API error: ${res.status}`);
  return res.json();
}

function normalizeKalshiMarket(km) {
  return {
    platformKey: "kalshi", externalId: km.ticker, title: km.title,
    category: km.category || "Other",
    yes: parseFloat(km.yes_bid_dollars) || (km.yes_bid != null ? km.yes_bid / 100 : 0.5),
    no: parseFloat(km.no_bid_dollars) || (km.no_bid != null ? km.no_bid / 100 : 0.5),
    volume24h: parseInt(km.volume_24h_fp || km.volume_24h) || 0,
    expiry: km.expiration_time, status: km.status,
  };
}

function normalizePredictMarket(pm) {
  return {
    platformKey: "predict", externalId: String(pm.id || pm.marketId),
    title: pm.title || pm.question, category: pm.category?.name || "Other",
    yes: pm.lastPrice || pm.bestBid || 0.5,
    no: 1 - (pm.lastPrice || pm.bestBid || 0.5),
    volume24h: pm.volume24h || 0, expiry: pm.endDate || pm.expirationDate, status: pm.status || "active",
  };
}

function calculateSimilarity(a, b) {
  if (!a || !b) return 0;
  const tokenize = s => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
  const sa = tokenize(a), sb = tokenize(b);
  const intersection = new Set([...sa].filter(x => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function buildUnifiedMarkets(kalshiMarkets, predictMarkets) {
  const unified = [];
  kalshiMarkets.forEach(km => {
    const existing = unified.find(u => calculateSimilarity(km.title, u.event) > 0.5);
    if (existing) {
      existing.prices.kalshi = { yes: km.yes, no: km.no };
      existing.names.kalshi = km.title;
      existing._sources = existing._sources || {};
      existing._sources.kalshi = km.externalId;
    } else {
      unified.push({
        id: "k_" + km.externalId,
        event: km.title, category: km.category,
        names: { kalshi: km.title, polymarket: "—", opinion: "—", predict: "—" },
        prices: { kalshi: { yes: km.yes, no: km.no }, polymarket: { yes: 0.5, no: 0.5 }, opinion: { yes: 0.5, no: 0.5 }, predict: { yes: 0.5, no: 0.5 } },
        spread: 0, apr: 0, volume: km.volume24h || 0,
        expiry: km.expiry || new Date(Date.now() + 86400000 * 180).toISOString(),
        status: "active", liquidity: 50, bookDepth: 50000,
        _sources: { kalshi: km.externalId }, _isMock: false,
      });
    }
  });
  predictMarkets.forEach(pm => {
    const existing = unified.find(u => calculateSimilarity(pm.title, u.event) > 0.5);
    if (existing) {
      existing.prices.predict = { yes: pm.yes, no: pm.no };
      existing.names.predict = pm.title;
      existing._sources = existing._sources || {};
      existing._sources.predict = pm.externalId;
    } else {
      unified.push({
        id: "p_" + pm.externalId,
        event: pm.title, category: pm.category,
        names: { predict: pm.title, kalshi: "—", polymarket: "—", opinion: "—" },
        prices: { predict: { yes: pm.yes, no: pm.no }, kalshi: { yes: 0.5, no: 0.5 }, polymarket: { yes: 0.5, no: 0.5 }, opinion: { yes: 0.5, no: 0.5 } },
        spread: 0, apr: 0, volume: pm.volume24h || 0,
        expiry: pm.expiry || new Date(Date.now() + 86400000 * 180).toISOString(),
        status: "active", liquidity: 50, bookDepth: 50000,
        _sources: { predict: pm.externalId }, _isMock: false,
      });
    }
  });
  return unified;
}

// ─── MOCK DATA ─────────────────────────────────────────────
// Market platform definitions with brand colors
const PLATFORMS = {
  polymarket: { key:"polymarket", name:"Polymarket", short:"Poly", icon:"■", color:"#4C8BF5", colorSoft:"rgba(76,139,245,0.06)", fee:0.0217, settlement:"On-chain (Polygon)", trust:92 },
  opinion:    { key:"opinion",    name:"Opinion Labs", short:"Opin", icon:"●", color:"#E8853D", colorSoft:"rgba(232,133,61,0.06)", fee:0, settlement:"Centralized escrow", trust:78 },
  kalshi:     { key:"kalshi",     name:"Kalshi", short:"Klsh", icon:"◆", color:"#00C9A7", colorSoft:"rgba(0,201,167,0.06)", fee:0.01, settlement:"CFTC-regulated exchange", trust:88 },
  predict:    { key:"predict",    name:"Predict", short:"Pred", icon:"▲", color:"#A855F7", colorSoft:"rgba(168,85,247,0.06)", fee:0.015, settlement:"Decentralized protocol", trust:74 },
};
const PLATFORM_KEYS = Object.keys(PLATFORMS);

const MOCK = [
  { id:1, event:"Bitcoin above $150K by Dec 2026", names:{polymarket:"BTC price ≥ $150,000 on Dec 31",opinion:"Bitcoin hits $150K before 2027",kalshi:"BTC ≥ $150K by Dec 31 2026",predict:"Bitcoin $150K+ end of 2026"}, category:"Crypto", prices:{polymarket:{yes:0.38,no:0.62},opinion:{yes:0.42,no:0.58},kalshi:{yes:0.40,no:0.60},predict:{yes:0.44,no:0.56}}, spread:0.0526, apr:52.3, volume:2400000, expiry:"2026-12-31", status:"hot", liquidity:87, bookDepth:180000 },
  { id:2, event:"Trump wins 2028 Presidential Election", names:{polymarket:"Donald Trump wins 2028 election",opinion:"Trump elected President in 2028",kalshi:"Trump wins 2028 presidential",predict:"Trump 2028 election victory"}, category:"Politics", prices:{polymarket:{yes:0.52,no:0.48},opinion:{yes:0.47,no:0.53},kalshi:{yes:0.50,no:0.50},predict:{yes:0.45,no:0.55}}, spread:0.05, apr:32.9, volume:8900000, expiry:"2028-11-05", status:"hot", liquidity:94, bookDepth:520000 },
  { id:3, event:"Ethereum above $10K in 2026", names:{polymarket:"ETH price ≥ $10,000 in 2026",opinion:"Ethereum breaks $10K by year-end",kalshi:"ETH ≥ $10K in 2026",predict:"Ethereum $10K+ 2026"}, category:"Crypto", prices:{polymarket:{yes:0.22,no:0.78},opinion:{yes:0.28,no:0.72},kalshi:{yes:0.25,no:0.75},predict:{yes:0.30,no:0.70}}, spread:0.04, apr:28.0, volume:1200000, expiry:"2026-12-31", status:"active", liquidity:72, bookDepth:95000 },
  { id:4, event:"Fed cuts rates below 3% by Q2 2026", names:{polymarket:"Fed funds rate < 3% by Jun 2026",opinion:"US interest rate drops below 3%",kalshi:"Fed rate under 3% by Q2 2026",predict:"Sub-3% Fed rate by mid-2026"}, category:"Economy", prices:{polymarket:{yes:0.61,no:0.39},opinion:{yes:0.55,no:0.45},kalshi:{yes:0.58,no:0.42},predict:{yes:0.53,no:0.47}}, spread:0.06, apr:24.1, volume:3100000, expiry:"2026-06-30", status:"active", liquidity:81, bookDepth:210000 },
  { id:5, event:"Apple launches foldable iPhone in 2026", names:{polymarket:"Apple releases foldable iPhone",opinion:"Foldable iPhone announced by Apple",kalshi:"Apple foldable iPhone in 2026",predict:"Foldable iPhone launch 2026"}, category:"Tech", prices:{polymarket:{yes:0.15,no:0.85},opinion:{yes:0.21,no:0.79},kalshi:{yes:0.18,no:0.82},predict:{yes:0.23,no:0.77}}, spread:0.04, apr:19.8, volume:890000, expiry:"2026-12-31", status:"active", liquidity:58, bookDepth:42000 },
  { id:6, event:"SpaceX Starship reaches Mars by 2028", names:{polymarket:"Starship lands on Mars before 2029",opinion:"SpaceX Mars landing by end of 2028",kalshi:"SpaceX Mars arrival pre-2029",predict:"Starship Mars landing 2028"}, category:"Tech", prices:{polymarket:{yes:0.08,no:0.92},opinion:{yes:0.14,no:0.86},kalshi:{yes:0.10,no:0.90},predict:{yes:0.16,no:0.84}}, spread:0.06, apr:17.5, volume:670000, expiry:"2028-12-31", status:"active", liquidity:45, bookDepth:28000 },
  { id:7, event:"UK rejoins EU single market by 2030", names:{polymarket:"UK re-enters EU single market",opinion:"Britain returns to single market",kalshi:"UK EU single market re-entry 2030",predict:"UK back in EU market by 2030"}, category:"Politics", prices:{polymarket:{yes:0.05,no:0.95},opinion:{yes:0.09,no:0.91},kalshi:{yes:0.07,no:0.93},predict:{yes:0.11,no:0.89}}, spread:0.04, apr:14.2, volume:340000, expiry:"2030-01-01", status:"active", liquidity:32, bookDepth:15000 },
  { id:8, event:"Global recession declared in 2026", names:{polymarket:"Official global recession in 2026",opinion:"World economy enters recession",kalshi:"Global recession 2026",predict:"2026 worldwide recession"}, category:"Economy", prices:{polymarket:{yes:0.33,no:0.67},opinion:{yes:0.28,no:0.72},kalshi:{yes:0.31,no:0.69},predict:{yes:0.26,no:0.74}}, spread:0.05, apr:12.6, volume:1800000, expiry:"2026-12-31", status:"active", liquidity:76, bookDepth:130000 },
  { id:9, event:"AI passes Turing test by 2027", names:{polymarket:"AI passes Turing test by 2027",opinion:"Turing test beaten by AI system",kalshi:"AI Turing test pass by 2027",predict:"Turing test beaten pre-2028"}, category:"Tech", prices:{polymarket:{yes:0.44,no:0.56},opinion:{yes:0.39,no:0.61},kalshi:{yes:0.42,no:0.58},predict:{yes:0.37,no:0.63}}, spread:0.05, apr:11.3, volume:2100000, expiry:"2027-12-31", status:"active", liquidity:68, bookDepth:105000 },
  { id:10, event:"Solana flips Ethereum market cap", names:{polymarket:"SOL market cap exceeds ETH",opinion:"Solana overtakes Ethereum mcap",kalshi:"SOL mcap > ETH mcap",predict:"Solana flips Ethereum"}, category:"Crypto", prices:{polymarket:{yes:0.11,no:0.89},opinion:{yes:0.16,no:0.84},kalshi:{yes:0.13,no:0.87},predict:{yes:0.18,no:0.82}}, spread:0.05, apr:9.7, volume:920000, expiry:"2026-12-31", status:"active", liquidity:53, bookDepth:48000 },
];
// Helper to get market data for a selected pair
const getMarketPair = (o, mktA, mktB) => ({
  a: { ...PLATFORMS[mktA], yes: o.prices[mktA].yes, no: o.prices[mktA].no, name_label: o.names[mktA] },
  b: { ...PLATFORMS[mktB], yes: o.prices[mktB].yes, no: o.prices[mktB].no, name_label: o.names[mktB] },
});

const genBook = (bp, depth, side) => {
  const levels = [];
  let cq = 0;
  for (let i = 0; i < 20; i++) {
    const p = Math.max(0.01, Math.min(0.99, bp + (i+1)*0.005*(side==="ask"?1:-1)));
    const q = (depth/20)*(0.5+Math.random());
    cq += q;
    levels.push({ price:p, quantity:q, cumulative:cq });
  }
  return levels;
};

// ─── DESIGN TOKENS — Black & White Mode ───────────────────
const T = {
  bg: "#060606",
  // EXTREME Glassmorphism — deep frosted glass, no outlines
  card: "rgba(255,255,255,0.038)",
  cardHover: "rgba(255,255,255,0.062)",
  cardSolid: "#0C0C0C",
  cardBorder: "none",
  cardShadow: "0 8px 40px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -1px 0 rgba(255,255,255,0.05), 0 0 0 0.5px rgba(255,255,255,0.07)",
  cardShadowHover: "0 12px 48px rgba(0,0,0,0.45), 0 0 40px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.20), inset 0 -1px 0 rgba(255,255,255,0.06), 0 0 0 0.5px rgba(255,255,255,0.10)",
  cardGlow: "0 0 64px rgba(255,255,255,0.09), 0 16px 56px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -1px 0 rgba(255,255,255,0.06), 0 0 0 0.5px rgba(255,255,255,0.12)",
  blur: "blur(110px) saturate(1.35)",
  // Glass for smaller elements
  glass: "rgba(255,255,255,0.030)",
  glassHover: "rgba(255,255,255,0.055)",
  glassShadow: "0 4px 28px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(255,255,255,0.05), 0 0 0 0.5px rgba(255,255,255,0.07)",
  glassBlur: "blur(90px) saturate(1.30)",
  // Text — pure white hierarchy
  text: "#F2F2F2",
  textSecondary: "#999999",
  textTertiary: "#808080",
  textPlaceholder: "#505050",
  // Accents — monochrome platinum
  aurora: "linear-gradient(135deg, #FFFFFF 0%, #C0C0C0 20%, #E8E8E8 40%, #A0A0A0 55%, #D0D0D0 75%, #FFFFFF 100%)",
  auroraText: "#D0D0D0",
  auroraSoft: "rgba(255,255,255,0.025)",
  auroraBorder: "none",
  polyBlue: "#4C8BF5",
  kalshiGreen: "#00C9A7",
  predictPurple: "#A855F7",
  polyBlueSoft: "rgba(255,255,255,0.025)",
  kalshiGreenSoft: "rgba(0,201,167,0.025)",
  predictPurpleSoft: "rgba(168,85,247,0.025)",
  polyBlueBorder: "none",
  kalshiGreenBorder: "none",
  predictPurpleBorder: "none",
  opinOrange: "#E8853D",
  opinOrangeSoft: "rgba(255,255,255,0.025)",
  opinOrangeBorder: "none",
  positive: "#34C759",
  warning: "#D4A843",
  negative: "rgba(224,85,85,0.80)",
  negativeRaw: "#E05555",
  border: "rgba(255,255,255,0.05)",
  softBg: "rgba(255,255,255,0.02)",
  display: "'Syne', 'Inter', -apple-system, 'Helvetica Neue', sans-serif",
  body: "'DM Sans', 'Inter', -apple-system, 'Helvetica Neue', sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', monospace",
};


const S = {
  monoLabel: { fontSize: 9, fontWeight: 600, letterSpacing: 2, fontFamily: T.mono, color: T.textTertiary, textTransform: "uppercase", marginBottom: 4 },
  miniBox: { background: "rgba(255,255,255,0.022)", backdropFilter: T.glassBlur, WebkitBackdropFilter: T.glassBlur, borderRadius: 16, padding: "14px 16px", border: "none", boxShadow: T.glassShadow },
  th: { padding: "14px 16px", fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 2.5, fontFamily: T.mono, color: T.textTertiary, borderBottom: "none", background: T.cardSolid, backdropFilter: "blur(52px) saturate(1.35)", WebkitBackdropFilter: "blur(52px) saturate(1.35)", position: "sticky", top: 0, zIndex: 10, isolation: "isolate" },
};
const LOGO_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAfQAAABqCAMAAAB9E1M/AAADAFBMVEWOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpND45gYAAAA/3RSTlMABGl1ByHA1Cx7+fuCCS3S3EEMivr9nBBA3uxSD/6rElDr7V4CHbK9I2bx9ncgvtErdocKLtC2sPzbPY/jRZMNnguN5Eqi2DkyqhVM6ogF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";
const LOGO_MINI_SRC = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAEZCAMAAAAaFOhZAAADAFBMVEWOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpOOjpND45gYAAAA/3RSTlMACmyBCzja2VADlP22FjnwZAQPk/ywHAI81+50IeU9AQVu9wgfwd5DBnH2+pEOI7/cRIT1TOqixydN5/JwJKrEK3/49C/S0UCAETHkUX6l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";

// ─── GLOBAL STYLES ─────────────────────────────────────────
const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    @keyframes aShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    @keyframes scanline{0%{top:-4px}100%{top:100%}}
    @keyframes a1{0%{transform:translate(-25%,-35%) rotate(0) scale(1)}25%{transform:translate(12%,-8%) rotate(22deg) scale(1.2)}50%{transform:translate(-8%,14%) rotate(-14deg) scale(0.92)}75%{transform:translate(18%,-22%) rotate(10deg) scale(1.1)}100%{transform:translate(-25%,-35%) rotate(0) scale(1)}}
    @keyframes a2{0%{transform:translate(12%,12%) rotate(0) scale(1)}33%{transform:translate(-18%,-18%) rotate(-28deg) scale(1.25)}66%{transform:translate(22%,8%) rotate(14deg) scale(0.88)}100%{transform:translate(12%,12%) rotate(0) scale(1)}}
    @keyframes a3{0%{transform:translate(0,0) rotate(0)}20%{transform:translate(-14%,20%) rotate(18deg)}40%{transform:translate(20%,-14%) rotate(-12deg)}60%{transform:translate(-24%,10%) rotate(20deg)}80%{transform:translate(14%,-20%) rotate(-8deg)}100%{transform:translate(0,0) rotate(0)}}
    @keyframes af1{0%,100%{opacity:0.50}30%{opacity:0.75}60%{opacity:0.40}80%{opacity:0.65}}
    @keyframes af2{0%,100%{opacity:0.42}25%{opacity:0.68}50%{opacity:0.32}75%{opacity:0.58}}
    @keyframes af3{0%,100%{opacity:0.35}40%{opacity:0.55}70%{opacity:0.25}90%{opacity:0.48}}
    @keyframes hotPulse{0%,100%{box-shadow:0 0 6px rgba(255,255,255,0.10), 0 0 16px rgba(255,255,255,0.04)}50%{box-shadow:0 0 18px rgba(255,255,255,0.22), 0 0 32px rgba(255,255,255,0.08)}}
    @keyframes livePulse{0%,100%{box-shadow:0 0 8px rgba(255,255,255,0.12), 0 0 20px rgba(255,255,255,0.05)}50%{box-shadow:0 0 16px rgba(255,255,255,0.20), 0 0 36px rgba(255,255,255,0.08), 0 0 60px rgba(255,255,255,0.03)}}
    @keyframes loadFade{0%{opacity:1}80%{opacity:1}100%{opacity:0;pointer-events:none}}
    @keyframes loadBar{0%{width:0%}100%{width:100%}}
    @keyframes loadLogo{0%{opacity:0;transform:scale(0.9)}30%{opacity:1;transform:scale(1)}100%{opacity:1;transform:scale(1)}}
    @keyframes rowFlashGreen{0%{background:rgba(52,199,89,0.12)}100%{background:transparent}}
    @keyframes rowFlashRed{0%{background:rgba(255,59,48,0.10)}100%{background:transparent}}
    @keyframes toastIn{0%{opacity:0;transform:translateX(-50%) translateY(12px)}100%{opacity:1;transform:translateX(-50%) translateY(0)}}
    @keyframes arrowFade{0%{opacity:0;transform:translateY(2px)}100%{opacity:1;transform:translateY(0)}}
    @keyframes checkFadeIn{0%{opacity:0;transform:scale(0.7)}100%{opacity:1;transform:scale(1)}}
    @keyframes curtainSway1{0%{transform:skewX(0deg) translateX(0)}25%{transform:skewX(3deg) translateX(2%)}50%{transform:skewX(-2deg) translateX(-1.5%)}75%{transform:skewX(1.5deg) translateX(1%)}100%{transform:skewX(0deg) translateX(0)}}
    @keyframes curtainSway2{0%{transform:skewX(1deg) translateX(0)}30%{transform:skewX(-3deg) translateX(-2%)}60%{transform:skewX(2deg) translateX(1.5%)}100%{transform:skewX(1deg) translateX(0)}}
    @keyframes curtainSway3{0%{transform:skewX(-1deg) translateX(0)}20%{transform:skewX(2.5deg) translateX(1.5%)}50%{transform:skewX(-2deg) translateX(-2%)}80%{transform:skewX(1deg) translateX(0.5%)}100%{transform:skewX(-1deg) translateX(0)}}
    @keyframes revealUp{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:translateY(0)}}
    @keyframes revealScale{from{opacity:0;transform:scale(0.92) translateY(20px)}to{opacity:1;transform:scale(1) translateY(0)}}
    @keyframes revealFade{from{opacity:0}to{opacity:1}}
    @keyframes revealLine{from{transform:scaleX(0)}to{transform:scaleX(1)}}
    @keyframes fadeOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-8px)}}
    @keyframes glassShimmer{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    @keyframes glowPulse{0%{filter:drop-shadow(0 0 48px rgba(255,255,255,0.22)) drop-shadow(0 0 80px rgba(76,139,245,0.12)) drop-shadow(0 2px 6px rgba(255,255,255,0.14))}100%{filter:drop-shadow(0 0 64px rgba(255,255,255,0.35)) drop-shadow(0 0 96px rgba(76,139,245,0.18)) drop-shadow(0 2px 8px rgba(255,255,255,0.20))}}
    @keyframes letterReveal{0%{letter-spacing:-3px;opacity:0}100%{letter-spacing:-1px;opacity:1}}
    @keyframes heroGlassShimmer{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    .pl-glass-underlay{position:relative;display:block;padding:6px 0 10px;}
    .pl-glass-underlay::before{display:none;}
    @keyframes dirPulse{0%{opacity:0}20%{opacity:1}100%{opacity:1}}
    @keyframes ringFlash{0%{stroke:#ffffff}100%{stroke:#34C759}}
    @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
    @keyframes pulseOnce{0%{box-shadow:0 0 0 0 rgba(255,255,255,0.3)}50%{box-shadow:0 0 0 6px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
    @keyframes cellFlashWhite{0%{background:rgba(255,255,255,0.12)}100%{background:transparent}}
    @keyframes priceCellFlashGreen{0%{background:rgba(52,199,89,0.15)}100%{background:rgba(255,255,255,0.022)}}
    @keyframes priceCellFlashRed{0%{background:rgba(224,85,85,0.12)}100%{background:rgba(255,255,255,0.022)}}
    @keyframes drawerOverlayIn{from{opacity:0}to{opacity:1}}
    @keyframes drawerOverlayOut{from{opacity:1}to{opacity:0}}
    @keyframes drawerSlideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
    @keyframes drawerSlideOut{from{transform:translateX(0)}to{transform:translateX(100%)}}
    @keyframes rowFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    .pl-step-card:hover .pl-step-num{opacity:1!important;background:linear-gradient(135deg, #2E5CFF, #6B9AFF, #FFFFFF, #FFB87A, #E8853D)!important;background-size:300% 300%!important;animation:aShift 3s ease infinite!important;-webkit-background-clip:text!important;-webkit-text-fill-color:transparent!important;filter:drop-shadow(0 0 20px rgba(76,139,245,0.4)) drop-shadow(0 0 40px rgba(232,133,61,0.2))!important;transform:scale(1.08)!important;}
    .pl-table-row{animation:rowFadeIn 0.25s ease-out both;}
    .pl-mobile-card-item{animation:rowFadeIn 0.3s ease-out both;}
    .pl-desktop-table>div>table>thead>tr>th:first-child{border-top-left-radius:18px!important;}
    .pl-desktop-table>div>table>thead>tr>th:last-child{border-top-right-radius:18px!important;}

    /* ══════════════════════════════════════════════════════════
       MOBILE MASTERPIECE — Comprehensive Responsive System
       ══════════════════════════════════════════════════════════ */

    /* ─── TABLET (769–1100px) ─── */
    @media(min-width:769px) and (max-width:1100px){
      .pl-desktop-table{overflow-x:auto!important;-webkit-overflow-scrolling:touch;}
      .pl-desktop-table table{min-width:900px;}
    }

    /* ─── MOBILE (≤768px) — Core Layout ─── */
    @media(max-width:768px){
      /* Table → Cards */
      .pl-desktop-table{display:none!important;}
      .pl-mobile-cards{display:block!important;}

      /* ── GLOBAL MOBILE RESETS ── */
      body{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;overscroll-behavior-y:contain;}

      /* ── SAFE AREA SUPPORT (notched phones) ── */
      .pl-mobile-nav{padding-left:max(16px,env(safe-area-inset-left))!important;padding-right:max(16px,env(safe-area-inset-right))!important;}
      .pl-mobile-footer{padding-bottom:max(40px,env(safe-area-inset-bottom))!important;}

      /* ── NAVIGATION ── */
      nav{-webkit-backdrop-filter:blur(80px) saturate(1.6)!important;backdrop-filter:blur(80px) saturate(1.6)!important;}
      nav>div{padding:0 16px!important;height:52px!important;}
      .pl-nav-right{gap:8px!important;}
      .pl-matrix-btn{display:none!important;}
      .pl-compare-label{display:none!important;}
      .pl-dash-content{padding:16px 14px!important;}

      /* ── CONTROLS BAR ── */
      .pl-controls-bar{flex-direction:column!important;align-items:stretch!important;gap:10px!important;}
      .pl-controls-bar input[type=text]{width:100%!important;font-size:14px!important;padding:12px 16px!important;border-radius:14px!important;}
      .pl-controls-bar>div:last-child{display:flex!important;gap:8px!important;}
      .pl-controls-bar>div:last-child>button{flex:1!important;justify-content:center!important;padding:12px 10px!important;font-size:11px!important;border-radius:14px!important;min-height:44px!important;}

      /* ── SIGNAL CARD ── */
      .pl-signal-card{flex-direction:column!important;text-align:left!important;gap:16px!important;padding:20px 18px!important;}
      .pl-signal-card>div:first-child{width:100%!important;}
      .pl-signal-card>div:last-child{
        text-align:left!important;
        display:flex!important;
        flex-direction:row!important;
        align-items:center!important;
        justify-content:space-between!important;
        width:100%!important;
        gap:12px!important;
        padding-top:12px!important;
        border-top:1px solid rgba(255,255,255,0.04)!important;
      }
      .pl-signal-card>div:last-child>div:first-child{
        font-size:32px!important;
        letter-spacing:-1.5px!important;
      }
      .pl-signal-card>div:last-child>div:nth-child(2){
        font-size:8px!important;
        letter-spacing:2px!important;
      }
      .pl-signal-card>div:last-child>button{
        margin-top:0!important;
        padding:14px 24px!important;
        font-size:11px!important;
        border-radius:12px!important;
        min-height:48px!important;
        letter-spacing:1.5px!important;
        flex-shrink:0!important;
      }

      /* ── FILTER / ALERT PANELS ── */
      .pl-filter-grid{grid-template-columns:1fr!important;gap:10px!important;}
      .pl-filter-grid>div{padding:14px 16px!important;border-radius:14px!important;}
      .pl-filter-grid input[type=range]{height:6px!important;margin:4px 0!important;}
      .pl-filter-grid input[type=range]::-webkit-slider-thumb{width:24px!important;height:24px!important;}

      /* ── MOBILE CARD ITEMS ── */
      .pl-mobile-card-item{margin-bottom:10px!important;}
      .pl-mobile-card-item>div:first-child{
        padding:16px!important;
        border-radius:16px!important;
        -webkit-tap-highlight-color:transparent!important;
        touch-action:manipulation!important;
      }

      /* ── EXPANDED DETAIL VIEW ── */
      .pl-expanded-sides{grid-template-columns:1fr!important;gap:10px!important;}
      .pl-expanded-actions{grid-template-columns:1fr!important;gap:8px!important;}

      /* ── TRADE CALC ── */
      .pl-trade-calc-grid{grid-template-columns:1fr 1fr!important;gap:8px!important;}

      /* ── WAGER ROW — Mobile Optimized ── */
      .pl-wager-row{flex-direction:column!important;align-items:stretch!important;gap:10px!important;}
      .pl-wager-row>div:first-child{
        display:flex!important;
        flex-wrap:wrap!important;
        align-items:center!important;
        gap:8px!important;
      }
      .pl-wager-row>div:first-child>div:has(input[type=number]){
        width:100%!important;
        order:-1!important;
        margin-bottom:4px!important;
      }
      .pl-wager-row>div:first-child>div:has(input[type=number]) input{
        width:100%!important;
        font-size:16px!important;
        padding:12px 14px 12px 28px!important;
        border-radius:12px!important;
        min-height:48px!important;
      }
      .pl-wager-row>div:first-child>button{
        flex:1 1 auto!important;
        min-width:0!important;
        padding:10px 6px!important;
        border-radius:10px!important;
        font-size:10px!important;
        min-height:40px!important;
        justify-content:center!important;
        text-align:center!important;
      }
      .pl-wager-row>div:first-child>span{
        width:100%!important;
        order:-2!important;
      }

      /* ── METRIC BAR — Keep horizontal on mobile ── */
      .pl-metric-bar{grid-template-columns:1fr 1fr 1fr!important;gap:0!important;}
      .pl-metric-bar>div{padding:10px 8px!important;}
      .pl-metric-bar>div>div:first-child{font-size:8px!important;letter-spacing:1.5px!important;margin-bottom:2px!important;}
      .pl-metric-bar>div>div:last-child{font-size:15px!important;}

      /* ── HERO SECTION ── */
      .pl-hero-title{font-size:clamp(26px,6.5vw,42px)!important;letter-spacing:-1px!important;}
      .pl-hero-glass-text{font-size:clamp(30px,8vw,72px)!important;letter-spacing:-0.5px!important;}
      .pl-hero-sub{font-size:14px!important;line-height:1.65!important;margin-bottom:48px!important;}

      /* ── HOW IT WORKS — Stack vertically ── */
      .pl-steps-grid{grid-template-columns:1fr!important;gap:12px!important;max-width:100%!important;}

      /* ── PRICING CARDS ── */
      .pl-pricing-grid{grid-template-columns:1fr!important;max-width:400px!important;margin:0 auto!important;}

      /* ── PAIR SELECTOR ── */
      .pl-pair-selector{padding:12px 16px!important;}
      .pl-pair-selector>div{gap:6px!important;}
      .pl-pair-selector button{padding:8px 14px!important;font-size:10px!important;min-height:36px!important;}

      /* ── FOOTER ── */
      .pl-footer-inner{flex-direction:column!important;text-align:center!important;gap:12px!important;}
      .pl-footer-inner>div:first-child{flex-direction:column!important;align-items:center!important;gap:10px!important;}
      .pl-footer-links{justify-content:center!important;flex-wrap:wrap!important;}
      .pl-footer-links button{padding:8px 16px!important;font-size:12px!important;min-height:40px!important;}
      .pl-footer-social{justify-content:center!important;}

      /* ── KEYBOARD SHORTCUT BUTTON — hide on mobile ── */
      .pl-kbd-hint{display:none!important;}

      /* ── MODAL — Full width on mobile ── */
      .pl-legal-modal{width:calc(100% - 24px)!important;max-height:90vh!important;border-radius:20px!important;max-width:none!important;}
      .pl-legal-modal>div:first-child{padding:20px 20px 12px!important;}
      .pl-legal-modal>div:last-child{padding:8px 20px 24px!important;}
      .pl-waitlist-modal{width:calc(100% - 32px)!important;max-width:none!important;padding:32px 24px!important;border-radius:20px!important;margin:16px!important;}
      .pl-waitlist-modal input{font-size:16px!important;padding:16px!important;border-radius:14px!important;}
      .pl-waitlist-modal button[type=submit],
      .pl-waitlist-modal>button:last-of-type:not([style*="position:absolute"]){
        padding:16px 0!important;font-size:15px!important;min-height:52px!important;
      }

      /* ── SHORTCUT MODAL ── */
      .pl-shortcuts-modal{width:calc(100% - 32px)!important;padding:24px!important;border-radius:18px!important;}

      /* ── CATEGORY PILLS — Horizontal scroll ── */
      .pl-cat-pills{
        flex-wrap:nowrap!important;
        overflow-x:auto!important;
        -webkit-overflow-scrolling:touch!important;
        scrollbar-width:none!important;
        -ms-overflow-style:none!important;
        padding-bottom:4px!important;
        margin:0 -16px 6px!important;
        padding:0 16px 8px!important;
      }
      .pl-cat-pills::-webkit-scrollbar{display:none!important;}
      .pl-cat-pills>button{flex-shrink:0!important;padding:8px 16px!important;font-size:10px!important;min-height:36px!important;}
      .pl-cat-pills>div{flex-shrink:0!important;}

      /* ── COPY / ACTION BUTTONS in expanded ── */
      .pl-copy-btn,.pl-steps-btn{
        width:100%!important;
        padding:14px 16px!important;
        font-size:12px!important;
        min-height:48px!important;
        border-radius:12px!important;
        justify-content:center!important;
      }

      /* ── ORDER BOOK — compact on mobile ── */
      .pl-order-book-mobile svg{height:180px!important;}

      /* ── INPUT ZOOM PREVENTION (iOS) ── */
      input[type=text],input[type=email],input[type=number],input[type=search],select,textarea{font-size:16px!important;}

      /* ── LOADING SCREEN — mobile sized ── */
      .pl-loading-pct{font-size:40px!important;letter-spacing:-1px!important;}
      .pl-loading-bar{width:220px!important;}
      .pl-loading-status{font-size:10px!important;}

      /* ── SMOOTH TOUCH SCROLLING ── */
      .pl-mobile-cards{-webkit-overflow-scrolling:touch!important;}

      /* ── FROSTED NAV SEPARATOR ── */
      nav::after{
        content:'';
        position:absolute;
        bottom:0;left:0;right:0;
        height:1px;
        background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),rgba(255,255,255,0.08),rgba(255,255,255,0.06),transparent);
      }
    }

    /* ─── SMALL PHONES (≤420px) — Extra compact ─── */
    @media(max-width:420px){
      nav>div{padding:0 12px!important;}
      .pl-signal-card{padding:16px 14px!important;}
      .pl-signal-card>div:last-child>div:first-child{font-size:28px!important;}
      .pl-signal-card>div:last-child>button{padding:12px 18px!important;font-size:10px!important;}
      .pl-mobile-card-item>div:first-child{padding:14px 12px!important;}
      .pl-hero-title{font-size:clamp(22px,7vw,32px)!important;}
      .pl-hero-glass-text{font-size:clamp(26px,9vw,48px)!important;}
      .pl-hero-sub{font-size:13px!important;}
      .pl-metric-bar>div{padding:8px 6px!important;}
      .pl-metric-bar>div>div:last-child{font-size:13px!important;}
      .pl-wager-row>div:first-child>button{padding:8px 4px!important;font-size:9px!important;}
      .pl-expanded-sides>div{border-radius:10px!important;}
      .pl-filter-grid>div{padding:12px 14px!important;}
      .pl-dash-content{padding:12px 10px!important;}
    }

    .pl-mobile-cards{display:none;}
    /* Touch active states for mobile interaction feedback */
    @media(max-width:768px){
      .pl-mobile-card-item>div:first-child:active{
        transform:scale(0.985)!important;
        transition:transform 0.1s ease!important;
      }
      .pl-cat-pills>button:active{
        transform:scale(0.95)!important;
        opacity:0.8!important;
      }
      .pl-expanded-actions>button:active{
        transform:scale(0.97)!important;
        opacity:0.85!important;
      }
    }
    .pl-glass-btn:hover .pl-arrow-icon{transform:translateX(3px);}
    .pl-arrow-icon{transition:transform 200ms ease;}
    *{margin:0;padding:0;box-sizing:border-box;}
    html{scroll-behavior:smooth;}
    body{background:${T.bg};color:${T.text};font-family:${T.body};overflow-x:hidden;-webkit-font-smoothing:antialiased;}
    ::selection{background:rgba(255,255,255,0.12);color:${T.text};}
    ::-webkit-scrollbar{width:6px;}
    ::-webkit-scrollbar-track{background:transparent;}
    ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:3px;}
    input::placeholder{color:${T.textPlaceholder};}
    input[type=range]{-webkit-appearance:none;appearance:none;background:linear-gradient(90deg,rgba(255,255,255,0.08),rgba(255,255,255,0.18));height:5px;border-radius:3px;cursor:pointer;width:100%;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,0.3);}
    input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:20px;border-radius:50%;background:#ffffff;border:2px solid rgba(255,255,255,0.35);box-shadow:0 2px 8px rgba(0,0,0,0.3),0 0 0 1px rgba(255,255,255,0.10);margin-top:0;cursor:pointer;}
    input[type=range]::-moz-range-track{height:5px;border-radius:3px;background:linear-gradient(90deg,rgba(255,255,255,0.08),rgba(255,255,255,0.18));border:none;box-shadow:inset 0 1px 2px rgba(0,0,0,0.3);}
    input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#ffffff;border:2px solid rgba(255,255,255,0.35);box-shadow:0 2px 8px rgba(0,0,0,0.3),0 0 0 1px rgba(255,255,255,0.10);cursor:pointer;}
  `}</style>
);

// ─── LOADING SCREEN ────────────────────────────────────────
const LoadingScreen = ({onDone}) => {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState(0); // 0=loading, 1=complete, 2=fadeout
  useEffect(()=>{
    let frame; const start=Date.now(); const dur=1800;
    const tick=()=>{
      const elapsed=Date.now()-start;
      const p=Math.min(elapsed/dur,1);
      // Ease with brief pauses at 30% and 70%
      let eased;
      if(p<0.3) eased=p/0.3*0.3;
      else if(p<0.35) eased=0.3;
      else if(p<0.65) eased=0.3+((p-0.35)/0.3)*0.4;
      else if(p<0.69) eased=0.7;
      else eased=0.7+((p-0.69)/0.31)*0.3;
      setProgress(Math.floor(eased*100));
      if(p<1){frame=requestAnimationFrame(tick);}
      else{setPhase(1);setTimeout(()=>{setPhase(2);setTimeout(onDone,400);},200);}
    };
    frame=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(frame);
  },[onDone]);

  return (
    <div style={{
      position:"fixed",inset:0,zIndex:9999,
      background:"transparent",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
      opacity:phase===2?0:1,
      transition:"opacity 0.4s cubic-bezier(0.4,0,0.2,1)",
    }}>

      <div style={{position:"relative",zIndex:1,textAlign:"center"}}>
        {/* Logo with scale-in animation */}
        <div style={{animation:"loadLogo 1.4s cubic-bezier(0.16,1,0.3,1)",marginBottom:56}}>
          <img src={LOGO_SRC} alt="prophetLabs" style={{height:64,width:"auto",filter:"brightness(0) invert(1)"}} draggable={false}/>
        </div>

        {/* Progress bar */}
        <div className="pl-loading-bar" style={{width:280,height:2,borderRadius:1,background:"rgba(255,255,255,0.06)",overflow:"hidden",marginBottom:20,position:"relative",boxShadow:"inset 0 1px 2px rgba(0,0,0,0.3)",margin:"0 auto 20px"}}>
          <div style={{height:"100%",borderRadius:1,background:"linear-gradient(90deg, #FF3366, #FF8844, #FFCC33, #33DD88, #33CCEE, #4C8BF5, #A855F7, #DD44AA)",backgroundSize:"300% 100%",animation:"aShift 2s linear infinite",width:`${progress}%`,transition:"width 0.15s linear"}}/>
        </div>

        {/* Percentage counter — large with color spectrum */}
        <div className="pl-loading-pct" style={{fontFamily:T.mono,fontSize:56,fontWeight:300,letterSpacing:"-2px",marginBottom:14,
          color:progress<12?'#FF3366':progress<25?'#FF8844':progress<37?'#FFCC33':progress<50?'#33DD88':progress<62?'#33CCEE':progress<75?'#4C8BF5':progress<87?'#A855F7':'#DD44AA',
          transition:"color 0.8s ease"
        }}>
          {progress}%
        </div>

        {/* Status text */}
        <div className="pl-loading-status" style={{fontFamily:T.body,fontSize:11,color:T.textTertiary,letterSpacing:1,fontWeight:400,opacity:phase===1?1:0.6,transition:"opacity 0.3s"}}>
          {progress<30?"Connecting to markets...":progress<70?"Scanning prediction platforms...":progress<100?"Analyzing arbitrage signals...":"Ready"}
        </div>
      </div>
    </div>
  );
};

// ─── DEPTH FIELD — Parallax data-point particles ─────────
const DepthField = () => {
  const canvasRef = useRef(null);
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let w, h;
    const dpr = Math.min(window.devicePixelRatio, 2);
    let mouse = { x: 0.5, y: 0.5 };
    let sm = { x: 0.5, y: 0.5 };

    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const onMM = (e) => { mouse.x = e.clientX / window.innerWidth; mouse.y = e.clientY / window.innerHeight; };
    const onML = () => { mouse.x = 0.5; mouse.y = 0.5; };
    window.addEventListener("mousemove", onMM);
    window.addEventListener("mouseleave", onML);

    // 3 depth layers — all pushed further from screen for subtlety
    const layers = [
      { count: 35, speed: 0.10, size: 0.7, alpha: 0.22, parallax: 3,  drift: 0.06, glow: 2 },
      { count: 22,  speed: 0.18, size: 1.1, alpha: 0.35, parallax: 8, drift: 0.10, glow: 3 },
      { count: 12,  speed: 0.30, size: 1.6, alpha: 0.48, parallax: 16, drift: 0.16, glow: 5 },
    ];

    // Init particles per layer
    const particles = layers.map(L =>
      Array.from({ length: L.count }, () => ({
        x: Math.random(),
        y: Math.random(),
        vx: (0.3 + Math.random() * 0.7) * L.speed,
        vy: (Math.random() - 0.5) * 0.15 * L.speed,
        phase: Math.random() * Math.PI * 2,
        size: L.size * (0.6 + Math.random() * 0.8),
        flicker: 0.7 + Math.random() * 0.3,
      }))
    );

    let aid;
    const anim = (t) => {
      aid = requestAnimationFrame(anim);
      if (document.hidden) return;
      const tm = t * 0.001;
      const dt = 0.016; // ~60fps

      sm.x += (mouse.x - sm.x) * 0.04;
      sm.y += (mouse.y - sm.y) * 0.04;
      // Parallax offset from center
      const px = (sm.x - 0.5);
      const py = (sm.y - 0.5);

      ctx.clearRect(0, 0, w, h);

      for (let li = 0; li < layers.length; li++) {
        const L = layers[li];
        const pts = particles[li];
        const offsetX = px * L.parallax;
        const offsetY = py * L.parallax;

        // Update + draw particles
        for (const p of pts) {
          // Horizontal drift + vertical sine bob
          p.x += p.vx * dt * 0.03;
          p.y += Math.sin(tm * 0.5 + p.phase) * 0.0003 * L.drift;

          // Wrap horizontally
          if (p.x > 1.15) { p.x = -0.15; p.y = Math.random(); }

          const sx = p.x * w + offsetX;
          const sy = p.y * h + offsetY;

          // Gentle flicker
          const flick = p.flicker + Math.sin(tm * 1.2 + p.phase) * 0.15;
          const a = L.alpha * flick;

          // Star-like glow aura — subtle depth
          const glowR = p.size + L.glow;
          const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
          glow.addColorStop(0, `rgba(255,255,255,${a * 0.25})`);
          glow.addColorStop(0.3, `rgba(240,245,255,${a * 0.08})`);
          glow.addColorStop(1, `rgba(255,255,255,0)`);
          ctx.fillStyle = glow;
          ctx.fillRect(sx - glowR, sy - glowR, glowR * 2, glowR * 2);

          ctx.beginPath();
          ctx.arc(sx, sy, p.size, 0, 6.283);
          ctx.fillStyle = `rgba(255,255,255,${a})`;
          ctx.fill();
        }

        // Sparse connections — only between close neighbours in same layer
        if (li >= 0) { // connections on all layers
          const connDist = li === 0 ? 60 : li === 1 ? 90 : 115;
          const connAlpha = li === 0 ? 0.025 : li === 1 ? 0.055 : 0.09;
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const ax = a.x * w + offsetX;
            const ay = a.y * h + offsetY;
            let conns = 0;
            for (let j = i + 1; j < pts.length && conns < 3; j++) {
              const b = pts[j];
              const bx = b.x * w + offsetX;
              const by = b.y * h + offsetY;
              const dx = ax - bx, dy = ay - by;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < connDist) {
                const fade = 1 - d / connDist;
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                ctx.strokeStyle = `rgba(255,255,255,${connAlpha * fade})`;
                ctx.lineWidth = 0.8 + li * 0.25;
                ctx.stroke();
                conns++;
              }
            }
          }
        }
      }

      // Cursor proximity glow — soft halo around mouse
      if (sm.x > 0.02 && sm.x < 0.98) {
        const cx = sm.x * w, cy = sm.y * h;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 180);
        g.addColorStop(0, "rgba(255,255,255,0.02)");
        g.addColorStop(0.5, "rgba(255,255,255,0.007)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(cx - 180, cy - 180, 360, 360);
      }
    };

    const onVisChange = () => { if (!document.hidden) { aid = requestAnimationFrame(anim); } };
    document.addEventListener("visibilitychange", onVisChange);
    aid = requestAnimationFrame(anim);
    return () => {
      cancelAnimationFrame(aid);
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("mousemove", onMM);
      window.removeEventListener("mouseleave", onML);
      window.removeEventListener("resize", resize);
    };
  }, []);
  if (reducedMotion) return null;
  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
};

const Watermark=({disabled})=>(
  <div style={{position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",zIndex:1,pointerEvents:"none",opacity:disabled?0:0.025,userSelect:"none",transition:"opacity 0.4s ease"}}>
    <img src={LOGO_MINI_SRC} alt="" style={{width:500,height:"auto",filter:"brightness(0) invert(1)"}} draggable={false}/>
  </div>
);

// ─── AURORA — multi-color rainbow, immersive ─────────────────
const Aurora=({disabled})=>{
  if(disabled)return <div style={{position:"fixed",inset:0,zIndex:1,pointerEvents:"none",background:"radial-gradient(ellipse 80% 60% at 50% 40%, rgba(255,255,255,0.03) 0%, rgba(120,140,180,0.02) 40%, transparent 70%)"}}/>;
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reducedMotion)return <div style={{position:"fixed",inset:0,zIndex:1,pointerEvents:"none",background:"radial-gradient(ellipse 80% 60% at 50% 40%, rgba(255,255,255,0.03) 0%, rgba(120,140,180,0.02) 40%, transparent 70%)"}}/>;
  return(
  <div style={{position:"fixed",inset:0,zIndex:1,pointerEvents:"none",overflow:"hidden"}}>
    {/* ══ CRIMSON / RED — far left ══ */}
    <div style={{position:"absolute",top:"-45%",left:"-30%",width:"55%",height:"100%",background:"radial-gradient(ellipse 65% 50% at 20% 45%, rgba(220,40,60,0.16) 0%, rgba(220,40,60,0.05) 35%, transparent 60%)",animation:"a1 16s ease-in-out infinite, af1 10s ease-in-out infinite",filter:"blur(44px)",willChange:"transform,opacity"}}/>
    {/* ══ ORANGE / AMBER ══ */}
    <div style={{position:"absolute",top:"-25%",left:"-5%",width:"45%",height:"90%",background:"radial-gradient(ellipse 55% 45% at 30% 42%, rgba(255,140,30,0.14) 0%, rgba(255,160,60,0.05) 30%, transparent 58%)",animation:"a2 20s ease-in-out infinite, af2 12s ease-in-out infinite",filter:"blur(40px)",willChange:"transform,opacity"}}/>
    {/* ══ GOLDEN YELLOW ══ */}
    <div style={{position:"absolute",top:"-20%",left:"12%",width:"42%",height:"80%",background:"radial-gradient(ellipse 50% 40% at 38% 48%, rgba(255,210,60,0.12) 0%, rgba(255,220,80,0.04) 35%, transparent 58%)",animation:"a3 22s ease-in-out infinite, af3 14s ease-in-out infinite",filter:"blur(46px)",willChange:"transform,opacity"}}/>
    {/* ══ EMERALD GREEN ══ */}
    <div style={{position:"absolute",top:"-15%",left:"25%",width:"45%",height:"85%",background:"radial-gradient(ellipse 55% 42% at 45% 44%, rgba(30,200,120,0.14) 0%, rgba(40,220,140,0.05) 32%, transparent 58%)",animation:"a1 24s ease-in-out infinite reverse, af1 16s ease-in-out infinite",filter:"blur(42px)",willChange:"transform,opacity"}}/>
    {/* ══ CYAN / TEAL ══ */}
    <div style={{position:"absolute",top:"-30%",left:"38%",width:"45%",height:"90%",background:"radial-gradient(ellipse 55% 45% at 52% 45%, rgba(30,200,220,0.15) 0%, rgba(40,210,230,0.05) 30%, transparent 58%)",animation:"a2 18s ease-in-out infinite, af2 13s ease-in-out infinite",filter:"blur(44px)",willChange:"transform,opacity"}}/>
    {/* ══ SAPPHIRE BLUE ══ */}
    <div style={{position:"absolute",top:"-20%",left:"50%",width:"50%",height:"85%",background:"radial-gradient(ellipse 60% 45% at 60% 44%, rgba(46,92,255,0.16) 0%, rgba(70,120,255,0.06) 32%, transparent 58%)",animation:"a3 26s ease-in-out infinite, af3 17s ease-in-out infinite",filter:"blur(40px)",willChange:"transform,opacity"}}/>
    {/* ══ VIOLET / PURPLE ══ */}
    <div style={{position:"absolute",top:"-25%",left:"62%",width:"45%",height:"88%",background:"radial-gradient(ellipse 55% 42% at 68% 45%, rgba(140,60,220,0.15) 0%, rgba(168,85,247,0.05) 35%, transparent 58%)",animation:"a1 22s ease-in-out infinite, af1 15s ease-in-out infinite",filter:"blur(46px)",willChange:"transform,opacity"}}/>
    {/* ══ MAGENTA / PINK — far right ══ */}
    <div style={{position:"absolute",top:"-35%",left:"72%",width:"55%",height:"95%",background:"radial-gradient(ellipse 60% 50% at 80% 44%, rgba(220,60,140,0.14) 0%, rgba(240,80,160,0.05) 30%, transparent 58%)",animation:"a2 20s ease-in-out infinite reverse, af2 11s ease-in-out infinite",filter:"blur(42px)",willChange:"transform,opacity"}}/>
    {/* ══ BLEND ZONES — rainbow interplay ══ */}
    <div style={{position:"absolute",top:"-15%",left:"10%",width:"80%",height:"75%",background:"radial-gradient(ellipse 70% 40% at 50% 45%, rgba(60,220,200,0.06) 0%, rgba(120,80,255,0.04) 35%, transparent 60%)",animation:"a3 30s ease-in-out infinite, af3 20s ease-in-out infinite",filter:"blur(55px)",willChange:"transform,opacity"}}/>
    {/* ══ ATMOSPHERIC — white corona ══ */}
    <div style={{position:"absolute",top:"-50%",left:"-20%",width:"140%",height:"80%",background:"radial-gradient(ellipse 90% 50% at 50% 50%, rgba(255,255,255,0.04) 0%, rgba(200,210,230,0.02) 35%, transparent 60%)",animation:"a1 34s ease-in-out infinite, af1 22s ease-in-out infinite",filter:"blur(60px)",willChange:"transform,opacity"}}/>
    {/* Low-horizon rainbow wash */}
    <div style={{position:"absolute",top:"40%",left:"0%",width:"100%",height:"65%",background:"radial-gradient(ellipse 100% 40% at 50% 80%, rgba(220,40,60,0.04) 0%, rgba(255,180,40,0.03) 15%, rgba(40,220,140,0.04) 30%, rgba(30,180,230,0.04) 50%, rgba(140,60,220,0.04) 70%, rgba(220,60,140,0.03) 85%, transparent 100%)",animation:"a2 20s ease-in-out infinite reverse, af2 14s ease-in-out infinite",filter:"blur(65px)",willChange:"transform,opacity"}}/>
  </div>
  );
};

// ─── AURORA CURTAIN — Rainbow northern lights from top ──
const AuroraCurtain=({disabled})=>{
  if(disabled)return <div style={{position:"fixed",top:0,left:0,right:0,height:"20vh",zIndex:2,pointerEvents:"none",background:"linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)"}}/>;
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reducedMotion)return <div style={{position:"fixed",top:0,left:0,right:0,height:"20vh",zIndex:2,pointerEvents:"none",background:"linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)"}}/>;
  return(
  <div style={{position:"fixed",top:0,left:0,right:0,height:"60vh",zIndex:2,pointerEvents:"none",overflow:"hidden",maskImage:"linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.6) 30%, rgba(0,0,0,0.15) 65%, transparent 100%)",WebkitMaskImage:"linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.6) 30%, rgba(0,0,0,0.15) 65%, transparent 100%)"}}>
    <div style={{position:"absolute",top:"-8%",left:"2%",width:"18%",height:"110%",background:"linear-gradient(180deg, rgba(220,40,60,0.22) 0%, rgba(220,40,60,0.08) 35%, transparent 70%)",animation:"curtainSway1 12s ease-in-out infinite, af1 8s ease-in-out infinite",filter:"blur(18px)",borderRadius:"0 0 50% 50%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-5%",left:"14%",width:"16%",height:"105%",background:"linear-gradient(180deg, rgba(255,140,30,0.20) 0%, rgba(255,160,60,0.08) 35%, transparent 70%)",animation:"curtainSway2 16s ease-in-out infinite, af2 11s ease-in-out infinite",filter:"blur(20px)",borderRadius:"0 0 40% 40%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-6%",left:"25%",width:"16%",height:"108%",background:"linear-gradient(180deg, rgba(255,210,60,0.18) 0%, rgba(255,220,80,0.07) 35%, transparent 70%)",animation:"curtainSway3 14s ease-in-out infinite, af3 10s ease-in-out infinite",filter:"blur(18px)",borderRadius:"0 0 45% 45%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-4%",left:"36%",width:"16%",height:"106%",background:"linear-gradient(180deg, rgba(30,200,120,0.20) 0%, rgba(40,220,140,0.08) 35%, transparent 70%)",animation:"curtainSway1 18s ease-in-out infinite reverse, af1 13s ease-in-out infinite",filter:"blur(20px)",borderRadius:"0 0 45% 45%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-10%",left:"46%",width:"18%",height:"112%",background:"linear-gradient(180deg, rgba(30,200,220,0.18) 0%, rgba(40,210,230,0.10) 20%, transparent 60%)",animation:"curtainSway2 15s ease-in-out infinite, af2 9s ease-in-out infinite",filter:"blur(16px)",borderRadius:"0 0 50% 50%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-5%",left:"58%",width:"18%",height:"108%",background:"linear-gradient(180deg, rgba(46,92,255,0.24) 0%, rgba(70,120,255,0.10) 30%, transparent 65%)",animation:"curtainSway3 13s ease-in-out infinite, af1 12s ease-in-out infinite",filter:"blur(19px)",borderRadius:"0 0 45% 45%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-7%",left:"70%",width:"16%",height:"106%",background:"linear-gradient(180deg, rgba(140,60,220,0.20) 0%, rgba(168,85,247,0.08) 35%, transparent 70%)",animation:"curtainSway1 17s ease-in-out infinite, af3 14s ease-in-out infinite",filter:"blur(22px)",borderRadius:"0 0 40% 40%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-4%",left:"82%",width:"16%",height:"104%",background:"linear-gradient(180deg, rgba(220,60,140,0.18) 0%, rgba(240,80,160,0.06) 35%, transparent 70%)",animation:"curtainSway2 14s ease-in-out infinite reverse, af2 10s ease-in-out infinite",filter:"blur(20px)",borderRadius:"0 0 50% 50%",transformOrigin:"top center",willChange:"transform,opacity"}}/>
    <div style={{position:"absolute",top:"-2px",left:0,right:0,height:"8%",background:"linear-gradient(90deg, rgba(220,40,60,0.10) 0%, rgba(255,140,30,0.10) 14%, rgba(255,210,60,0.12) 28%, rgba(30,200,120,0.12) 42%, rgba(30,200,220,0.14) 56%, rgba(46,92,255,0.14) 70%, rgba(140,60,220,0.12) 84%, rgba(220,60,140,0.10) 100%)",filter:"blur(8px)",animation:"af1 7s ease-in-out infinite"}}/>
  </div>
  );
};

// ─── SHARED COMPONENTS ─────────────────────────────────────
const Logo=({size="md"})=>{const h=size==="lg"?54:38;return <img src={LOGO_SRC} alt="prophetLabs" style={{height:h,width:"auto",filter:"brightness(0) invert(1)"}} draggable={false}/>;};

const LiveDot=({secondsAgo,reconnecting}={})=>(
  <span style={{display:"inline-flex",alignItems:"center",gap:7,padding:"5px 16px",borderRadius:100,background:"rgba(255,255,255,0.025)",backdropFilter:T.glassBlur,border:"none",boxShadow:"0 4px 20px rgba(0,0,0,0.3), 0 0 16px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.10)",animation:"livePulse 2s ease-in-out infinite"}}>
    <span style={{width:7,height:7,borderRadius:"50%",background:reconnecting?"#D4A843":"#34C759",boxShadow:reconnecting?"0 0 8px rgba(212,168,67,0.5)":"0 0 8px rgba(52,199,89,0.4), 0 0 14px rgba(52,199,89,0.15)",animation:reconnecting?"pulse 1s ease-in-out infinite":"none"}}/>
    <span style={{fontSize:10,color:reconnecting?"#D4A843":"#34C759",fontWeight:700,letterSpacing:reconnecting?1:2,fontFamily:T.mono}}>{reconnecting?"Reconnecting...":"LIVE"}</span>
    {secondsAgo!=null&&!reconnecting&&<span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,letterSpacing:0.3,marginLeft:2}}>· Updated {secondsAgo}s ago</span>}
  </span>
);

const Counter=({end,suffix="",prefix="",duration=2000})=>{
  const[count,setCount]=useState(0);const ref=useRef(null);const started=useRef(false);
  useEffect(()=>{const obs=new IntersectionObserver(([e])=>{if(e.isIntersecting&&!started.current){started.current=true;const s=Date.now();const tick=()=>{const p=Math.min((Date.now()-s)/duration,1);setCount(Math.floor((1-Math.pow(1-p,3))*end));if(p<1)requestAnimationFrame(tick);};tick();}},{threshold:0.3});if(ref.current)obs.observe(ref.current);return()=>obs.disconnect();},[end,duration]);
  return <span ref={ref}>{prefix}{count.toLocaleString()}{suffix}</span>;
};

// Glass Card with extreme frosted glass
const Card=({children,style={},hover=true,accent=false,className})=>(
  <div className={className} style={{
    background:accent?"rgba(255,255,255,0.042)":T.card, backdropFilter:T.blur,
    WebkitBackdropFilter:T.blur,
    border:"none",
    borderRadius:22,
    boxShadow:accent?`${T.cardShadow}, 0 0 48px rgba(255,255,255,0.05)`:T.cardShadow,
    transition:"all 0.35s cubic-bezier(0.25,0.46,0.45,0.94)",
    ...style
  }}
  onMouseOver={e=>{if(hover){e.currentTarget.style.background=accent?"rgba(255,255,255,0.060)":T.cardHover;e.currentTarget.style.boxShadow=T.cardGlow;e.currentTarget.style.transform="translateY(-3px)";}}}
  onMouseOut={e=>{if(hover){e.currentTarget.style.background=accent?"rgba(255,255,255,0.042)":T.card;e.currentTarget.style.boxShadow=accent?`${T.cardShadow}, 0 0 48px rgba(255,255,255,0.05)`:T.cardShadow;e.currentTarget.style.transform="translateY(0)";}}}
  >{children}</div>
);

const GlassBtn=({children,primary=false,onClick,style={}})=>(
  <button className="pl-glass-btn" onClick={onClick} style={{
    background:primary?"#ffffff":"rgba(255,255,255,0.025)",
    backdropFilter:primary?"none":"blur(52px) saturate(1.35)",
    WebkitBackdropFilter:primary?"none":"blur(52px) saturate(1.35)",
    color:primary?"#000":T.positive,
    border:"none",
    padding:"13px 36px",borderRadius:980,fontWeight:600,fontSize:14,cursor:"pointer",
    fontFamily:T.body,display:"inline-flex",alignItems:"center",gap:8,
    transition:"all 0.3s",letterSpacing:"-0.2px",
    boxShadow:primary?"0 4px 24px rgba(0,0,0,0.3), 0 0 20px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.2)":"0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(255,255,255,0.03), 0 0 0 0.5px rgba(255,255,255,0.06)",
    ...style
  }}
  onMouseOver={e=>{e.currentTarget.style.transform="scale(1.04)";e.currentTarget.style.boxShadow=primary?"0 8px 40px rgba(0,0,0,0.35), 0 0 32px rgba(255,255,255,0.18), inset 0 1px 0 rgba(255,255,255,0.3)":"0 8px 40px rgba(0,0,0,0.4), 0 0 24px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.10)";}}
  onMouseOut={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.boxShadow=primary?"0 4px 24px rgba(0,0,0,0.3), 0 0 20px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.2)":"0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -1px 0 rgba(255,255,255,0.02)";}}
  >{children}</button>
);

// Icons
const IA=()=><svg className="pl-arrow-icon" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>;
const IC=()=><svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>;
const IS=()=><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><circle cx="12" cy="12" r="4"/></svg>;
const IB=()=><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
const IBe=()=><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>;
const ISh=()=><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
const ICh=()=><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>;
const IG=()=><svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/></svg>;
const ICl=()=><svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>;
const IF=()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 23c-4.97 0-9-3.58-9-8 0-3.19 2.13-6.04 4-8 0 0 1 3 3 4 0-5 3-9 6-11 0 3 1.5 5 3 6.5C20.5 8.5 21 10.5 21 13c0 5.5-4.03 10-9 10z" fill="url(#fg2)" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5"/><defs><linearGradient id="fg2" x1="12" y1="2" x2="12" y2="23" gradientUnits="userSpaceOnUse"><stop stopColor="#ffffff"/><stop offset="1" stopColor="#cccccc"/></linearGradient></defs></svg>;

// ─── TRADE CALC ────────────────────────────────────────────
const IChevron=({expanded})=><svg aria-label={expanded?"Collapse details":"Expand details"} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{transform:expanded?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.3s ease"}}><polyline points="6 9 12 15 18 9"/></svg>;

// ─── SHARED FOOTER ────────────────────────────────────────
// ─── LEGAL / CONTACT MODAL ────────────────────────────────
const LEGAL_CONTENT={
  "Terms of Service":{
    icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
    updated:"March 1, 2026",
    sections:[
      {t:"1. Acceptance of Terms",p:"By accessing or using prophetLabs (the \"Service\"), you agree to be bound by these Terms of Service. If you do not agree to all terms, you may not access the Service. We reserve the right to modify these terms at any time, and your continued use constitutes acceptance of any changes."},
      {t:"2. Service Description",p:"prophetLabs is an informational tool that scans publicly available prediction markets to identify potential arbitrage opportunities. The Service aggregates pricing data from third-party platforms including, but not limited to, Polymarket, Opinion Labs, Kalshi, and Predict. prophetLabs does not execute trades, hold funds, or act as a financial intermediary."},
      {t:"3. No Financial Advice",p:"Nothing provided by prophetLabs constitutes financial, investment, legal, or tax advice. All data, calculations, APR projections, and spread analyses are for informational and educational purposes only. You are solely responsible for evaluating the risks and merits of any trade. Past performance or projected returns do not guarantee future results."},
      {t:"4. Data Accuracy",p:"While we strive to provide accurate and timely data, prophetLabs makes no warranties regarding the completeness, reliability, or accuracy of any information displayed. Market data is sourced from third-party APIs and may experience latency, errors, or interruptions. You acknowledge that pricing discrepancies shown may no longer exist at the time of execution."},
      {t:"5. Eligibility & Compliance",p:"You represent that you are of legal age in your jurisdiction and that your use of prediction markets complies with all applicable local, state, national, and international laws and regulations. prophetLabs does not verify the legality of prediction market participation in your jurisdiction. It is your sole responsibility to ensure compliance."},
      {t:"6. Account & Access",p:"Certain features of the Service may require registration. You agree to provide accurate information and maintain the security of your credentials. We reserve the right to suspend or terminate accounts that violate these terms, engage in abusive behavior, or attempt to manipulate or reverse-engineer the Service."},
      {t:"7. Intellectual Property",p:"All content, code, design, branding, algorithms, and data compilations within prophetLabs are the exclusive property of prophetLabs or its licensors. You may not reproduce, distribute, modify, or create derivative works without prior written consent. The prophetLabs name, logo, and associated marks are trademarks of the company."},
      {t:"8. Limitation of Liability",p:"To the fullest extent permitted by law, prophetLabs and its affiliates, officers, employees, and agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service, including but not limited to financial losses from trades, data inaccuracies, or service interruptions."},
      {t:"9. Third-Party Platforms",p:"prophetLabs is not affiliated with, endorsed by, or responsible for any third-party prediction market platform. Links or references to external platforms are provided for convenience only. Your interaction with third-party services is governed by their respective terms and policies."},
      {t:"10. Governing Law",p:"These Terms shall be governed by and construed in accordance with the laws of the State of Delaware, United States, without regard to conflict of law principles. Any disputes arising from these Terms shall be resolved exclusively in the courts of Delaware."},
    ]
  },
  "Privacy Policy":{
    icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    updated:"March 1, 2026",
    sections:[
      {t:"1. Information We Collect",p:"We collect information you provide directly, such as your email address when joining our waitlist, and usage data collected automatically through cookies and analytics tools. This includes device type, browser information, IP address, pages visited, time spent on the Service, and interaction patterns. We do not collect financial account credentials or execute transactions on your behalf."},
      {t:"2. How We Use Your Information",p:"We use the information we collect to operate, maintain, and improve the Service; to communicate with you about updates, features, and promotional offers; to analyze usage patterns and optimize user experience; to detect and prevent fraud or abuse; and to comply with legal obligations. We will never sell your personal data to third parties for advertising purposes."},
      {t:"3. Data Storage & Security",p:"Your data is stored on secure, encrypted servers. We implement industry-standard security measures including TLS encryption, access controls, and regular security audits. However, no method of transmission over the Internet is 100% secure, and we cannot guarantee absolute security. Waitlist data and user preferences are stored with AES-256 encryption at rest."},
      {t:"4. Cookies & Tracking",p:"prophetLabs uses essential cookies to maintain session state and user preferences (such as effects settings and saved markets). We may use analytics cookies to understand how users interact with the Service. You can disable cookies through your browser settings, though some features may not function properly without them. We do not use third-party advertising trackers."},
      {t:"5. Third-Party Services",p:"We may share anonymized, aggregated data with analytics providers to improve the Service. When you interact with links to third-party prediction markets (e.g., Polymarket, Kalshi), those platforms have their own privacy policies. We encourage you to review them. We are not responsible for the privacy practices of external platforms."},
      {t:"6. Data Retention",p:"We retain your personal information only for as long as necessary to fulfill the purposes described in this policy, or as required by law. Waitlist data is retained until you request removal or until the waitlist is no longer active. Usage analytics are retained in anonymized form for up to 24 months."},
      {t:"7. Your Rights",p:"Depending on your jurisdiction, you may have the right to access, correct, delete, or port your personal data. You may also opt out of promotional communications at any time. To exercise these rights, contact us at privacy@prophetlabs.io. We will respond to valid requests within 30 days. EU/EEA residents have additional rights under GDPR, and California residents have rights under the CCPA."},
      {t:"8. Children's Privacy",p:"prophetLabs is not intended for use by individuals under the age of 18. We do not knowingly collect personal information from minors. If we become aware that we have collected data from a minor, we will take steps to delete it promptly. If you believe a minor has provided us with personal data, please contact us immediately."},
      {t:"9. International Transfers",p:"Your information may be transferred to and processed in countries other than your own. We ensure appropriate safeguards are in place for international data transfers, including Standard Contractual Clauses where required. By using the Service, you consent to the transfer of your data to the United States and other jurisdictions."},
      {t:"10. Changes to This Policy",p:"We may update this Privacy Policy from time to time. We will notify you of material changes by posting the updated policy on the Service with a new \"Last Updated\" date. Your continued use of the Service after changes take effect constitutes acceptance of the revised policy."},
    ]
  },
  "Contact":{
    icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    updated:null,
    isContact:true,
    channels:[
      {label:"General Inquiries",email:"hello@prophetlabs.io",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,desc:"Questions about prophetLabs, features, or partnerships."},
      {label:"Technical Support",email:"support@prophetlabs.io",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01"/></svg>,desc:"Bug reports, technical issues, or API integration help."},
      {label:"Privacy & Data Requests",email:"privacy@prophetlabs.io",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,desc:"Data deletion, GDPR/CCPA requests, or privacy concerns."},
      {label:"Press & Media",email:"press@prophetlabs.io",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>,desc:"Media inquiries, press kits, or interview requests."},
    ],
    socials:[
      {label:"Twitter / X",url:"https://x.com/prophetlabs_",icon:<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>},
    ]
  }
};

const LegalModal=({type,onClose})=>{
  const content=LEGAL_CONTENT[type];
  if(!content)return null;
  const scrollRef=React.useRef(null);
  const[scrollY,setScrollY]=React.useState(0);
  const handleScroll=()=>{if(scrollRef.current)setScrollY(scrollRef.current.scrollTop);};
  const[copiedEmail,setCopiedEmail]=React.useState(null);
  const copyEmail=(email)=>{navigator.clipboard.writeText(email).then(()=>{setCopiedEmail(email);setTimeout(()=>setCopiedEmail(null),2000);}).catch(()=>{});};
  // Lock body scroll when modal is open
  React.useEffect(()=>{
    const prev=document.body.style.overflow;
    document.body.style.overflow="hidden";
    return()=>{document.body.style.overflow=prev;};
  },[]);
  // Close on Escape key
  React.useEffect(()=>{
    const handler=(e)=>{if(e.key==="Escape")onClose();};
    document.addEventListener("keydown",handler);
    return()=>document.removeEventListener("keydown",handler);
  },[onClose]);
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:99999,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.55)",backdropFilter:"blur(80px) saturate(1.3)",WebkitBackdropFilter:"blur(80px) saturate(1.3)",animation:"fadeUp 0.25s ease-out"}}>
      <div onClick={e=>e.stopPropagation()} className="pl-legal-modal" style={{background:"rgba(12,12,12,0.96)",backdropFilter:"blur(120px) saturate(1.4)",borderRadius:24,maxWidth:640,width:"92%",maxHeight:"85vh",position:"relative",boxShadow:"0 32px 100px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 0.5px rgba(255,255,255,0.06)",border:"none",display:"flex",flexDirection:"column",overflow:"hidden"}}>
        {/* Header — sticky with fade effect */}
        <div style={{padding:"28px 32px 16px",flexShrink:0,borderBottom:scrollY>10?"1px solid rgba(255,255,255,0.04)":"1px solid transparent",transition:"border-color 0.2s",display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:40,height:40,borderRadius:12,background:"rgba(255,255,255,0.03)",backdropFilter:"blur(60px) saturate(1.3)",display:"flex",alignItems:"center",justifyContent:"center",color:T.text,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)"}}>{content.icon}</div>
            <div>
              <h2 style={{fontSize:20,fontWeight:600,color:T.text,fontFamily:T.display,letterSpacing:"-0.5px",marginBottom:2}}>{type}</h2>
              {content.updated&&<span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,letterSpacing:0.5}}>Last updated: {content.updated}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{flexShrink:0,width:32,height:32,borderRadius:8,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.04)",color:T.textTertiary,fontSize:16,fontWeight:300,display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s"}}
            onMouseOver={e=>{e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.08)";}}
            onMouseOut={e=>{e.currentTarget.style.color=T.textTertiary;e.currentTarget.style.background="rgba(255,255,255,0.04)";}}>✕</button>
        </div>

        {/* Scrollable Content */}
        <div ref={scrollRef} onScroll={handleScroll} style={{flex:1,overflowY:"auto",padding:"8px 32px 32px",WebkitOverflowScrolling:"touch"}}>
          {/* Legal pages (Terms / Privacy) */}
          {content.sections&&content.sections.map((s,i)=>(
            <div key={i} style={{marginBottom:i<content.sections.length-1?24:0,animation:`revealFade 0.3s ease-out ${i*0.03}s both`}}>
              <h3 style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:T.body,marginBottom:8,letterSpacing:"-0.2px"}}>{s.t}</h3>
              <p style={{fontSize:12,color:T.textSecondary,fontFamily:T.body,lineHeight:1.75,fontWeight:400}}>{s.p}</p>
            </div>
          ))}

          {/* Contact page */}
          {content.isContact&&(
            <div>
              <p style={{fontSize:13,color:T.textSecondary,fontFamily:T.body,lineHeight:1.7,marginBottom:24}}>
                Have a question, feedback, or need help? Reach out through any of the channels below. We typically respond within 24–48 hours.
              </p>

              {/* Email Channels */}
              <div style={{display:"grid",gap:10,marginBottom:28}}>
                {content.channels.map((ch,i)=>(
                  <div key={i} style={{padding:"16px 18px",borderRadius:16,background:"rgba(255,255,255,0.018)",backdropFilter:"blur(60px) saturate(1.3)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.2)",animation:`revealFade 0.3s ease-out ${i*0.06}s both`}}>
                    <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
                      <div style={{width:34,height:34,borderRadius:10,background:"rgba(255,255,255,0.025)",display:"flex",alignItems:"center",justifyContent:"center",color:T.textSecondary,flexShrink:0,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08)",marginTop:2}}>{ch.icon}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,fontWeight:600,color:T.text,marginBottom:3}}>{ch.label}</div>
                        <div style={{fontSize:11,color:T.textTertiary,fontFamily:T.body,marginBottom:8,lineHeight:1.5}}>{ch.desc}</div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:11,fontFamily:T.mono,color:T.textSecondary,letterSpacing:0.3}}>{ch.email}</span>
                          <button onClick={()=>copyEmail(ch.email)} style={{padding:"4px 10px",borderRadius:6,border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:9,fontWeight:600,letterSpacing:0.5,
                            background:copiedEmail===ch.email?"rgba(52,199,89,0.12)":"rgba(255,255,255,0.03)",
                            color:copiedEmail===ch.email?T.positive:T.textTertiary,
                            boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)",transition:"all .2s"}}
                            onMouseOver={e=>{if(copiedEmail!==ch.email){e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.color=T.text;}}}
                            onMouseOut={e=>{if(copiedEmail!==ch.email){e.currentTarget.style.background="rgba(255,255,255,0.03)";e.currentTarget.style.color=T.textTertiary;}}}
                          >{copiedEmail===ch.email?"✓ Copied":"Copy"}</button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Social links */}
              <div style={{marginBottom:24}}>
                <div style={{fontSize:9,fontWeight:700,letterSpacing:2.5,fontFamily:T.mono,color:T.textTertiary,marginBottom:12}}>FOLLOW US</div>
                <div style={{display:"flex",gap:8}}>
                  {content.socials.map((s,i)=>(
                    <button key={i} onClick={()=>window.open(s.url,"_blank","noopener,noreferrer")} style={{padding:"8px 18px",borderRadius:100,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",cursor:"pointer",color:T.textSecondary,fontSize:11,fontFamily:T.mono,fontWeight:500,letterSpacing:0.5,transition:"all .2s",display:"inline-flex",alignItems:"center",gap:6}}
                      onMouseOver={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.2)";e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.02)";}}
                      onMouseOut={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.08)";e.currentTarget.style.color=T.textSecondary;e.currentTarget.style.background="transparent";}}>{s.icon}{s.label}</button>
                  ))}
                </div>
              </div>

              {/* Response time note */}
              <div style={{padding:"12px 16px",borderRadius:12,background:"rgba(255,255,255,0.012)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)",display:"flex",alignItems:"center",gap:10}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                <span style={{fontSize:10,fontFamily:T.mono,color:T.textTertiary,lineHeight:1.5}}>Average response time: <span style={{color:T.text,fontWeight:600}}>{'<'} 24 hours</span> for support · <span style={{color:T.text,fontWeight:600}}>{'<'} 48 hours</span> for general inquiries</span>
              </div>
            </div>
          )}

          {/* Footer disclaimer for legal pages */}
          {!content.isContact&&(
            <div style={{marginTop:28,paddingTop:20,borderTop:"1px solid rgba(255,255,255,0.04)"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <Logo/>
              </div>
              <p style={{fontSize:10,color:T.textTertiary,fontFamily:T.mono,lineHeight:1.6,letterSpacing:0.3}}>
                If you have questions about {type==="Terms of Service"?"these terms":"this policy"}, contact us at <span style={{color:T.textSecondary,fontWeight:500}}>legal@prophetlabs.io</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Footer=({maxWidth=1400,onLegalOpen})=>{
  return(
  <footer className="pl-mobile-footer" style={{borderTop:"none",maxWidth,margin:"0 auto",padding:"0 24px 40px",position:"relative",zIndex:10}}>
    <Card hover={false} style={{borderRadius:22,padding:"32px 36px",overflow:"hidden"}}>
      <div className="pl-footer-inner" style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:16,marginBottom:20}}>
        <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <Logo/>
          <p style={{fontSize:10,color:T.textTertiary,fontFamily:T.mono,fontWeight:400,letterSpacing:0.3,lineHeight:1.5}}>{'\u00a9'} {new Date().getFullYear()} prophetLabs {'\u2014'} Mock data for demonstration purposes only.</p>
        </div>
        <div className="pl-footer-links" style={{display:"flex",gap:8}}>
          {["Terms of Service","Privacy Policy","Contact"].map(lbl=>(
            <button key={lbl} onClick={()=>onLegalOpen&&onLegalOpen(lbl)} style={{background:"none",border:"none",cursor:"pointer",color:T.textSecondary,fontSize:11,fontFamily:T.mono,fontWeight:500,padding:"6px 12px",borderRadius:8,transition:"all .2s",letterSpacing:0.3}}
              onMouseOver={e=>{e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.03)";}}
              onMouseOut={e=>{e.currentTarget.style.color=T.textSecondary;e.currentTarget.style.background="none";}}>{lbl}</button>
          ))}
        </div>
      </div>
      <div style={{height:1,background:"rgba(255,255,255,0.04)",marginBottom:20}}/>
      <div className="pl-footer-social" style={{display:"flex",justifyContent:"center",gap:10}}>
        {[{label:"Twitter / X",icon:<IXTwitter/>}].map(s=>(
          <button key={s.label} onClick={()=>{window.open("https://x.com/prophetlabs_","_blank","noopener,noreferrer");}} style={{padding:"7px 18px",borderRadius:100,border:"1px solid rgba(255,255,255,0.08)",background:"transparent",cursor:"pointer",color:T.textTertiary,fontSize:10,fontFamily:T.mono,fontWeight:500,letterSpacing:0.5,transition:"all .2s",display:"inline-flex",alignItems:"center",gap:6}}
            onMouseOver={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.2)";e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.02)";}}
            onMouseOut={e=>{e.currentTarget.style.borderColor="rgba(255,255,255,0.08)";e.currentTarget.style.color=T.textTertiary;e.currentTarget.style.background="transparent";}}>{s.icon}{s.label}</button>
        ))}
      </div>
    </Card>
  </footer>
  );
};
// Social icons
const IXTwitter=()=><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>;

// ─── ORDER BOOK CHART — FUTURISTIC REDESIGN ───────────────
const OrderBookChart=({market,compact=false,dualPlatform=false,platformA=null,platformB=null})=>{
  const[hover,setHover]=React.useState(null);
  const[scanY,setScanY]=React.useState(0);
  const svgRef=React.useRef(null);
  const containerRef=React.useRef(null);
  const[containerW,setContainerW]=React.useState(0);
  const animRef=React.useRef(null);
  const o=market;
  const cA=platformA||{key:"polymarket",color:"#4C8BF5",icon:"■",short:"Poly",name:"Polymarket"};
  const cB=platformB||{key:"opinion",color:"#E8853D",icon:"●",short:"Opin",name:"Opinion Labs"};
  const prA=o.allPrices?.[cA.key]||o.polymarket||{yes:0.5,no:0.5};
  const prB=o.allPrices?.[cB.key]||o.opinion||{yes:0.5,no:0.5};
  const askLevels=React.useMemo(()=>genBook(prA.yes,o.bookDepth,"ask"),[o.id,prA.yes]);
  const bidLevels=React.useMemo(()=>genBook(prA.yes,o.bookDepth,"bid"),[o.id,prA.yes]);
  const opinAskLevels=React.useMemo(()=>dualPlatform?genBook(prB.yes,o.bookDepth*0.6,"ask"):[],[o.id,prB.yes,dualPlatform]);
  const opinBidLevels=React.useMemo(()=>dualPlatform?genBook(prB.yes,o.bookDepth*0.6,"bid"):[],[o.id,prB.yes,dualPlatform]);
  const maxCum=Math.max(askLevels[askLevels.length-1]?.cumulative||1,bidLevels[bidLevels.length-1]?.cumulative||1,dualPlatform?(opinAskLevels[opinAskLevels.length-1]?.cumulative||0):0,dualPlatform?(opinBidLevels[opinBidLevels.length-1]?.cumulative||0):0);
  React.useEffect(()=>{
    const el=containerRef.current;if(!el)return;
    const obs=new ResizeObserver(entries=>{for(const e of entries)setContainerW(e.contentRect.width);});
    obs.observe(el);setContainerW(el.clientWidth);
    return()=>obs.disconnect();
  },[]);
  // Scan line animation
  React.useEffect(()=>{
    if(compact)return;
    let t=0;
    const tick=()=>{t=(t+0.4)%100;setScanY(t);animRef.current=requestAnimationFrame(tick);};
    animRef.current=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(animRef.current);
  },[compact]);
  const cW=containerW||400,cH=compact?120:500;
  const pad={l:66,r:20,t:28,b:88};
  const pW=cW-pad.l-pad.r,pH=cH-pad.t-pad.b;
  const midPrice=prA.yes;
  const bidMinP=Math.min(bidLevels[bidLevels.length-1]?.price||0,dualPlatform?(opinBidLevels[opinBidLevels.length-1]?.price||Infinity):Infinity);
  const askMaxP=Math.max(askLevels[askLevels.length-1]?.price||1,dualPlatform?(opinAskLevels[opinAskLevels.length-1]?.price||0):0);
  const priceRange=askMaxP-bidMinP||0.2;
  const pxF=p=>pad.l+((p-bidMinP)/priceRange)*pW;
  const qyF=q=>pad.t+pH-(q/maxCum)*pH;
  const bidPts=bidLevels.map(l=>`${pxF(l.price)},${qyF(l.cumulative)}`).join(" ");
  const askPts=askLevels.map(l=>`${pxF(l.price)},${qyF(l.cumulative)}`).join(" ");
  const bidFill=`${pxF(bidLevels[0]?.price||midPrice)},${pad.t+pH} ${bidPts} ${pxF(bidLevels[bidLevels.length-1]?.price||0)},${pad.t+pH}`;
  const askFill=`${pxF(askLevels[0]?.price||midPrice)},${pad.t+pH} ${askPts} ${pxF(askLevels[askLevels.length-1]?.price||1)},${pad.t+pH}`;
  const handleMouseMove=(e)=>{
    const svg=svgRef.current;if(!svg)return;
    const rect=svg.getBoundingClientRect();
    const x=(e.clientX-rect.left)/rect.width*cW;
    if(x<pad.l||x>cW-pad.r){setHover(null);return;}
    const price=bidMinP+((x-pad.l)/pW)*priceRange;
    const allLevels=[...bidLevels,...askLevels].sort((a,b)=>Math.abs(a.price-price)-Math.abs(b.price-price));
    const closest=allLevels[0];
    if(closest)setHover({x,price:closest.price,depth:closest.cumulative});
  };
  const uid=`ob${o.id}${compact?"m":"d"}`;
  const opinBidPts=dualPlatform?opinBidLevels.map(l=>`${pxF(l.price)},${qyF(l.cumulative)}`).join(" "):"";
  const opinAskPts=dualPlatform?opinAskLevels.map(l=>`${pxF(l.price)},${qyF(l.cumulative)}`).join(" "):"";
  const opinBidFill=dualPlatform?`${pxF(opinBidLevels[0]?.price||prB.yes)},${pad.t+pH} ${opinBidPts} ${pxF(opinBidLevels[opinBidLevels.length-1]?.price||0)},${pad.t+pH}`:"";
  const opinAskFill=dualPlatform?`${pxF(opinAskLevels[0]?.price||prB.yes)},${pad.t+pH} ${opinAskPts} ${pxF(opinAskLevels[opinAskLevels.length-1]?.price||1)},${pad.t+pH}`:"";
  const spreadPct=dualPlatform?Math.abs(prB.yes-midPrice)*100:0;
  // Pre-compute dot matrix to avoid nested maps in JSX
  const dotMatrix=React.useMemo(()=>{
    if(compact||pW<=0||pH<=0)return[];
    const pts=[];
    for(let ci=0;ci<5;ci++)for(let ri=0;ri<4;ri++)pts.push({x:pad.l+(ci+1)*(pW/6),y:pad.t+(ri+1)*(pH/5)});
    return pts;
  },[compact,pW,pH,pad.l,pad.t]);
  // Pre-compute hover tooltip elements
  const tooltipEls=React.useMemo(()=>{
    if(!hover)return null;
    const tx=Math.min(hover.x+12,cW-140),ty=pad.t+8;
    return{tx,ty};
  },[hover,cW,pad.t]);
  // Node markers — every 4th level
  const bidNodes=bidLevels.filter((_,i)=>i%4===3);
  const askNodes=askLevels.filter((_,i)=>i%4===3);
  const scanAbsY=pad.t+(scanY/100)*pH;
  return(
    <div ref={containerRef} style={{width:"100%",position:"relative"}}>
    {containerW>0&&(
    <div style={{position:"relative",borderRadius:16,overflow:"hidden",background:"radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.022) 0%, rgba(0,0,0,0) 70%), rgba(6,6,10,0.95)",boxShadow:"inset 0 0 0 0.5px rgba(255,255,255,0.07), 0 24px 80px rgba(0,0,0,0.6)"}}>
      {/* Top edge highlight */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg, transparent 0%, ${cA.color}66 30%, rgba(255,255,255,0.15) 50%, ${cB.color}55 70%, transparent 100%)`,zIndex:2,pointerEvents:"none"}}/>
      <svg ref={svgRef} viewBox={`0 0 ${cW} ${cH}`} preserveAspectRatio="none"
        style={{width:"100%",height:compact?120:460,display:"block"}}
        onMouseLeave={()=>setHover(null)}>
        <defs>
          {/* Area fills */}
          <linearGradient id={`bidF${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cA.color} stopOpacity="0.38"/>
            <stop offset="60%" stopColor={cA.color} stopOpacity="0.08"/>
            <stop offset="100%" stopColor={cA.color} stopOpacity="0"/>
          </linearGradient>
          <linearGradient id={`askF${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cA.color} stopOpacity="0.18"/>
            <stop offset="60%" stopColor={cA.color} stopOpacity="0.04"/>
            <stop offset="100%" stopColor={cA.color} stopOpacity="0"/>
          </linearGradient>
          {dualPlatform&&<>
            <linearGradient id={`obidF${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cB.color} stopOpacity="0.32"/>
              <stop offset="60%" stopColor={cB.color} stopOpacity="0.07"/>
              <stop offset="100%" stopColor={cB.color} stopOpacity="0"/>
            </linearGradient>
            <linearGradient id={`oaskF${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cB.color} stopOpacity="0.15"/>
              <stop offset="60%" stopColor={cB.color} stopOpacity="0.03"/>
              <stop offset="100%" stopColor={cB.color} stopOpacity="0"/>
            </linearGradient>
          </>}
          {/* Spread zone gradient */}
          <linearGradient id={`sprdFill${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={cA.color} stopOpacity="0.18"/>
            <stop offset="50%" stopColor="rgba(255,255,255,0.07)"/>
            <stop offset="100%" stopColor={cB.color} stopOpacity="0.15"/>
          </linearGradient>
          {/* Glow filter for lines */}
          <filter id={`glowA${uid}`} x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="2.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id={`glowB${uid}`} x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="2.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id={`glowWeak${uid}`} x="-10%" y="-50%" width="120%" height="200%">
            <feGaussianBlur stdDeviation="1.2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          {/* Scan line gradient */}
          <linearGradient id={`scanGrad${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.035)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          {/* Chart bg pattern clip */}
          <clipPath id={`chartClip${uid}`}>
            <rect x={pad.l} y={pad.t} width={pW} height={pH}/>
          </clipPath>
          {/* Hover crosshair gradient */}
          <linearGradient id={`hoverLine${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0)"/>
            <stop offset="30%" stopColor="rgba(255,255,255,0.5)"/>
            <stop offset="70%" stopColor="rgba(255,255,255,0.5)"/>
            <stop offset="100%" stopColor="rgba(255,255,255,0)"/>
          </linearGradient>
        </defs>

        {/* ── Deep space background ── */}
        <rect x={pad.l} y={pad.t} width={pW} height={pH} fill="rgba(4,4,8,0.6)" rx="2"/>

        {/* ── Dot matrix grid ── */}
        {!compact&&dotMatrix.map((d,i)=><circle key={i} cx={d.x} cy={d.y} r="0.8" fill="rgba(255,255,255,0.12)"/>)}
        {/* Horizontal grid lines with depth labels */}
        {!compact&&[0.25,0.5,0.75,1.0].map(f=>(
          <React.Fragment key={f}>
            <line x1={pad.l} y1={pad.t+pH*(1-f)} x2={cW-pad.r} y2={pad.t+pH*(1-f)}
              stroke={f===1?"rgba(255,255,255,0.06)":"rgba(255,255,255,0.035)"}
              strokeWidth={f===1?"0.5":"0.4"} strokeDasharray={f===1?"0":"3 6"}/>
            <text x={pad.l-10} y={pad.t+pH*(1-f)+4} textAnchor="end"
              fill={f===1?"rgba(255,255,255,0.35)":"rgba(255,255,255,0.22)"}
              fontSize="9" fontFamily={T.mono} fontWeight="500">
              ${(maxCum*f/1e3).toFixed(0)}K
            </text>
          </React.Fragment>
        ))}
        {/* Vertical price tick lines */}
        {!compact&&[0.25,0.5,0.75].map(f=>(
          <line key={f} x1={pad.l+pW*f} y1={pad.t} x2={pad.l+pW*f} y2={pad.t+pH}
            stroke="rgba(255,255,255,0.025)" strokeWidth="0.4" strokeDasharray="2 6"/>
        ))}

        {/* ── Scan line (animated) ── */}
        {!compact&&<rect x={pad.l} y={scanAbsY-18} width={pW} height={36}
          fill={`url(#scanGrad${uid})`} clipPath={`url(#chartClip${uid})`} pointerEvents="none"/>}

        {/* ── Platform A area fills ── */}
        <polygon points={bidFill} fill={`url(#bidF${uid})`} clipPath={`url(#chartClip${uid})`}/>
        <polygon points={askFill} fill={`url(#askF${uid})`} clipPath={`url(#chartClip${uid})`}/>

        {/* ── Platform B area fills ── */}
        {dualPlatform&&<>
          <polygon points={opinBidFill} fill={`url(#obidF${uid})`} clipPath={`url(#chartClip${uid})`}/>
          <polygon points={opinAskFill} fill={`url(#oaskF${uid})`} clipPath={`url(#chartClip${uid})`}/>
        </>}

        {/* ── Platform A lines — glow + solid ── */}
        {/* Bid — solid glow */}
        <polyline points={bidPts} fill="none" stroke={cA.color} strokeWidth="3.5" opacity="0.18" filter={`url(#glowA${uid})`} clipPath={`url(#chartClip${uid})`}/>
        <polyline points={bidPts} fill="none" stroke={cA.color} strokeWidth="1.6" opacity="0.95" clipPath={`url(#chartClip${uid})`}/>
        {/* Ask — dashed glow */}
        <polyline points={askPts} fill="none" stroke={cA.color} strokeWidth="2.5" opacity="0.12" strokeDasharray="5 3" filter={`url(#glowWeak${uid})`} clipPath={`url(#chartClip${uid})`}/>
        <polyline points={askPts} fill="none" stroke={cA.color} strokeWidth="1.2" opacity="0.5" strokeDasharray="5 3" clipPath={`url(#chartClip${uid})`}/>

        {/* ── Platform B lines ── */}
        {dualPlatform&&<>
          <polyline points={opinBidPts} fill="none" stroke={cB.color} strokeWidth="3.5" opacity="0.18" filter={`url(#glowB${uid})`} clipPath={`url(#chartClip${uid})`}/>
          <polyline points={opinBidPts} fill="none" stroke={cB.color} strokeWidth="1.6" opacity="0.90" clipPath={`url(#chartClip${uid})`}/>
          <polyline points={opinAskPts} fill="none" stroke={cB.color} strokeWidth="2.5" opacity="0.12" strokeDasharray="5 3" filter={`url(#glowWeak${uid})`} clipPath={`url(#chartClip${uid})`}/>
          <polyline points={opinAskPts} fill="none" stroke={cB.color} strokeWidth="1.2" opacity="0.45" strokeDasharray="5 3" clipPath={`url(#chartClip${uid})`}/>
        </>}

        {/* ── Node markers on bid/ask curves ── */}
        {!compact&&bidNodes.map((l,i)=>{
          const cx=pxF(l.price),cy=qyF(l.cumulative);
          if(cx<pad.l||cx>cW-pad.r||cy<pad.t||cy>pad.t+pH)return null;
          return <g key={i}>
            <circle cx={cx} cy={cy} r="3.5" fill="rgba(0,0,0,0.7)" stroke={cA.color} strokeWidth="1.2" opacity="0.7"/>
            <circle cx={cx} cy={cy} r="1.5" fill={cA.color} opacity="0.9"/>
          </g>;
        })}
        {!compact&&askNodes.map((l,i)=>{
          const cx=pxF(l.price),cy=qyF(l.cumulative);
          if(cx<pad.l||cx>cW-pad.r||cy<pad.t||cy>pad.t+pH)return null;
          return <g key={i}>
            <circle cx={cx} cy={cy} r="3" fill="rgba(0,0,0,0.7)" stroke={cA.color} strokeWidth="1" opacity="0.45"/>
            <circle cx={cx} cy={cy} r="1.2" fill={cA.color} opacity="0.55"/>
          </g>;
        })}

        {/* ── Spread zone ── */}
        {dualPlatform&&<>
          <rect x={Math.min(pxF(midPrice),pxF(prB.yes))} y={pad.t}
            width={Math.abs(pxF(prB.yes)-pxF(midPrice))} height={pH}
            fill={`url(#sprdFill${uid})`} clipPath={`url(#chartClip${uid})`}/>
          {/* Spread zone edge lines */}
          <line x1={Math.min(pxF(midPrice),pxF(prB.yes))} y1={pad.t}
            x2={Math.min(pxF(midPrice),pxF(prB.yes))} y2={pad.t+pH}
            stroke={cA.color} strokeWidth="0.5" strokeDasharray="2 4" opacity="0.4"/>
          <line x1={Math.max(pxF(midPrice),pxF(prB.yes))} y1={pad.t}
            x2={Math.max(pxF(midPrice),pxF(prB.yes))} y2={pad.t+pH}
            stroke={cB.color} strokeWidth="0.5" strokeDasharray="2 4" opacity="0.4"/>
        </>}

        {/* ── Platform A mid price line ── */}
        <line x1={pxF(midPrice)} y1={pad.t} x2={pxF(midPrice)} y2={pad.t+pH}
          stroke={cA.color} strokeWidth="2.5" opacity="0.12" filter={`url(#glowA${uid})`}/>
        <line x1={pxF(midPrice)} y1={pad.t} x2={pxF(midPrice)} y2={pad.t+pH}
          stroke={cA.color} strokeWidth="0.8" opacity="0.55" strokeDasharray="3 4"/>
        {/* Glowing dot at top of mid line */}
        <circle cx={pxF(midPrice)} cy={pad.t} r="4" fill={cA.color} opacity="0.25" filter={`url(#glowA${uid})`}/>
        <circle cx={pxF(midPrice)} cy={pad.t} r="2" fill={cA.color} opacity="0.85"/>
        {/* Label pill */}
        <rect x={pxF(midPrice)-42} y={pad.t-20} width="84" height="17" rx="5"
          fill="rgba(8,8,14,0.92)" stroke={cA.color} strokeWidth="0.5" strokeOpacity="0.6"/>
        <text x={pxF(midPrice)} y={pad.t-8} textAnchor="middle"
          fill={cA.color} fontSize="10" fontWeight="700" fontFamily={T.mono} letterSpacing="0">
          {cA.short} {(midPrice*100).toFixed(1)}¢
        </text>

        {/* ── Platform B mid price + spread label ── */}
        {dualPlatform&&<>
          <line x1={pxF(prB.yes)} y1={pad.t} x2={pxF(prB.yes)} y2={pad.t+pH}
            stroke={cB.color} strokeWidth="2.5" opacity="0.12" filter={`url(#glowB${uid})`}/>
          <line x1={pxF(prB.yes)} y1={pad.t} x2={pxF(prB.yes)} y2={pad.t+pH}
            stroke={cB.color} strokeWidth="0.8" opacity="0.55" strokeDasharray="3 4"/>
          <circle cx={pxF(prB.yes)} cy={pad.t+pH} r="4" fill={cB.color} opacity="0.25" filter={`url(#glowB${uid})`}/>
          <circle cx={pxF(prB.yes)} cy={pad.t+pH} r="2" fill={cB.color} opacity="0.85"/>
          {/* Label pill bottom */}
          <rect x={pxF(prB.yes)-42} y={pad.t+pH+5} width="84" height="17" rx="5"
            fill="rgba(8,8,14,0.92)" stroke={cB.color} strokeWidth="0.5" strokeOpacity="0.6"/>
          <text x={pxF(prB.yes)} y={pad.t+pH+17} textAnchor="middle"
            fill={cB.color} fontSize="10" fontWeight="700" fontFamily={T.mono} letterSpacing="0">
            {cB.short} {(prB.yes*100).toFixed(1)}¢
          </text>
          {/* Spread badge — center of spread zone */}
          {Math.abs(pxF(prB.yes)-pxF(midPrice))>80&&<>
            <rect x={(pxF(midPrice)+pxF(prB.yes))/2-46} y={pad.t+pH/2-14} width="92" height="28" rx="8"
              fill="rgba(6,6,10,0.95)" stroke="rgba(255,255,255,0.10)" strokeWidth="0.5"/>
            <rect x={(pxF(midPrice)+pxF(prB.yes))/2-45} y={pad.t+pH/2-13} width="90" height="1"
              fill={`linear-gradient(90deg,${cA.color}44,rgba(255,255,255,0.08),${cB.color}44)`}/>
            <text x={(pxF(midPrice)+pxF(prB.yes))/2} y={pad.t+pH/2-2} textAnchor="middle"
              fill="rgba(255,255,255,0.35)" fontSize="7" fontFamily={T.mono} letterSpacing="2" fontWeight="600">SPREAD</text>
            <text x={(pxF(midPrice)+pxF(prB.yes))/2} y={pad.t+pH/2+11} textAnchor="middle"
              fill="rgba(255,255,255,0.92)" fontSize="13" fontWeight="700" fontFamily={T.mono}>
              {spreadPct.toFixed(2)}%
            </text>
          </>}
        </>}

        {/* ── Axes ── */}
        {!compact&&<>
          {/* L-shaped corner ticks */}
          <line x1={pad.l-4} y1={pad.t} x2={pad.l} y2={pad.t} stroke="rgba(255,255,255,0.2)" strokeWidth="1"/>
          <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t+pH} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5"/>
          <line x1={pad.l} y1={pad.t+pH} x2={cW-pad.r} y2={pad.t+pH} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5"/>
          <line x1={cW-pad.r} y1={pad.t+pH} x2={cW-pad.r} y2={pad.t+pH+4} stroke="rgba(255,255,255,0.2)" strokeWidth="1"/>
          {/* Axis labels */}
          <text x={pad.l} y={pad.t+pH+52} textAnchor="start" fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily={T.mono}>{(bidMinP*100).toFixed(0)}¢</text>
          <text x={cW-pad.r} y={pad.t+pH+52} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily={T.mono}>{(askMaxP*100).toFixed(0)}¢</text>
          <text x={pad.l+pW/2} y={pad.t+pH+66} textAnchor="middle" fill="rgba(255,255,255,0.18)" fontSize="8" fontWeight="600" fontFamily={T.mono} letterSpacing="2">PRICE  (¢)</text>
          <text x={11} y={pad.t+pH/2} textAnchor="middle" fill="rgba(255,255,255,0.18)" fontSize="8" fontWeight="600" fontFamily={T.mono} letterSpacing="2" transform={`rotate(-90,11,${pad.t+pH/2})`}>DEPTH</text>
        </>}

        {/* ── Hover crosshair + tooltip ── */}
        <rect x={pad.l} y={pad.t} width={pW} height={pH} fill="transparent" style={{cursor:"crosshair"}} onMouseMove={handleMouseMove}/>
        {hover&&<>
          {/* Full-height glow beam */}
          <rect x={hover.x-1} y={pad.t} width="2" height={pH}
            fill={`url(#hoverLine${uid})`} pointerEvents="none" opacity="0.7"/>
          <line x1={hover.x} y1={pad.t} x2={hover.x} y2={pad.t+pH}
            stroke="rgba(255,255,255,0.6)" strokeWidth="0.5" pointerEvents="none"/>
          {/* Crosshair dot */}
          <circle cx={hover.x} cy={qyF(hover.depth)} r="5"
            fill="rgba(0,0,0,0.7)" stroke="rgba(255,255,255,0.8)" strokeWidth="1.2" pointerEvents="none"/>
          <circle cx={hover.x} cy={qyF(hover.depth)} r="2"
            fill="rgba(255,255,255,0.95)" pointerEvents="none"/>
          {/* Tooltip panel */}
          {tooltipEls&&<>
            <rect x={tooltipEls.tx} y={tooltipEls.ty} width="128" height="58" rx="10"
              fill="rgba(6,6,12,0.97)" stroke="rgba(255,255,255,0.10)" strokeWidth="0.5" pointerEvents="none"/>
            <rect x={tooltipEls.tx+1} y={tooltipEls.ty+1} width="126" height="1" rx="1"
              fill="rgba(255,255,255,0.12)" pointerEvents="none"/>
            <text x={tooltipEls.tx+12} y={tooltipEls.ty+18} fill="rgba(255,255,255,0.45)"
              fontSize="8" fontFamily={T.mono} letterSpacing="1.5" fontWeight="600" pointerEvents="none">PRICE</text>
            <text x={tooltipEls.tx+12} y={tooltipEls.ty+33} fill="rgba(255,255,255,0.97)"
              fontSize="14" fontWeight="700" fontFamily={T.mono} pointerEvents="none">
              {(hover.price*100).toFixed(1)}¢
            </text>
            <text x={tooltipEls.tx+12} y={tooltipEls.ty+48} fill="rgba(255,255,255,0.38)"
              fontSize="9" fontFamily={T.mono} pointerEvents="none">
              ≈ ${(hover.depth/1e3).toFixed(1)}K depth
            </text>
          </>}
        </>}
      </svg>
    </div>)}
    {containerW===0&&<div style={{width:"100%",height:compact?120:500}}/>}
    {!compact&&dualPlatform&&containerW>0&&(
      <div style={{padding:"12px 16px 4px",display:"flex",justifyContent:"center",gap:24,flexWrap:"wrap"}}>
        <span style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:T.mono,letterSpacing:1,display:"flex",alignItems:"center",gap:6}}>
          <span style={{width:18,height:2,background:`linear-gradient(90deg,${cA.color},${cA.color}88)`,display:"inline-block",borderRadius:1}}/>BIDS &nbsp;·&nbsp;
          <span style={{width:14,height:1.5,background:cA.color,display:"inline-block",opacity:0.5,backgroundImage:`repeating-linear-gradient(90deg,${cA.color} 0,${cA.color} 4px,transparent 4px,transparent 7px)`}}/>ASKS
        </span>
        <span style={{width:1,height:12,background:"rgba(255,255,255,0.08)",display:"inline-block",alignSelf:"center"}}/>
        <span style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:T.mono,letterSpacing:1,display:"flex",alignItems:"center",gap:6}}>
          <span style={{width:18,height:2,background:`linear-gradient(90deg,${cB.color},${cB.color}88)`,display:"inline-block",borderRadius:1}}/>BIDS &nbsp;·&nbsp;
          <span style={{width:14,height:1.5,background:cB.color,display:"inline-block",opacity:0.5,backgroundImage:`repeating-linear-gradient(90deg,${cB.color} 0,${cB.color} 4px,transparent 4px,transparent 7px)`}}/>ASKS
        </span>
        <span style={{width:1,height:12,background:"rgba(255,255,255,0.08)",display:"inline-block",alignSelf:"center"}}/>
        <span style={{fontSize:9,color:"rgba(255,255,255,0.25)",fontFamily:T.mono,letterSpacing:1}}>SHADED = ARBITRAGE WINDOW</span>
      </div>
    )}
    </div>
  );
};
const IDiscord=()=><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>;
const ITelegram=()=><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>;

const CopyTradeSummaryBtn=({market,res,ts})=>{
  const[copied,setCopied]=useState(false);
  const handleCopy=()=>{
    if(!market)return;
    const polyP=(market.polymarket?.yes*100||0).toFixed(1);
    const opinP=(market.opinion?.yes*100||0).toFixed(1);
    const txt=`Buy YES on Polymarket @ ${polyP}¢ / Buy NO on Opinion Labs @ ${opinP}¢ / Wager: $${ts.toLocaleString()} / Eff. Spread: ${(res.eff*100).toFixed(2)}% / APR: ${res.apr.toFixed(1)}% — ${market.event}`;
    navigator.clipboard.writeText(txt).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);});
  };
  return(
    <button onClick={handleCopy} style={{width:"100%",marginTop:12,padding:"10px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:600,fontSize:10,letterSpacing:1.5,background:copied?"rgba(52,199,89,0.12)":"rgba(255,255,255,0.02)",color:copied?T.positive:T.textSecondary,display:"flex",alignItems:"center",justifyContent:"center",gap:6,transition:"all .2s",boxShadow:copied?"inset 0 1px 0 rgba(52,199,89,0.15)":"inset 0 1px 0 rgba(255,255,255,0.06)"}}
      onMouseOver={e=>{if(!copied){e.currentTarget.style.background="rgba(255,255,255,0.035)";e.currentTarget.style.color=T.text;}}}
      onMouseOut={e=>{if(!copied){e.currentTarget.style.background="rgba(255,255,255,0.02)";e.currentTarget.style.color=T.textSecondary;}}}
    >{copied?"✓ Copied":"⎘ COPY TRADE SUMMARY"}</button>
  );
};

const CopyTradeStepsBtn=({market,td,pAName,pBName,pAIcon,pBIcon,polyIsYes,wager,dynAPR,showToast})=>{
  const[copied,setCopied]=useState(false);
  const handleCopy=(e)=>{
    if(e)e.stopPropagation();
    if(!market||!td)return;
    const buyYesPlatform=polyIsYes?pAName:pBName;
    const buyYesIcon=polyIsYes?pAIcon:pBIcon;
    const buyYesPrice=(polyIsYes?td.polyPrice:td.opinPrice)*100;
    const buyNoPlatform=polyIsYes?pBName:pAName;
    const buyNoIcon=polyIsYes?pBIcon:pAIcon;
    const buyNoPrice=(polyIsYes?td.opinPrice:td.polyPrice)*100;
    const nameA=market.names?.[Object.keys(market.names||{})[0]]||market.event;
    const nameB=market.names?.[Object.keys(market.names||{})[1]]||market.event;
    const apr=typeof dynAPR==='function'?dynAPR(market):td.annualizedAPR;
    const steps=[
      `1. Buy YES on ${buyYesPlatform} at ${buyYesPrice.toFixed(1)}¢ — "${market.event}"`,
      `2. Buy NO on ${buyNoPlatform} at ${buyNoPrice.toFixed(1)}¢ — "${market.event}"`,
      `3. Net cost: $${td.costBasis.toFixed(2)} per ${td.shares} shares`,
      `4. Guaranteed payout: $${td.toReturn.toLocaleString()} (regardless of outcome)`,
      `5. Profit if resolves: $${td.netPnl.toFixed(2)} (${td.roi.toFixed(2)}% ROI, ${apr.toFixed(1)}% APR)`,
      `\nWager: $${wager.toLocaleString()} | Expiry: ${market.expiry}`
    ].join('\n');
    navigator.clipboard.writeText(steps).then(()=>{
      setCopied(true);
      if(showToast)showToast("Trade steps copied to clipboard","");
      setTimeout(()=>setCopied(false),2000);
    });
  };
  return(
    <button onClick={handleCopy} style={{width:"100%",marginTop:12,padding:"12px 16px",borderRadius:14,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:11,letterSpacing:1.5,
      background:copied?"rgba(52,199,89,0.15)":"linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(200,200,200,0.04) 50%, rgba(255,255,255,0.06) 100%)",
      backgroundSize:copied?"100% 100%":"300% 300%",
      animation:copied?"none":"aShift 5s ease infinite",
      color:copied?T.positive:"#D0D0D0",
      display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all .25s",
      boxShadow:copied?"inset 0 1px 0 rgba(52,199,89,0.2), 0 4px 16px rgba(52,199,89,0.1)":"inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 20px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(255,255,255,0.08)"}}
      onMouseOver={e=>{if(!copied){e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.22), 0 6px 28px rgba(0,0,0,0.35), 0 0 20px rgba(255,255,255,0.06)";e.currentTarget.style.color="#fff";}}}
      onMouseOut={e=>{if(!copied){e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 20px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(255,255,255,0.08)";e.currentTarget.style.color="#D0D0D0";}}}
    >{copied?<><IC/> Steps Copied</>:<><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 12l2 2 4-4"/></svg> COPY TRADE STEPS</>}</button>
  );
};

const TradeCalc=({market,wager:ts,setWager:setTs,pAColor,selName})=>{
  if(!ts)ts=1000;
  if(!setTs)setTs=()=>{};
  const[prevName,setPrevName]=useState(selName);
  const[pillAnim,setPillAnim]=useState(false);
  useEffect(()=>{if(selName&&selName!==prevName){setPillAnim(true);setPrevName(selName);const t=setTimeout(()=>setPillAnim(false),500);return()=>clearTimeout(t);}},[selName]);
  const mx=market?market.bookDepth*0.8:50000;
  const asks=useMemo(()=>market?genBook(market.polymarket.yes,market.bookDepth,"ask"):[],[market?.id]);
  const bids=useMemo(()=>market?genBook(market.polymarket.yes,market.bookDepth,"bid"):[],[market?.id]);
  const walk=useCallback((sz)=>{
    if(!market)return{avg:0,slip:0,eff:0,apr:0};
    const bk=asks;
    let rem=sz,cost=0,qty=0;
    for(const l of bk){const f=Math.min(rem,l.quantity);cost+=f*l.price;qty+=f;rem-=f;if(rem<=0)break;}
    const avg=qty>0?cost/qty:market.polymarket.yes;
    const slip=Math.max(0,avg-market.polymarket.yes);
    const eff=Math.max(0,market.spread-slip);
    const days=Math.max(1,(new Date(market.expiry)-new Date())/86400000);
    const apr=eff>0?(eff/(avg+(1-eff-avg)))*(365/days)*100:0;
    return{avg,slip,eff,apr};
  },[market,asks]);
  const res=walk(ts);
  const findT=useCallback((type)=>{
    let lo=0,hi=mx,best=0;
    for(let i=0;i<30;i++){const mid=(lo+hi)/2;const r=walk(mid);if(type==="p"?r.eff>0.001:r.apr>5){best=mid;lo=mid;}else{hi=mid;}}
    return best;
  },[walk,mx]);
  const mxP=findT("p"),oAPR=findT("a");
  const mb=S.miniBox;
  const ml=S.monoLabel;
  // Pre-computed for CopyTradeStepsBtn — avoids return <JSX/> inside IIFE which breaks Babel
  const _tsAP=market?(market.polymarket||{yes:0.5,no:0.5}):{yes:0.5,no:0.5};
  const _tsBP=market?(market.opinion||{yes:0.5,no:0.5}):{yes:0.5,no:0.5};
  const _tsPolyIsYes=_tsAP.yes<_tsBP.yes;
  const _tsShares=market?Math.floor(ts/(_tsAP.yes+(1-_tsBP.yes))):0;
  const _tsPolyCost=_tsShares*_tsAP.yes;
  const _tsOpinCost=_tsShares*(1-_tsBP.yes);
  const _tsCostBasis=_tsPolyCost+_tsOpinCost;
  const _tsNetPnl=_tsShares-_tsCostBasis;
  const _tsRoi=_tsCostBasis>0?(_tsNetPnl/_tsCostBasis)*100:0;
  const _tsFakeTd=market?{polyPrice:_tsAP.yes,opinPrice:1-_tsBP.yes,shares:_tsShares,polyCost:_tsPolyCost,polyTotal:_tsPolyCost,opinCost:_tsOpinCost,opinTotal:_tsOpinCost,costBasis:_tsCostBasis,toReturn:_tsShares,netPnl:_tsNetPnl,roi:_tsRoi,annualizedAPR:res.apr}:null;
  return(
    <div style={{marginBottom:20}}>
      {/* Computing for pill */}
      <div style={{marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
        <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>COMPUTING FOR:</span>
        {selName?<span key={selName} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 14px",borderRadius:100,background:"rgba(255,255,255,0.035)",backdropFilter:"blur(100px) saturate(1.30)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.2)",fontSize:11,fontWeight:600,fontFamily:T.mono,color:T.text,animation:pillAnim?"revealFade 0.4s ease-out":"none",borderLeft:`2px solid ${pAColor||"#4C8BF5"}`,transition:"all .3s"}}>{selName.length>40?selName.slice(0,40)+"…":selName}</span>
        :<span style={{fontSize:10,fontFamily:T.mono,color:T.textTertiary,fontStyle:"italic",opacity:0.6,animation:"pulse 2s ease-in-out infinite"}}>Click any row to analyze</span>}
      </div>
    <Card hover={false} style={{padding:0,overflow:"hidden",borderLeft:`3px solid ${pAColor||"rgba(255,255,255,0.06)"}`}}>
      <div style={{padding:"18px 24px 14px",borderBottom:"none",display:"flex",alignItems:"center",gap:8}}>
        <ICh/><span style={{fontSize:13,fontWeight:600,color:T.text}}>Trade Viability Calculator</span>
        {market&&<><span style={{fontSize:11,color:T.textTertiary,fontFamily:T.mono}}>— {market.event}</span></>}
      </div>
      <div style={{padding:"16px 24px 20px"}}>
        <div style={{marginBottom:20}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <span style={ml}>Your Position Size</span>
            <span style={{fontSize:14,fontWeight:600,color:T.text,fontFamily:T.mono}}>${ts.toLocaleString()}</span>
          </div>
          <input type="range" min={100} max={mx} step={100} value={ts} onChange={e=>{const v=Number(e.target.value);setTs(v);}} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>$100</span>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>${(mx/1000).toFixed(0)}K</span>
          </div>
          {/* Preset quick buttons */}
          <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
            {[500,1000,5000,10000,25000].map(amt=>(
              <button key={amt} onClick={()=>setTs(amt)}
                style={{padding:"4px 10px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:9,fontWeight:600,letterSpacing:0.5,
                  background:ts===amt?"rgba(255,255,255,0.06)":"rgba(255,255,255,0.018)",
                  color:ts===amt?T.text:T.textTertiary,
                  boxShadow:ts===amt?"inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.2)":"inset 0 1px 0 rgba(255,255,255,0.06)",
                  transition:"all .2s"}}
              >{amt>=1000?"$"+(amt/1000)+"K":"$"+amt}</button>
            ))}
          </div>
          {/* Manual numeric input */}
          <div style={{marginTop:8,position:"relative",display:"flex",alignItems:"center"}}>
            <span style={{position:"absolute",left:12,fontSize:13,fontWeight:600,fontFamily:T.mono,color:T.textTertiary,pointerEvents:"none",zIndex:1}}>$</span>
            <input type="number" min={100} max={mx} value={ts}
              onChange={e=>{const v=Number(e.target.value);if(!isNaN(v)&&v>0)setTs(v);}}
              onBlur={e=>{const v=Math.max(100,Math.min(mx,Number(e.target.value)||100));setTs(v);}}
              onKeyDown={e=>{if(e.key==="Enter"){const v=Math.max(100,Math.min(mx,Number(e.target.value)||100));setTs(v);e.target.blur();}}}
              style={{width:"100%",padding:"9px 12px 9px 28px",borderRadius:11,border:"none",background:"rgba(255,255,255,0.022)",backdropFilter:"blur(100px) saturate(1.30)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 10px rgba(0,0,0,0.25)",fontFamily:T.mono,fontSize:13,fontWeight:600,color:T.text,outline:"none",transition:"box-shadow .2s"}}
              onFocus={e=>{e.target.style.boxShadow="0 0 0 2px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.10)";}}
              onBlurCapture={e=>{e.target.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 10px rgba(0,0,0,0.25)";}}
            />
          </div>
        </div>
        <div className="pl-trade-calc-grid" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
          <div style={mb}><div style={ml}>Eff. Spread</div><div style={{fontSize:22,fontWeight:500,color:res.eff>0.03?T.positive:res.eff>0.01?T.text:T.negative}}>{(res.eff*100).toFixed(2)}%</div></div>
          <div style={mb}><div style={ml}>Slippage</div><div style={{fontSize:22,fontWeight:500,color:res.slip<0.01?T.positive:res.slip<0.03?T.textSecondary:T.negative}}>{(res.slip*100).toFixed(2)}%</div></div>
          <div style={mb}><div style={ml}>Live APR</div><div style={{fontSize:22,fontWeight:500,...(res.apr>15?{background:T.aurora,backgroundSize:"200% 200%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:res.apr>0?{color:T.positive}:{color:T.negative})}}>{res.apr.toFixed(1)}%</div></div>
          <div style={mb}><div style={ml}>Avg Price</div><div style={{fontSize:22,fontWeight:500,color:T.text}}>{res.avg.toFixed(3)}</div></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <div style={{...mb,border:"none",background:ts<=mxP?"rgba(255,255,255,0.022)":"rgba(255,255,255,0.018)",boxShadow:ts<=mxP?"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 20px rgba(0,0,0,0.15)":"inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 20px rgba(0,0,0,0.15)"}}>
            <div style={{...ml,fontSize:12,fontWeight:700}}>Max Profitable</div>
            <div style={{fontSize:24,fontWeight:700,color:T.text}}>${mxP>=1000?(mxP/1000).toFixed(1)+"K":mxP.toFixed(0)}</div>
            <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:2}}>{'Slippage = Spread'}</div>
          </div>
          <div style={{...mb,border:"none",background:ts<=oAPR?"rgba(255,255,255,0.022)":"rgba(255,255,255,0.018)",boxShadow:ts<=oAPR?"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 20px rgba(0,0,0,0.15)":"inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 20px rgba(0,0,0,0.15)"}}>
            <div style={ml}>Optimal APR</div>
            <div style={{fontSize:18,fontWeight:600,color:T.text}}>${oAPR>=1000?(oAPR/1000).toFixed(1)+"K":oAPR.toFixed(0)}</div>
            <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:2}}>{'Maintains >5% APR'}</div>
          </div>
        </div>
        {/* Copy Trade Summary */}
        {market&&<CopyTradeSummaryBtn market={market} res={res} ts={ts}/>}
        {/* Copy Trade Steps */}
        {market&&<CopyTradeStepsBtn market={market} td={_tsFakeTd} pAName="Polymarket" pBName="Opinion Labs" pAIcon="■" pBIcon="●" polyIsYes={_tsPolyIsYes} wager={ts} dynAPR={()=>res.apr}/>}
      </div>
    </Card>
    </div>
  );
};

// ─── FILTERS ───────────────────────────────────────────────
const Filters=({filters:f,setFilters:sf,onReset:r})=>{
  const ml={...S.monoLabel,marginBottom:6};
  const fmtVol=v=>v>=1e6?(v/1e6).toFixed(1)+"M":v>=1e3?(v/1e3).toFixed(0)+"K":"$0";
  const fmtLiq=v=>v>=1e6?(v/1e6).toFixed(1)+"M":v>=1e3?(v/1e3).toFixed(0)+"K":v;
  return(
    <Card hover={false} style={{padding:0,marginBottom:20,overflow:"hidden"}}>
      <div style={{padding:"14px 24px 10px",borderBottom:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><IS/><span style={{fontSize:13,fontWeight:600,color:T.text}}>Filters</span></div>
        <button onClick={r} style={{background:"none",border:"none",borderRadius:8,padding:"4px 12px",color:T.textSecondary,fontSize:9,fontFamily:T.mono,cursor:"pointer",letterSpacing:1}} onMouseOver={e=>e.currentTarget.style.color=T.text} onMouseOut={e=>e.currentTarget.style.color=T.textSecondary}>RESET</button>
      </div>
      <div className="pl-filter-grid" style={{padding:"14px 24px 18px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow}}>
          <div style={ml}>Market Expiry (days)</div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:T.mono}}>{f.expiryDays} days</span>
          </div>
          <input type="range" min={1} max={500} step={1} value={f.expiryDays} onChange={e=>sf(p=>({...p,expiryDays:Number(e.target.value)}))} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>1 day</span>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>500 days</span>
          </div>
          <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:4}}>Hide markets expiring beyond {f.expiryDays}d</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow}}>
          <div style={ml}>Min 24h Volume</div>
          <div style={{fontSize:13,fontWeight:600,color:T.text,fontFamily:T.mono,marginBottom:6}}>${fmtVol(f.minVolume)}</div>
          <input type="range" min={0} max={20000000} step={500000} value={f.minVolume} onChange={e=>sf(p=>({...p,minVolume:Number(e.target.value)}))} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>$0</span>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>$20M</span>
          </div>
          <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:4}}>Exclude ghost markets</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow}}>
          <div style={ml}>Active Liquidity</div>
          <div style={{fontSize:13,fontWeight:600,color:f.minLiquidity>=1e6?T.positive:f.minLiquidity>=100000?T.text:T.textSecondary,fontFamily:T.mono,marginBottom:6}}>${fmtLiq(f.minLiquidity)}</div>
          <input type="range" min={1000} max={100000000} step={10000} value={f.minLiquidity} onChange={e=>sf(p=>({...p,minLiquidity:Number(e.target.value)}))} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>$1K</span>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>$100M</span>
          </div>
          <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:4}}>Hide thin order books</div>
        </div>
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow}}>
          <div style={ml}>Min APR %</div>
          <div style={{fontSize:13,fontWeight:600,color:f.minApr>0?T.positive:T.text,fontFamily:T.mono,marginBottom:6}}>{f.minApr}%</div>
          <input type="range" min={0} max={100} step={1} value={f.minApr} onChange={e=>sf(p=>({...p,minApr:Number(e.target.value)}))} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>0%</span>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>100%</span>
          </div>
          <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:4}}>Only show high-APR markets</div>
        </div>
      </div>
    </Card>
  );
};


// ═══════════════════════════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════════════════════════

// ─── WAITLIST MODAL ──────────────────────────────────────────
const WaitlistModal=({open,onClose})=>{
  const[email,setEmail]=React.useState("");
  const[submitted,setSubmitted]=React.useState(false);
  const[emailError,setEmailError]=React.useState("");
  const[signupCount,setSignupCount]=React.useState(null);
  const[loadingCount,setLoadingCount]=React.useState(true);
  const emailRegex=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Load real waitlist count from shared storage on modal open
  React.useEffect(()=>{
    if(!open)return;
    setLoadingCount(true);
    (async()=>{
      try{
        const result=await window.storage.list('waitlist:',true);
        setSignupCount((result?.keys?.length||0)+847); // base count + real submissions
      }catch(e){setSignupCount(847);}
      setLoadingCount(false);
    })();
  },[open]);
  const handleSubmit=async()=>{
    if(!emailRegex.test(email)){setEmailError("Please enter a valid email");return;}
    setEmailError("");
    try{
      await window.storage.set('waitlist:'+email.toLowerCase().replace(/[^a-z0-9@._-]/g,''),JSON.stringify({email,ts:Date.now()}),true);
      setSignupCount(prev=>(prev||847)+1);
    }catch(e){}
    setSubmitted(true);
  };
  if(!open)return null;
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:9998,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.6)",backdropFilter:"blur(100px) saturate(1.30)",animation:"fadeUp 0.25s ease-out"}}>
      <div onClick={e=>e.stopPropagation()} className="pl-waitlist-modal" style={{background:"rgba(12,12,12,0.95)",backdropFilter:"blur(110px) saturate(1.3)",borderRadius:24,padding:"44px 40px",maxWidth:440,width:"90%",position:"relative",boxShadow:"0 24px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.10)",border:"none"}}>
        <button onClick={onClose} style={{position:"absolute",top:16,right:16,background:"none",border:"none",cursor:"pointer",color:T.textTertiary,fontSize:18,fontWeight:300,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:8,transition:"all .2s"}}
          onMouseOver={e=>{e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.04)";}}
          onMouseOut={e=>{e.currentTarget.style.color=T.textTertiary;e.currentTarget.style.background="none";}}>✕</button>
        {!submitted?(
          <>
            <h2 style={{fontSize:26,fontWeight:300,color:T.text,fontFamily:T.display,letterSpacing:"-1px",marginBottom:8}}>Join the waitlist</h2>
            <p style={{fontSize:13,color:T.textSecondary,marginBottom:32,lineHeight:1.6,fontWeight:400}}>Get early access to prophetLabs. No credit card required.</p>
            <div style={{marginBottom:16}}>
              <input type="email" placeholder="you@example.com" value={email} onChange={e=>{setEmail(e.target.value);if(emailError)setEmailError("");}}
                onKeyDown={e=>{if(e.key==="Enter")handleSubmit();}}
                style={{width:"100%",padding:"14px 18px",borderRadius:14,border:emailError?"1px solid "+T.negative+"44":"none",background:"rgba(255,255,255,0.02)",backdropFilter:"blur(110px) saturate(1.35)",fontFamily:T.mono,fontSize:14,color:T.text,outline:"none",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)",transition:"box-shadow .3s, border .2s"}}
                onFocus={e=>{e.target.style.boxShadow="0 0 0 3px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.10)";}}
                onBlur={e=>{e.target.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)";}}/>
              {emailError&&<div style={{fontSize:11,color:T.negative,fontFamily:T.mono,marginTop:6,fontWeight:500}}>{emailError}</div>}
            </div>
            {/* Social proof counter */}
            <div style={{textAlign:"center",marginBottom:16}}>
              <span style={{fontSize:11,color:T.textTertiary,fontFamily:T.mono,letterSpacing:0.5}}>
                <span style={{color:T.text,fontWeight:600,transition:"all 0.8s ease",display:"inline-block"}}>{loadingCount?"...":(signupCount||847).toLocaleString()}+</span> traders already on the waitlist <span style={{fontSize:9,opacity:0.5}}>(demo)</span>
              </span>
            </div>
            <button onClick={handleSubmit}
              style={{width:"100%",padding:"14px 0",borderRadius:980,cursor:"pointer",fontWeight:600,fontSize:14,fontFamily:T.body,background:"#ffffff",color:"#000",border:"none",boxShadow:"0 4px 24px rgba(0,0,0,0.3), 0 0 24px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.2)",transition:"all .25s",opacity:emailRegex.test(email)?1:0.5}}
              onMouseOver={e=>{if(emailRegex.test(email)){e.currentTarget.style.transform="translateY(-1px)";e.currentTarget.style.boxShadow="0 8px 32px rgba(0,0,0,0.4), 0 0 36px rgba(255,255,255,0.2)";}}}
              onMouseOut={e=>{e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow="0 4px 24px rgba(0,0,0,0.3), 0 0 24px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.2)";}}>
              Join Waitlist</button>
          </>
        ):(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{marginBottom:16,display:"flex",justifyContent:"center",animation:"checkFadeIn 0.5s ease-out"}}><svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="22" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5"/><path d="M15 24l7 7 12-14" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg></div>
            <h2 style={{fontSize:22,fontWeight:300,color:T.text,fontFamily:T.display,letterSpacing:"-0.5px",marginBottom:10}}>You're #{847+Math.floor(Math.random()*150)} on the waitlist</h2>
            <p style={{fontSize:13,color:T.textSecondary,lineHeight:1.6,fontWeight:400,maxWidth:320,margin:"0 auto"}}>We'll reach out within 48 hours. Keep an eye on your inbox.</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── SCROLL REVEAL — Intersection Observer trigger ────────
const ScrollReveal=({children,animation="revealUp",duration=0.7,delay=0,threshold=0.15,style:extraStyle={}})=>{
  const ref=useRef(null);
  const[visible,setVisible]=useState(false);
  useEffect(()=>{
    const el=ref.current;if(!el)return;
    const obs=new IntersectionObserver(([e])=>{if(e.isIntersecting){setVisible(true);obs.unobserve(el);}},{threshold});
    obs.observe(el);return()=>obs.disconnect();
  },[threshold]);
  return(
    <div ref={ref} style={{opacity:visible?1:0,animation:visible?`${animation} ${duration}s cubic-bezier(0.22,1,0.36,1) ${delay}s both`:"none",willChange:"opacity,transform",...extraStyle}}>
      {children}
    </div>
  );
};

const Landing=({onNavigate:nav,onLegalOpen})=>{
  const[annual,setAnnual]=useState(true);
  const[showWaitlist,setShowWaitlist]=useState(false);
  return(
    <div style={{background:"transparent",minHeight:"100vh",position:"relative",zIndex:10}}>
      <section style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",paddingBottom:80}}>
        <div style={{position:"relative",textAlign:"center",maxWidth:780,padding:"0 24px",animation:"fadeUp 1s ease-out",zIndex:10}}>
          <div style={{display:"flex",justifyContent:"center",marginBottom:44}}><Logo size="lg"/></div>
          <div style={{display:"inline-flex",flexDirection:"column",alignItems:"center",gap:14,marginBottom:52}}>
            <LiveDot/>
            <div style={{padding:"6px 20px",background:"rgba(255,255,255,0.032)",backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)",border:"none",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.14), 0 4px 16px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(255,255,255,0.06)",borderRadius:100,fontSize:11,color:T.textSecondary,fontWeight:500,fontFamily:T.mono,letterSpacing:1.5,position:"relative",overflow:"hidden"}}>
              REAL-TIME ARBITRAGE
              <div style={{position:"absolute",bottom:0,left:"15%",right:"15%",height:1,background:"linear-gradient(90deg, transparent, rgba(255,51,102,0.2), rgba(255,136,68,0.2), rgba(255,204,51,0.2), rgba(51,221,136,0.2), rgba(51,204,238,0.2), rgba(76,139,245,0.2), rgba(168,85,247,0.2), rgba(221,68,170,0.2), transparent)",borderRadius:1}}/>
            </div>
          </div>
          <h1 className="pl-hero-title" style={{fontSize:42,fontWeight:300,lineHeight:1.05,letterSpacing:"-1.5px",color:T.text,marginBottom:32,fontFamily:T.display}}>
            Profit from prediction<br/>
            <span className="pl-glass-underlay"><span className="pl-hero-glass-text" style={{fontWeight:700,fontSize:"clamp(42px,6vw,72px)",lineHeight:1.1,display:"block",position:"relative",letterSpacing:"-1px",animation:"letterReveal 1.2s ease-out forwards"}}>{/* Soft diffuse ambient glow — behind the text, no boxy outline */}<span style={{position:"absolute",left:"50%",top:"50%",transform:"translate(-50%,-50%)",width:"140%",height:"220%",background:"radial-gradient(ellipse 70% 55% at 50% 50%, rgba(255,255,255,0.055) 0%, rgba(140,180,255,0.025) 40%, transparent 70%)",filter:"blur(28px)",pointerEvents:"none",zIndex:-1}} aria-hidden="true"/>{/* Clean frosted-glass gradient text — single layer, crisp shimmer */}<span style={{display:"block",background:"linear-gradient(135deg, rgba(255,255,255,1) 0%, rgba(205,225,255,0.96) 18%, rgba(255,255,255,0.99) 36%, rgba(188,216,255,0.92) 52%, rgba(255,255,255,0.98) 66%, rgba(212,230,255,0.94) 82%, rgba(255,255,255,1) 100%)",backgroundSize:"300% 300%",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",animation:"heroGlassShimmer 7s ease-in-out infinite, glowPulse 3.5s ease-in-out infinite alternate",filter:"drop-shadow(0 0 40px rgba(255,255,255,0.22)) drop-shadow(0 0 80px rgba(120,170,255,0.10)) drop-shadow(0 3px 10px rgba(255,255,255,0.16))",userSelect:"none"}} aria-hidden="true">market inefficiencies</span>{/* Real accessible text, invisible */}<span style={{position:"absolute",inset:0,color:"transparent",WebkitTextFillColor:"transparent",opacity:0,userSelect:"text",pointerEvents:"none"}}>market inefficiencies</span></span></span>
          </h1>
          <p className="pl-hero-sub" style={{fontSize:17,color:T.textSecondary,lineHeight:1.7,maxWidth:520,margin:"0 auto 64px",fontWeight:400}}>
            prophetLabs scans <span style={{color:T.polyBlue,fontWeight:500}}>Polymarket</span>, <span style={{color:T.opinOrange,fontWeight:500}}>Opinion Labs</span>, <span style={{color:"#00C9A7",fontWeight:500}}>Kalshi</span>, and <span style={{color:"#A855F7",fontWeight:500}}>Predict</span> in real time, surfacing guaranteed arbitrage before it disappears.
          </p>
          <GlassBtn primary onClick={()=>nav("dashboard")}>Launch Scanner <IA/></GlassBtn>
          <div style={{display:"flex",justifyContent:"center",gap:16,marginTop:48,flexWrap:"wrap"}}>
            {[{v:<Counter end={MOCK.length} suffix="+"/>,l:"ACTIVE MARKETS"},{v:<Counter end={Math.round(MOCK.reduce((a,m)=>a+m.spread,0)/MOCK.length*100)} suffix="%" prefix="~"/>,l:"AVG SPREAD"},{v:"24/7",l:"SCANNING"},{v:<><Counter end={30}/>s</>,l:"REFRESH RATE"}].map((s,i)=>(
              <ScrollReveal key={i} animation="revealScale" delay={i*0.1} duration={0.6}>
              <Card style={{textAlign:"center",padding:"20px 28px"}}>
                <div style={{fontSize:36,fontWeight:300,color:T.text,fontFamily:T.display,letterSpacing:"-1px"}}>{s.v}</div>
                <div style={{fontSize:9,color:T.textTertiary,marginTop:8,fontWeight:600,letterSpacing:3,fontFamily:T.mono}}>{s.l}</div>
              </Card>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <ScrollReveal animation="revealLine" duration={0.8} style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{height:1,background:`linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)`,transformOrigin:"center"}}/>
      </ScrollReveal>

      <section style={{maxWidth:1100,margin:"0 auto",padding:"80px 24px",position:"relative",zIndex:10}}>
        <ScrollReveal animation="revealUp" duration={0.7}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <span style={{fontSize:10,fontWeight:600,color:T.textTertiary,letterSpacing:3,fontFamily:T.mono}}>FEATURES</span>
          <h2 style={{fontSize:42,fontWeight:300,color:T.text,marginTop:16,letterSpacing:"-1.5px",fontFamily:T.display}}>Built for arbitrage traders</h2>
        </div>
        </ScrollReveal>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:16}}>
          {[{icon:<IG/>,t:"Multi-Platform Scanning",d:<>Monitor <span style={{color:T.polyBlue}}>Polymarket</span>, <span style={{color:T.opinOrange}}>Opinion Labs</span>, <span style={{color:"#00C9A7"}}>Kalshi</span>, and <span style={{color:"#A855F7"}}>Predict</span> simultaneously. Spot price gaps instantly.</>,accent:"linear-gradient(135deg, rgba(76,139,245,0.10), rgba(0,201,167,0.08), rgba(168,85,247,0.08), rgba(232,133,61,0.10))"},{icon:<IB/>,t:"Real-Time Updates",d:"Live price feeds every 30 seconds. No stale data, no missed opportunities."},{icon:<IBe/>,t:"Smart Telegram Alerts",d:"Instant notifications when spreads exceed your threshold."},{icon:<ICh/>,t:"Profit Analytics",d:"Automatic APR calculation accounting for gas fees, slippage, and commissions."},{icon:<IS/>,t:"Event Matching Engine",d:<>AI-powered matching across <span style={{color:T.polyBlue}}>Polymarket</span>, <span style={{color:T.opinOrange}}>Opinion Labs</span>, <span style={{color:"#00C9A7"}}>Kalshi</span>{" & "}<span style={{color:"#A855F7"}}>Predict</span> — even with different wording.</>,accent:"linear-gradient(135deg, rgba(76,139,245,0.06), rgba(0,201,167,0.06), rgba(168,85,247,0.06), rgba(232,133,61,0.06))"},{icon:<ISh/>,t:"Risk Assessment",d:"Liquidity analysis, volume checks, and expiry tracking."}].map((f,i)=>(
            <ScrollReveal key={i} animation="revealScale" delay={i*0.08} duration={0.6}>
            <Card style={{padding:32,height:"100%"}}>
              <div style={{width:44,height:44,borderRadius:14,background:f.accent||"rgba(255,255,255,0.032)",backdropFilter:"blur(110px) saturate(1.3)",WebkitBackdropFilter:"blur(110px) saturate(1.3)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 16px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(255,255,255,0.06)",display:"flex",alignItems:"center",justifyContent:"center",color:"#ffffff",marginBottom:20}}>{f.icon}</div>
              <h3 style={{fontSize:15,fontWeight:600,color:T.text,marginBottom:8}}>{f.t}</h3>
              <p style={{fontSize:13,color:T.textSecondary,lineHeight:1.65,fontWeight:400}}>{f.d}</p>
            </Card>
            </ScrollReveal>
          ))}
        </div>
      </section>

      <ScrollReveal animation="revealLine" duration={0.8} style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{height:1,background:`linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)`,transformOrigin:"center"}}/>
      </ScrollReveal>

      {/* ─── HOW IT WORKS ─── */}
      <section style={{maxWidth:1100,margin:"0 auto",padding:"80px 24px",position:"relative",zIndex:10}}>
        <ScrollReveal animation="revealUp" duration={0.7}>
          <div style={{textAlign:"center",marginBottom:48}}>
            <span style={{fontSize:10,fontWeight:600,color:T.textTertiary,letterSpacing:3,fontFamily:T.mono}}>HOW IT WORKS</span>
            <h2 style={{fontSize:42,fontWeight:300,color:T.text,marginTop:16,letterSpacing:"-1.5px",fontFamily:T.display}}>Three steps to profit</h2>
          </div>
        </ScrollReveal>
        <div className="pl-steps-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,maxWidth:960,margin:"0 auto"}}>
          {[
            {num:"1",t:"Scan",d:"prophetLabs identifies the same event listed across Polymarket, Opinion Labs, Kalshi, and Predict with different implied probabilities. Discrepancies are surfaced instantly."},
            {num:"2",t:"Calculate",d:"The spread, slippage, and annualized APR are computed accounting for platform fees. You see exactly what the trade is worth before committing."},
            {num:"3",t:"Execute",d:"Buy YES on the underpriced platform and NO on the overpriced one. Collect guaranteed profit when the event resolves, regardless of outcome."}
          ].map((step,i)=>(
            <ScrollReveal key={i} animation="revealScale" delay={i*0.12} duration={0.6}>
              <Card style={{padding:"32px 28px",textAlign:"center",height:"100%"}} className="pl-step-card">
                <div className="pl-step-num" style={{fontSize:48,fontWeight:300,fontFamily:T.display,letterSpacing:"-2px",marginBottom:16,opacity:0.35,transition:"all 0.4s ease",color:T.textTertiary}}>{step.num}</div>
                <h3 style={{fontSize:18,fontWeight:600,color:T.text,marginBottom:10,fontFamily:T.display}}>{step.t}</h3>
                <p style={{fontSize:13,color:T.textSecondary,lineHeight:1.65,fontWeight:400}}>{step.d}</p>
              </Card>
            </ScrollReveal>
          ))}
        </div>
      </section>

      <ScrollReveal animation="revealLine" duration={0.8} style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{height:1,background:`linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)`,transformOrigin:"center"}}/>
      </ScrollReveal>

      {/* ─── LIVE PREVIEW SECTION ─── */}
      <section style={{maxWidth:1100,margin:"0 auto",padding:"80px 24px",position:"relative",zIndex:10}}>
        <ScrollReveal animation="revealUp" duration={0.7}>
          <div style={{textAlign:"center",marginBottom:36}}>
            <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"5px 16px",borderRadius:100,background:"rgba(52,199,89,0.10)",border:"1px solid rgba(52,199,89,0.25)",marginBottom:14}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:T.positive,animation:"hotPulse 2s ease-in-out infinite"}}/>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.positive}}>LIVE PREVIEW</span>
            </div>
            <h2 style={{fontSize:32,fontWeight:300,color:T.text,letterSpacing:"-1px",fontFamily:T.display}}>Real markets, right now</h2>
            <p style={{fontSize:14,color:T.textSecondary,marginTop:10,fontWeight:400}}>A read-only snapshot of the top opportunities in the scanner.</p>
          </div>
        </ScrollReveal>
        <ScrollReveal animation="revealScale" delay={0.1} duration={0.65}>
        <Card hover={false} style={{padding:0,overflow:"hidden"}}>
          {/* Table header */}
          <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:0,padding:"10px 24px",borderBottom:"none",background:T.cardSolid}}>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,textTransform:"uppercase"}}>Event</span>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,textAlign:"center",minWidth:120}}>Prices</span>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,textAlign:"center",minWidth:70}}>Spread</span>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,textAlign:"right",minWidth:70}}>APR</span>
          </div>
          {MOCK.slice(0,3).map((mkt,i)=>{
            const pA=PLATFORMS.polymarket,pB=PLATFORMS.opinion;
            const priceA=mkt.prices.polymarket.yes;
            const priceB=mkt.prices.opinion.yes;
            const spread=(Math.abs(priceA-priceB)*100).toFixed(1);
            const days=Math.max(1,(new Date(mkt.expiry)-new Date())/86400000);
            const eff=Math.abs(priceA-priceB);
            const cb=Math.min(priceA,1-priceB)+Math.max(priceA,1-priceA)*(pA.fee);
            const apr=eff>0?((eff/(priceA+(1-priceB)))*(365/days)*100).toFixed(1):"0.0";
            const aprNum=parseFloat(apr);
            return(
              <div key={mkt.id} style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:0,padding:"16px 24px",borderTop:"1px solid rgba(255,255,255,0.025)",alignItems:"center",transition:"background .2s",cursor:"default"}}
                onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.015)";}}
                onMouseOut={e=>{e.currentTarget.style.background="transparent";}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:3}}>{mkt.event}</div>
                  <span style={{fontSize:8,fontFamily:T.mono,color:T.textTertiary,letterSpacing:1}}>{mkt.category} · Exp {new Date(mkt.expiry).toLocaleDateString("en-GB",{month:"short",year:"numeric"})}</span>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center",minWidth:120,justifyContent:"center"}}>
                  <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 9px",borderRadius:8,background:`${pA.color}16`,border:`1px solid ${pA.color}33`,fontFamily:T.mono,fontSize:11,fontWeight:700,color:pA.color}}>
                    <span style={{fontSize:9}}>{pA.icon}</span>{(priceA*100).toFixed(1)}¢
                  </span>
                  <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 9px",borderRadius:8,background:`${pB.color}16`,border:`1px solid ${pB.color}33`,fontFamily:T.mono,fontSize:11,fontWeight:700,color:pB.color}}>
                    <span style={{fontSize:9}}>{pB.icon}</span>{(priceB*100).toFixed(1)}¢
                  </span>
                </div>
                <div style={{textAlign:"center",minWidth:70}}>
                  <span style={{padding:"3px 10px",borderRadius:8,fontFamily:T.mono,fontWeight:600,fontSize:11,background:parseFloat(spread)>=4?"rgba(52,199,89,0.10)":parseFloat(spread)>=2?"rgba(212,168,67,0.08)":"rgba(224,85,85,0.08)",border:`1px solid ${parseFloat(spread)>=4?T.positive:parseFloat(spread)>=2?T.warning:T.negativeRaw}33`,color:parseFloat(spread)>=4?T.positive:parseFloat(spread)>=2?T.warning:T.negativeRaw}}>{spread}%</span>
                </div>
                <div style={{textAlign:"right",minWidth:70}}>
                  <span style={{fontFamily:T.mono,fontWeight:600,fontSize:14,...(aprNum>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:aprNum>0?{color:T.positive}:{color:T.negativeRaw})}}>{aprNum>0?"+":""}{apr}%</span>
                </div>
              </div>
            );
          })}
          {/* CTA row */}
          <div style={{padding:"16px 24px",background:"rgba(255,255,255,0.012)",borderTop:"1px solid rgba(255,255,255,0.025)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
            <span style={{fontSize:11,color:T.textTertiary,fontFamily:T.mono,letterSpacing:0.3}}>Showing 3 of {MOCK.length} markets. Real-time data available in the scanner.</span>
            <button onClick={()=>nav("dashboard")} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"9px 22px",borderRadius:100,border:"none",cursor:"pointer",background:"#ffffff",color:"#000000",fontFamily:T.mono,fontSize:11,fontWeight:700,letterSpacing:1,transition:"all .25s",boxShadow:"0 4px 20px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.9)"}}
              onMouseOver={e=>{e.currentTarget.style.transform="scale(1.04)";e.currentTarget.style.boxShadow="0 6px 28px rgba(255,255,255,0.22)";}}
              onMouseOut={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.boxShadow="0 4px 20px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.9)";}}>
              See All Markets <IA/>
            </button>
          </div>
        </Card>
        </ScrollReveal>
      </section>

      <ScrollReveal animation="revealLine" duration={0.8} style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{height:1,background:`linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)`,transformOrigin:"center"}}/>
      </ScrollReveal>

      <section style={{maxWidth:1060,margin:"0 auto",padding:"80px 24px",position:"relative",zIndex:10}}>
        <ScrollReveal animation="revealUp" duration={0.7}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <span style={{fontSize:10,fontWeight:600,color:T.textTertiary,letterSpacing:3,fontFamily:T.mono}}>PRICING</span>
          <h2 style={{fontSize:42,fontWeight:300,color:T.text,marginTop:16,letterSpacing:"-1.5px",fontFamily:T.display}}>Simple, transparent pricing</h2>
          {/* Social proof */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginTop:20}}>
            <div style={{display:"flex",alignItems:"center"}}>
              {["#4C8BF5","#E8853D","#00C9A7","#A855F7","#D0D0D0"].map((c,i)=>(
                <div key={i} style={{width:28,height:28,borderRadius:"50%",background:c,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,fontFamily:T.mono,color:"#000",marginLeft:i>0?-8:0,border:"2px solid #060606",position:"relative",zIndex:5-i}}>
                  {["S","M","J","K","A"][i]}
                </div>
              ))}
            </div>
            <span style={{fontSize:12,fontFamily:T.body,color:T.textSecondary,fontWeight:500}}>Join <span style={{color:T.text,fontWeight:700}}>1,200+</span> traders already on the waitlist</span>
          </div>
        </div>
        </ScrollReveal>
        <ScrollReveal animation="revealFade" duration={0.5} delay={0.1}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:40}}>
          <div style={{display:"flex",background:"rgba(255,255,255,0.012)",backdropFilter:"blur(100px) saturate(1.30)",borderRadius:14,padding:3,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)"}}>
            {[false,true].map(a=>(
              <button key={String(a)} onClick={()=>setAnnual(a)} style={{padding:"9px 22px",borderRadius:9,border:"none",cursor:"pointer",background:annual===a?"rgba(255,255,255,0.03)":"transparent",backdropFilter:annual===a?"blur(40px) saturate(1.25)":"none",color:annual===a?"#ffffff":T.textTertiary,fontWeight:500,fontSize:12,fontFamily:T.mono,transition:"all .2s",letterSpacing:0.5,boxShadow:annual===a?"0 1px 6px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)":"none",display:"inline-flex",alignItems:"center",gap:6}}>{a?"Annual":"Monthly"}{a&&<span style={{fontSize:8,fontWeight:700,letterSpacing:0.5,padding:"2px 6px",borderRadius:100,background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",color:"#000",lineHeight:1.2}}>SAVE 22%</span>}</button>
            ))}
          </div>
        </div>
        </ScrollReveal>
        <div className="pl-pricing-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:16,paddingTop:16,alignItems:"stretch"}}>
          {[{n:"Starter",p:annual?19:25,d:"For curious traders",f:["Polymarket + Opinion Labs","Updates every 10 min","5 alerts / day","Basic profit calculator","Email support"],pop:false},{n:"Pro",p:annual?79:99,d:"For serious traders",f:["All Starter features","Real-time updates (30s)","Unlimited Telegram alerts","APR & fee analytics","Priority support","API access"],pop:true},{n:"Whale",p:annual?249:299,d:"Full auto-execution",f:["All Pro features","WebSocket live feed","Auto-execution bot","Discord + Telegram","Copy-trading","Custom integrations","Dedicated support"],pop:false}].map((pl,i)=>(
            <ScrollReveal key={i} animation="revealScale" delay={i*0.12} duration={0.65} style={{display:"flex",flexDirection:"column",flex:1,minHeight:0}}>
            <Card accent={pl.pop} style={{padding:36,position:"relative",overflow:"visible",display:"flex",flexDirection:"column",flex:"1 1 0"}}>
              {pl.pop&&<div style={{position:"absolute",top:-14,left:"50%",transform:"translateX(-50%)",background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",color:"#000",padding:"5px 18px",borderRadius:100,fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,boxShadow:"0 4px 12px rgba(0,0,0,0.3)",whiteSpace:"nowrap"}}>POPULAR</div>}
              <h3 style={{fontSize:20,fontWeight:600,color:T.text}}>{pl.n}</h3>
              <p style={{fontSize:13,color:T.textSecondary,marginTop:4}}>{pl.d}</p>
              <div style={{marginTop:24,marginBottom:28}}>
                <span style={{fontSize:48,fontWeight:300,color:T.text,fontFamily:T.display,letterSpacing:"-2px"}}>${pl.p}</span>
                <span style={{color:T.textTertiary,fontSize:14,fontWeight:400}}> /mo</span>
              </div>
              <button style={{width:"100%",padding:"12px 0",borderRadius:980,cursor:"pointer",fontWeight:pl.pop?700:600,fontSize:13,fontFamily:T.body,marginBottom:28,transition:"all .25s",background:pl.pop?T.aurora:pl.n==="Starter"?"rgba(255,255,255,0.015)":"rgba(255,255,255,0.015)",backgroundSize:pl.pop?"300% 300%":undefined,animation:pl.pop?"aShift 4s ease infinite":undefined,backdropFilter:pl.pop?"none":"blur(40px) saturate(1.25)",color:pl.pop?"#000":T.text,border:"none",boxShadow:pl.pop?"0 4px 24px rgba(0,0,0,0.3), 0 0 24px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.2)":"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.20)"}} onClick={()=>setShowWaitlist(true)}>{pl.pop?"Start Free Trial →":pl.n==="Starter"?"Get Started →":"Contact Sales →"}</button>
              <div style={{display:"flex",flexDirection:"column",gap:14,flex:1}}>
                {pl.f.map((feat,j)=>(
                  <div key={j} style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{color:T.positive,flexShrink:0}}><IC/></span>
                    <span style={{fontSize:13,color:T.text,fontWeight:400}}>{feat}</span>
                  </div>
                ))}
              </div>
            </Card>
            </ScrollReveal>
          ))}
        </div>
      </section>

      <ScrollReveal animation="revealLine" duration={0.8} style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{height:1,background:`linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent)`,transformOrigin:"center"}}/>
      </ScrollReveal>

      <section style={{padding:"80px 24px",textAlign:"center",position:"relative",zIndex:10}}>
        <ScrollReveal animation="revealScale" duration={0.8}>
        <Card accent hover={false} style={{maxWidth:680,margin:"0 auto",padding:"72px 48px"}}>
          <h2 style={{fontSize:38,fontWeight:300,color:T.text,letterSpacing:"-1.5px",marginBottom:16,fontFamily:T.display}}>Start finding arbitrage</h2>
          <p style={{fontSize:15,color:T.textSecondary,marginBottom:40,maxWidth:420,margin:"0 auto 40px",fontWeight:400}}>Free scanner with mock data. No credit card required.</p>
          <GlassBtn primary onClick={()=>nav("dashboard")}>Launch prophetLabs <IA/></GlassBtn>
        </Card>
        </ScrollReveal>
      </section>

      <ScrollReveal animation="revealUp" duration={0.7}>
      <Footer maxWidth={1100} onLegalOpen={onLegalOpen}/>
      </ScrollReveal>
      <WaitlistModal open={showWaitlist} onClose={()=>setShowWaitlist(false)}/>
    </div>
  );
};


// ═══════════════════════════════════════════════════════════
// DASHBOARD

// ─── ALERT PANEL ───────────────────────────────────────────
const AlertPanel=({cfg,setCfg,onClose})=>{
  const ml={...S.monoLabel,marginBottom:6};
  const channels=["Telegram","Email"];
  const placeholders={Telegram:"@username or phone number",Email:"you@example.com"};
  return(
    <Card hover={false} style={{padding:0,marginBottom:20,overflow:"hidden"}}>
      <div style={{padding:"14px 24px 10px",borderBottom:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><IBe/><span style={{fontSize:13,fontWeight:600,color:T.text}}>Alert Configuration</span></div>
        <button onClick={onClose} style={{background:"none",border:"none",borderRadius:8,padding:"4px 12px",color:T.textSecondary,fontSize:9,fontFamily:T.mono,cursor:"pointer",letterSpacing:1,transition:"color .2s"}} onMouseOver={e=>e.currentTarget.style.color=T.text} onMouseOut={e=>e.currentTarget.style.color=T.textSecondary}>CLOSE ✕</button>
      </div>
      {/* Demo-mode warning banner */}
      <div style={{margin:"0 24px 10px",padding:"10px 14px",borderRadius:12,background:`${T.warning}18`,border:`1px solid ${T.warning}44`,display:"flex",alignItems:"flex-start",gap:10,boxShadow:`inset 0 1px 0 ${T.warning}22`}}>
        <span style={{fontSize:14,flexShrink:0,marginTop:1}}>⚠</span>
        <span style={{fontSize:11,fontFamily:T.mono,color:T.warning,lineHeight:1.55,fontWeight:500,letterSpacing:0.2}}>Alert delivery is not active in demo mode. In production, alerts would be sent via Telegram.</span>
      </div>
      <div className="pl-filter-grid" style={{padding:"14px 24px 18px",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
        {/* Col 1 — APR threshold */}
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow}}>
          <div style={ml}>Min APR Threshold</div>
          <div style={{fontSize:16,fontWeight:600,color:T.text,fontFamily:T.mono,marginBottom:6}}>{cfg.threshold}%</div>
          <input type="range" min={1} max={100} step={1} value={cfg.threshold} onChange={e=>setCfg(p=>({...p,threshold:Number(e.target.value),saved:false}))} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>1%</span>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono}}>100%</span>
          </div>
          <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,marginTop:4}}>Notify when APR exceeds threshold</div>
        </div>
        {/* Col 2 — Channel + contact */}
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow,display:"flex",flexDirection:"column",gap:10}}>
          <div>
            <div style={ml}>Notification Channel</div>
            <div style={{display:"flex",gap:6}}>
              {channels.map(ch=>(
                <button key={ch} onClick={()=>setCfg(p=>({...p,channel:ch,saved:false}))}
                  style={{flex:1,padding:"8px 10px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:10,fontWeight:600,letterSpacing:0.5,
                    background:cfg.channel===ch?"rgba(255,255,255,0.04)":"rgba(255,255,255,0.012)",
                    color:cfg.channel===ch?T.text:T.textTertiary,
                    boxShadow:cfg.channel===ch?"inset 0 1px 0 rgba(255,255,255,0.14), 0 4px 16px rgba(0,0,0,0.25)":"inset 0 1px 0 rgba(255,255,255,0.06)",
                    transition:"all .2s"}}>{ch}</button>
              ))}
            </div>
          </div>
          <div>
            <div style={ml}>{cfg.channel} Contact</div>
            <input type={cfg.channel==="Email"?"email":"text"} placeholder={placeholders[cfg.channel]||""} value={cfg.contact||""} onChange={e=>setCfg(p=>({...p,contact:e.target.value,saved:false}))}
              style={{width:"100%",padding:"8px 12px",borderRadius:10,border:"none",background:"rgba(255,255,255,0.02)",backdropFilter:"blur(110px) saturate(1.35)",fontFamily:T.mono,fontSize:12,color:T.text,outline:"none",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)",transition:"box-shadow .3s",boxSizing:"border-box"}}
              onFocus={e=>{e.target.style.boxShadow="0 0 0 3px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.10)";}}
              onBlur={e=>{e.target.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)";}}/>
          </div>
        </div>
        {/* Col 3 — Status + save */}
        <div style={{background:"rgba(255,255,255,0.015)",backdropFilter:T.blur,borderRadius:18,border:"none",padding:"16px 18px",boxShadow:T.glassShadow,display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
          <div>
            <div style={ml}>Status</div>
            <div style={{fontSize:11,color:T.textTertiary,fontFamily:T.mono,lineHeight:1.6,marginBottom:12}}>
              Notify via <span style={{color:T.text,fontWeight:600}}>{cfg.channel}</span>{cfg.contact?<> at <span style={{color:T.text,fontWeight:600}}>{cfg.contact}</span></>:""} when any market exceeds <span style={{color:T.text,fontWeight:600}}>{cfg.threshold}%</span> APR.
            </div>
            <div style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,fontStyle:"italic",opacity:0.7}}>Demo mode: notifications paused.</div>
          </div>
          <button onClick={()=>setCfg(p=>({...p,saved:true}))}
            style={{marginTop:12,padding:"10px 16px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:11,letterSpacing:1.5,
              background:cfg.saved?"rgba(52,199,89,0.12)":"rgba(255,255,255,0.04)",
              color:cfg.saved?T.positive:T.text,
              boxShadow:cfg.saved?"inset 0 1px 0 rgba(52,199,89,0.2), 0 4px 16px rgba(52,199,89,0.08)":"inset 0 1px 0 rgba(255,255,255,0.12), 0 4px 16px rgba(0,0,0,0.25)",
              transition:"all .25s",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}
            onMouseOver={e=>{if(!cfg.saved){e.currentTarget.style.background="rgba(255,255,255,0.07)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.18), 0 4px 20px rgba(0,0,0,0.3)";}}}
            onMouseOut={e=>{if(!cfg.saved){e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.12), 0 4px 16px rgba(0,0,0,0.25)";}}}
          >{cfg.saved?<><IC/> Saved</>:"Save"}</button>
        </div>
      </div>
    </Card>
  );
};

// ─── INFO TOOLTIP ──────────────────────────────────────────
const InfoTip=({text})=>{
  const[show,setShow]=React.useState(false);
  const spanRef=React.useRef(null);
  const handleEnter=()=>{
    setShow(true);
    const th=spanRef.current?.closest("th");
    if(th)th.style.zIndex="9999";
  };
  const handleLeave=()=>{
    setShow(false);
    const th=spanRef.current?.closest("th");
    if(th)th.style.zIndex="10";
  };
  return(
    <span ref={spanRef} style={{position:"relative",display:"inline-flex",alignItems:"center",marginLeft:5,cursor:"help",zIndex:show?99999:0}}
      onMouseEnter={handleEnter} onMouseLeave={handleLeave}
      onFocus={handleEnter} onBlur={handleLeave}>
      <span tabIndex={0} role="button" aria-label="More info" style={{fontSize:8,fontFamily:T.mono,color:T.textTertiary,border:"1px solid "+T.textTertiary,borderRadius:"50%",width:13,height:13,display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,fontWeight:700,opacity:0.7,outline:"none"}}
        onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setShow(s=>!s);}}}>i</span>
      {show&&<div role="tooltip" style={{position:"absolute",top:"calc(100% + 6px)",left:"50%",transform:"translateX(-50%)",background:"rgba(20,20,20,0.97)",backdropFilter:"blur(100px) saturate(1.30)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,padding:"10px 14px",fontSize:11,color:T.text,fontFamily:T.body,fontWeight:400,lineHeight:1.5,width:240,zIndex:99999,boxShadow:"0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)",pointerEvents:"none",whiteSpace:"normal",letterSpacing:"normal",textTransform:"none"}}>
        <div style={{position:"absolute",top:-4,left:"50%",transform:"translateX(-50%) rotate(45deg)",width:8,height:8,background:"rgba(20,20,20,0.97)",borderLeft:"1px solid rgba(255,255,255,0.12)",borderTop:"1px solid rgba(255,255,255,0.12)"}}/>
        {text}
      </div>}
    </span>
  );
};

// ─── MINI DEPTH CHART (Order Book tab) ─────────────────────
const MiniDepthChart=({market,pAColor,pBColor})=>{
  const bids=useMemo(()=>market?genBook(market.polymarket?.yes||0.5,market.bookDepth||50000,"bid"):[],[market?.id]);
  const asks=useMemo(()=>market?genBook(market.polymarket?.yes||0.5,market.bookDepth||50000,"ask"):[],[market?.id]);
  const W=500,H=100,pad={l:6,r:6,t:8,b:8};
  const pH=H-pad.t-pad.b,pW=W-pad.l-pad.r;
  const midPrice=market?.polymarket?.yes||0.5;
  const bidMinP=bids.length>0?bids[bids.length-1].price:midPrice*0.9;
  const askMaxP=asks.length>0?asks[asks.length-1].price:midPrice*1.1;
  const maxCum=Math.max(bids.length>0?bids[bids.length-1].cumulative:1,asks.length>0?asks[asks.length-1].cumulative:1);
  const xRange=askMaxP-bidMinP||0.1;
  const pxF=p=>pad.l+((p-bidMinP)/xRange)*pW;
  const qyF=q=>pad.t+pH-Math.min(pH,(q/maxCum)*pH);
  const midX=pxF(midPrice);
  // Build polygon points
  const bidPts=bids.map(l=>`${pxF(l.price).toFixed(1)},${qyF(l.cumulative).toFixed(1)}`).join(" ");
  const bidFill=bids.length>0?`${pxF(bids[0].price).toFixed(1)},${(pad.t+pH).toFixed(1)} ${bidPts} ${pxF(bids[bids.length-1].price).toFixed(1)},${(pad.t+pH).toFixed(1)}`:"";
  const askPts=asks.map(l=>`${pxF(l.price).toFixed(1)},${qyF(l.cumulative).toFixed(1)}`).join(" ");
  const askFill=asks.length>0?`${pxF(asks[0].price).toFixed(1)},${(pad.t+pH).toFixed(1)} ${askPts} ${pxF(asks[asks.length-1].price).toFixed(1)},${(pad.t+pH).toFixed(1)}`:"";
  return(
    <div style={{marginBottom:16,borderRadius:12,overflow:"hidden",background:"rgba(255,255,255,0.012)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)"}}>
      <div style={{padding:"8px 14px 4px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontSize:8,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>CUMULATIVE DEPTH</span>
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:8,fontFamily:T.mono,color:"rgba(52,199,89,0.8)"}}>
            <span style={{width:8,height:8,borderRadius:1,background:"rgba(52,199,89,0.5)",display:"inline-block"}}/>BIDS
          </span>
          <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:8,fontFamily:T.mono,color:"rgba(224,85,85,0.8)"}}>
            <span style={{width:8,height:8,borderRadius:1,background:"rgba(224,85,85,0.5)",display:"inline-block"}}/>ASKS
          </span>
          <span style={{fontSize:8,fontFamily:T.mono,color:T.textTertiary}}>MID: {(midPrice*100).toFixed(1)}¢</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:"100%",height:H,display:"block"}}>
        <defs>
          <linearGradient id="bidDepth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(52,199,89,0.55)"/>
            <stop offset="100%" stopColor="rgba(52,199,89,0.05)"/>
          </linearGradient>
          <linearGradient id="askDepth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(224,85,85,0.55)"/>
            <stop offset="100%" stopColor="rgba(224,85,85,0.05)"/>
          </linearGradient>
        </defs>
        {/* Bid area - green from left */}
        {bidFill&&<polygon points={bidFill} fill="url(#bidDepth)"/>}
        {bidPts&&<polyline points={bidPts} fill="none" stroke="rgba(52,199,89,0.85)" strokeWidth="1.5"/>}
        {/* Ask area - red from right */}
        {askFill&&<polygon points={askFill} fill="url(#askDepth)"/>}
        {askPts&&<polyline points={askPts} fill="none" stroke="rgba(224,85,85,0.85)" strokeWidth="1.5"/>}
        {/* Mid price vertical line */}
        <line x1={midX} y1={pad.t} x2={midX} y2={pad.t+pH} stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="3 2"/>
      </svg>
    </div>
  );
};

// ─── PER-ROW APR TOOLTIP ────────────────────────────────────
const AprCellTip=({apr,spread,costBasis,daysToExpiry,pAFee,pBFee,priceA,priceB})=>{
  const[show,setShow]=React.useState(false);
  const ref=React.useRef(null);
  return(
    <span ref={ref} style={{position:"relative",display:"inline-block",cursor:"help"}}
      onMouseEnter={()=>{setShow(true);const td=ref.current?.closest("td");if(td)td.style.zIndex="9999";}}
      onMouseLeave={()=>{setShow(false);const td=ref.current?.closest("td");if(td)td.style.zIndex="auto";}}>
      <span style={{fontFamily:T.display,fontWeight:apr>30?600:400,fontSize:16,letterSpacing:"-0.5px",...(apr>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:apr>0?{color:T.positive}:{color:T.negativeRaw})}}>{apr>0?"+":""}{apr.toFixed(1)}%</span>
      {show&&<div role="tooltip" style={{position:"absolute",bottom:"calc(100% + 8px)",right:0,background:"rgba(20,20,20,0.97)",backdropFilter:"blur(100px) saturate(1.30)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"12px 14px",width:240,zIndex:99999,boxShadow:"0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)",pointerEvents:"none",whiteSpace:"normal",letterSpacing:"normal",textTransform:"none"}}>
        <div style={{position:"absolute",bottom:-4,right:16,transform:"rotate(45deg)",width:8,height:8,background:"rgba(20,20,20,0.97)",borderRight:"1px solid rgba(255,255,255,0.12)",borderBottom:"1px solid rgba(255,255,255,0.12)"}}/>
        <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:8}}>APR BREAKDOWN</div>
        {[
          ["Spread",`${(spread*100).toFixed(2)}%`],
          ["Buy YES @",`${(priceA*100).toFixed(1)}¢ (fee ${(pAFee*100).toFixed(2)}%)`],
          ["Buy NO @",`${((1-priceB)*100).toFixed(1)}¢ (fee ${(pBFee*100).toFixed(2)}%)`],
          ["Cost Basis",`$${costBasis.toFixed(4)}`],
          ["Days to Expiry",`${Math.round(daysToExpiry)}d`],
        ].map(([l,v],i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:i<4?"1px solid rgba(255,255,255,0.04)":"none"}}>
            <span style={{fontSize:10,fontFamily:T.mono,color:T.textTertiary}}>{l}</span>
            <span style={{fontSize:10,fontFamily:T.mono,color:T.text,fontWeight:500}}>{v}</span>
          </div>
        ))}
        <div style={{marginTop:6,padding:"6px 8px",borderRadius:6,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)"}}>
          <div style={{fontSize:9,fontFamily:T.mono,color:T.textTertiary,lineHeight:1.6,letterSpacing:0.3}}>
            APR = (1 − cost) / cost × 365 / days<br/>
            <span style={{color:T.text,fontWeight:600}}>= {apr.toFixed(1)}%</span>
          </div>
        </div>
      </div>}
    </span>
  );
};

// ═══════════════════════════════════════════════════════════
const Dash=({onNavigate:nav,effectsDisabled,toggleEffects,onLegalOpen})=>{
  const[sortBy,setSortBy]=useState("signal");
  const[sortDir,setSortDir]=useState("desc");
  const[search,setSearch]=useState("");
  const[lastUpdate,setLastUpdate]=useState(new Date());
  const[prices,setPrices]=useState(()=>MOCK.map(p=>{const allP={};PLATFORM_KEYS.forEach(k=>{allP[k]=p.prices?.[k]||{yes:0.5,no:0.5};});const pm=allP.polymarket;const op=allP.opinion;const cb=pm.yes*1.0217+(1-op.yes);const np=1-cb;const dte=Math.max(1,(new Date(p.expiry)-new Date())/86400000);return{...p,allPrices:allP,polymarket:pm,opinion:op,polyName:p.names?.polymarket||p.polyName,opinName:p.names?.opinion||p.opinName,apr:cb>0?(np/cb)*(365/dte)*100:0};}));
  const[sel,setSel]=useState(null);
  const[showF,setShowF]=useState(false);
  const[filters,setFilters]=useState({expiryDays:500,minVolume:0,minLiquidity:1000,minApr:0});
  const[expanded,setExpanded]=useState(null);
  const[wager,setWager]=useState(1000);
  const[showAlerts,setShowAlerts]=useState(false);
  const[alertsClosing,setAlertsClosing]=useState(false); // kept for compat, unused
  const[alertCfg,setAlertCfg]=useState({threshold:10,channel:"Telegram",contact:"",saved:false});
  const[catFilter,setCatFilter]=useState("All");
  const[savedMarkets,setSavedMarkets]=useState(new Set());
  const[prefsLoaded,setPrefsLoaded]=useState(false);
  const[profitableOnly,setProfitableOnly]=useState(true);

  // ── LIVE DATA STATE ──────────────────────────────────────
  const[dataMode,setDataMode]=useState("mock"); // "mock" | "live"
  const[loading,setLoading]=useState(false);
  const[apiError,setApiError]=useState(null);
  const[liveStats,setLiveStats]=useState({kalshi:{count:0,ms:null},predict:{count:0,ms:null}});
  const[apiKeys,setApiKeys]=useState({predict:""});
  const[wsStatus,setWsStatus]=useState({kalshi:"closed",predict:"closed",local:"closed"});
  const wsKalshiRef=useRef(null);
  const wsPredictRef=useRef(null);
  const wsLocalRef=useRef(null);
  const wsStatusRef=useRef({kalshi:"closed",predict:"closed",local:"closed"});
  const predictHeartbeatRef=useRef(null);
  const kalshiReconnRef=useRef(null);
  const predictReconnRef=useRef(null);
  const localReconnRef=useRef(null);
  const wsMarketIndexRef=useRef({});

  // Rebuild WS market index when prices change
  useEffect(()=>{
    const idx={};
    prices.forEach(p=>{
      if(p._sources?.kalshi)idx["k:"+p._sources.kalshi]=p.id;
      if(p._sources?.predict)idx["p:"+p._sources.predict]=p.id;
      if(p.localId)idx["local:"+p.localId]=p.id;
    });
    wsMarketIndexRef.current=idx;
  },[prices]);

  // Apply a single WS price tick
  const applyTick=useCallback((marketId,platform,yesPrice)=>{
    if(!marketId||yesPrice==null)return;
    setPrices(prev=>{
      const idx=prev.findIndex(p=>p.id===marketId);
      if(idx<0)return prev;
      const p=prev[idx];
      const newAll={...(p.allPrices||p.prices||{})};
      newAll[platform]={yes:yesPrice,no:parseFloat((1-yesPrice).toFixed(4))};
      const newPoly=newAll.polymarket||p.polymarket||{yes:0.5,no:0.5};
      const newOpin=newAll.opinion||p.opinion||{yes:0.5,no:0.5};
      const cb=newPoly.yes*1.0217+(1-newOpin.yes);
      const np=1-cb;
      const dte=Math.max(1,(new Date(p.expiry)-new Date())/86400000);
      const apr=cb>0?(np/cb)*(365/dte)*100:0;
      const newSpread=Math.max(0,Math.abs(newPoly.yes-newOpin.yes));
      const updated={...p,allPrices:newAll,polymarket:newPoly,opinion:newOpin,spread:newSpread,apr};
      const next=[...prev];next[idx]=updated;
      const oldApr=prevAprs.current[marketId];
      if(oldApr!==undefined){const diff=apr-oldApr;if(Math.abs(diff)>1){setFlashRows(f=>({...f,[marketId]:diff>0?"green":"red"}));setTimeout(()=>setFlashRows(f=>{const n={...f};delete n[marketId];return n;}),600);}}
      prevAprs.current[marketId]=apr;
      setLastUpdate(new Date());
      return next;
    });
  },[]);

  // Fetch live data from backend + Kalshi + Predict
  const fetchLiveData=useCallback(async()=>{
    setLoading(true);setApiError(null);
    const t0=Date.now();
    try{
      // Kalshi (public, no auth)
      const kalshiRaw=await fetchWithFallback(()=>fetchKalshiMarkets({status:"open",limit:200}),{markets:[]});
      const kalshiMs=Date.now()-t0;
      const kalshiNorm=(kalshiRaw.markets||[]).map(normalizeKalshiMarket);

      // Predict (needs API key)
      let predictNorm=[],predictMs=null;
      if(apiKeys.predict){
        const t1=Date.now();
        const predictRaw=await fetchWithFallback(()=>fetchPredictMarkets(apiKeys.predict),{data:[]});
        predictMs=Date.now()-t1;
        predictNorm=(predictRaw.data||[]).map(normalizePredictMarket);
      }
      setLiveStats({kalshi:{count:kalshiNorm.length,ms:kalshiMs},predict:{count:predictNorm.length,ms:predictMs}});

      // Build unified list from Kalshi + Predict
      let unified=buildUnifiedMarkets(kalshiNorm,predictNorm);

      // Local backend (Polymarket + Opinion Labs)
      let localPairs=[];
      try{
        const localRes=await fetch(`${API_CONFIG.local.baseUrl}/api/pairs`);
        if(localRes.ok){const json=await localRes.json();localPairs=json.pairs||[];}
      }catch(e){console.warn("Local backend unavailable:",e);}

      // Merge local pairs into unified
      localPairs.forEach(lp=>{
        const pricesObj=lp.prices||{};
        const op=pricesObj.opinion||{yes:0.5,no:0.5};
        const pm=pricesObj.polymarket||{yes:0.5,no:0.5};
        let bestMatch=null,bestScore=0;
        unified.forEach(u=>{const score=calculateSimilarity(lp.event||lp.pair_key||"",u.event);if(score>bestScore){bestScore=score;bestMatch=u;}});
        if(bestMatch&&bestScore>0.4){
          bestMatch.names.polymarket=lp.polyName||lp.event||lp.pair_key;
          bestMatch.names.opinion=lp.opinName||lp.event||lp.pair_key;
          bestMatch.prices.polymarket=pm;bestMatch.prices.opinion=op;
          bestMatch._sources=bestMatch._sources||{};
          bestMatch._sources.polymarket=lp.pair_key;bestMatch._sources.opinion=lp.pair_key;
          bestMatch.localId=lp.id;
          bestMatch.apr=Math.max(bestMatch.apr,lp.apr||0);
          bestMatch.volume+=(lp.volume||0);
        }else{
          unified.push({
            id:Date.now()+Math.floor(Math.random()*1000000),localId:lp.id,
            event:lp.event||lp.pair_key,
            names:{kalshi:lp.names?.kalshi||"—",predict:lp.names?.predict||"—",polymarket:lp.names?.polymarket||lp.event||lp.pair_key||"—",opinion:lp.names?.opinion||lp.event||lp.pair_key||"—"},
            category:lp.category,
            prices:{kalshi:pricesObj.kalshi||{yes:0.5,no:0.5},predict:pricesObj.predict||{yes:0.5,no:0.5},polymarket:pm,opinion:op},
            spread:lp.spread||0,apr:lp.apr||0,volume:lp.volume||0,
            expiry:lp.expiry||new Date().toISOString(),status:lp.status||"active",
            liquidity:lp.liquidity||0,bookDepth:lp.bookDepth||Math.max(50000,lp.volume||0),
            matchScore:0,_isMock:false,_sources:{polymarket:lp.pair_key,opinion:lp.pair_key},
          });
        }
      });

      // Shape into Dash's expected format
      setPrices(unified.map(p=>{
        const allP={};PLATFORM_KEYS.forEach(k=>{allP[k]=p.prices?.[k]||{yes:0.5,no:0.5};});
        const pm=allP.polymarket,op=allP.opinion;
        const cb=pm.yes*1.0217+(1-op.yes),np=1-cb;
        const dte=Math.max(1,(new Date(p.expiry)-new Date())/86400000);
        return{...p,allPrices:allP,polymarket:pm,opinion:op,polyName:p.names?.polymarket||p.event,opinName:p.names?.opinion||p.event,apr:cb>0?(np/cb)*(365/dte)*100:0};
      }));
    }catch(err){setApiError(err.message);console.error("fetchLiveData error:",err);}
    finally{setLoading(false);}
  },[apiKeys]);

  // Persist apiKeys and dataMode
  useEffect(()=>{window.storage.set("pl_api_keys",JSON.stringify(apiKeys)).catch(()=>{});},[apiKeys]);
  useEffect(()=>{window.storage.set("pl_data_mode",dataMode).catch(()=>{});},[dataMode]);

  // Load persisted apiKeys and dataMode on mount
  useEffect(()=>{(async()=>{
    try{const r=await window.storage.get("pl_api_keys");if(r?.value)setApiKeys(JSON.parse(r.value));}catch(e){}
    try{const r=await window.storage.get("pl_data_mode");if(r?.value)setDataMode(r.value);}catch(e){}
  })();},[]);

  // Trigger fetch when switching to live mode
  useEffect(()=>{if(dataMode==="live")fetchLiveData();},[dataMode]);// eslint-disable-line

  // WebSocket: applyTick helper (Kalshi)
  const connectKalshiWs=useCallback(()=>{
    if(wsKalshiRef.current?.readyState===WebSocket.OPEN)return;
    try{
      const ws=new WebSocket("wss://api.elections.kalshi.com/trade-api/v2/ws");
      wsKalshiRef.current=ws;
      ws.onopen=()=>{wsStatusRef.current.kalshi="open";setWsStatus(s=>({...s,kalshi:"open"}));ws.send(JSON.stringify({id:1,cmd:"subscribe",params:{channels:["ticker"]}}));if(kalshiReconnRef.current){clearTimeout(kalshiReconnRef.current);kalshiReconnRef.current=null;}};
      ws.onmessage=(e)=>{try{const msg=JSON.parse(e.data);const data=msg.msg||msg;const ticker=data.market_ticker||data.ticker;if(!ticker)return;const marketId=wsMarketIndexRef.current["k:"+ticker];if(!marketId)return;const yesPrice=data.yes_bid_dollars!=null?parseFloat(data.yes_bid_dollars):data.yes_bid!=null?data.yes_bid/100:null;if(yesPrice!=null)applyTick(marketId,"kalshi",yesPrice);countdownRef.current=30;setCountdown(30);}catch(err){}};
      ws.onerror=()=>{wsStatusRef.current.kalshi="error";setWsStatus(s=>({...s,kalshi:"error"}));};
      ws.onclose=()=>{wsStatusRef.current.kalshi="closed";setWsStatus(s=>({...s,kalshi:"closed"}));if(wsStatusRef.current._active)kalshiReconnRef.current=setTimeout(()=>connectKalshiWs(),5000);};
    }catch(err){setWsStatus(s=>({...s,kalshi:"unavailable"}));}
  },[applyTick]);

  // WebSocket: Predict
  const connectPredictWs=useCallback((apiKey)=>{
    if(!apiKey||wsPredictRef.current?.readyState===WebSocket.OPEN)return;
    try{
      const ws=new WebSocket(`wss://ws.predict.fun/ws?apiKey=${apiKey}`);
      wsPredictRef.current=ws;
      ws.onopen=()=>{wsStatusRef.current.predict="open";setWsStatus(s=>({...s,predict:"open"}));const ids=Object.keys(wsMarketIndexRef.current).filter(k=>k.startsWith("p:")).map(k=>k.slice(2));if(ids.length>0)ws.send(JSON.stringify({type:"subscribe",topics:ids.map(id=>({topic:"market",id}))}));predictHeartbeatRef.current=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"heartbeat",timestamp:Date.now()}));},15000);if(predictReconnRef.current){clearTimeout(predictReconnRef.current);predictReconnRef.current=null;}};
      ws.onmessage=(e)=>{try{const msg=JSON.parse(e.data);if(msg.type==="heartbeat"){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"heartbeat",timestamp:msg.timestamp}));return;}const data=msg.data||msg;const rawId=String(data.marketId||data.id||"");if(!rawId)return;const marketId=wsMarketIndexRef.current["p:"+rawId];if(!marketId)return;const yesPrice=data.lastPrice??data.bestBid??null;if(yesPrice!=null)applyTick(marketId,"predict",parseFloat(yesPrice));countdownRef.current=30;setCountdown(30);}catch(err){}};
      ws.onerror=()=>{wsStatusRef.current.predict="error";setWsStatus(s=>({...s,predict:"error"}));};
      ws.onclose=()=>{clearInterval(predictHeartbeatRef.current);wsStatusRef.current.predict="closed";setWsStatus(s=>({...s,predict:"closed"}));if(wsStatusRef.current._active)predictReconnRef.current=setTimeout(()=>connectPredictWs(apiKey),5000);};
    }catch(err){setWsStatus(s=>({...s,predict:"unavailable"}));}
  },[applyTick]);

  // WebSocket: Local backend (Polymarket + Opinion)
  const connectLocalWs=useCallback(()=>{
    if(wsLocalRef.current?.readyState===WebSocket.OPEN)return;
    try{
      const ws=new WebSocket(`${API_CONFIG.local.wsUrl}/ws/prices`);
      wsLocalRef.current=ws;
      ws.onopen=()=>{wsStatusRef.current.local="open";setWsStatus(s=>({...s,local:"open"}));if(localReconnRef.current){clearTimeout(localReconnRef.current);localReconnRef.current=null;}};
      ws.onmessage=(e)=>{try{const msg=JSON.parse(e.data);if(msg.type==="prices"||msg.type==="snapshot"){(msg.pairs||[]).forEach(p=>{const marketId=wsMarketIndexRef.current["local:"+p.id];if(marketId){if(p.prices?.polymarket?.yes!=null)applyTick(marketId,"polymarket",p.prices.polymarket.yes);if(p.prices?.opinion?.yes!=null)applyTick(marketId,"opinion",p.prices.opinion.yes);if(p.prices?.kalshi?.yes!=null)applyTick(marketId,"kalshi",p.prices.kalshi.yes);if(p.prices?.predict?.yes!=null)applyTick(marketId,"predict",p.prices.predict.yes);}});countdownRef.current=30;setCountdown(30);}}catch(err){}};
      ws.onerror=()=>{wsStatusRef.current.local="error";setWsStatus(s=>({...s,local:"error"}));};
      ws.onclose=()=>{wsStatusRef.current.local="closed";setWsStatus(s=>({...s,local:"closed"}));if(wsStatusRef.current._active)localReconnRef.current=setTimeout(()=>connectLocalWs(),5000);};
    }catch(err){setWsStatus(s=>({...s,local:"unavailable"}));}
  },[applyTick]);

  // Teardown all WebSockets
  const teardownWs=useCallback(()=>{
    wsStatusRef.current._active=false;
    clearTimeout(kalshiReconnRef.current);clearTimeout(predictReconnRef.current);clearTimeout(localReconnRef.current);clearInterval(predictHeartbeatRef.current);
    [wsKalshiRef,wsPredictRef,wsLocalRef].forEach(ref=>{if(ref.current&&ref.current.readyState!==WebSocket.CLOSED)ref.current.close();ref.current=null;});
    setWsStatus({kalshi:"closed",predict:"closed",local:"closed"});
  },[]);

  // WebSocket lifecycle tied to dataMode
  useEffect(()=>{
    if(dataMode!=="live"){teardownWs();return;}
    wsStatusRef.current._active=true;
    const t=setTimeout(()=>{connectKalshiWs();connectLocalWs();if(apiKeys.predict)connectPredictWs(apiKeys.predict);},1500);
    return()=>{clearTimeout(t);teardownWs();};
  },[dataMode,apiKeys.predict,connectKalshiWs,connectPredictWs,connectLocalWs,teardownWs]);

  // Load preferences from persistent storage on mount
  useEffect(()=>{
    (async()=>{
      try{
        const result=await window.storage.get('pl_user_prefs');
        if(result&&result.value){
          const prefs=JSON.parse(result.value);
          if(prefs.wager!=null&&!isNaN(prefs.wager))setWager(prefs.wager);
          if(prefs.alertCfg)setAlertCfg(prefs.alertCfg);
          if(prefs.savedMarkets&&Array.isArray(prefs.savedMarkets))setSavedMarkets(new Set(prefs.savedMarkets));
          if(prefs.profitableOnly!=null)setProfitableOnly(prefs.profitableOnly);
        }
      }catch(e){/* key doesn't exist yet, use defaults */}
      setPrefsLoaded(true);
    })();
  },[]);
  // Save preferences helper
  const savePrefs=useCallback((newWager,newAlertCfg,newSavedMarkets,newProfitableOnly)=>{
    const prefs={wager:newWager,alertCfg:newAlertCfg,savedMarkets:[...(newSavedMarkets||[])],profitableOnly:newProfitableOnly!=null?newProfitableOnly:true};
    window.storage.set('pl_user_prefs',JSON.stringify(prefs)).catch(()=>{});
  },[]);
  const toggleSaved=(id,e)=>{e&&e.stopPropagation();setSavedMarkets(prev=>{const next=new Set(prev);if(next.has(id))next.delete(id);else next.add(id);savePrefs(wager,alertCfg,next,profitableOnly);return next;});};
  const[toast,setToast]=useState(null);
  const[introDismissed,setIntroDismissed]=useState(true);
  useEffect(()=>{(async()=>{try{const r=await window.storage.get('pl_intro_dismissed');if(r&&r.value==='true')setIntroDismissed(true);else setIntroDismissed(false);}catch(e){setIntroDismissed(false);}})();},[]);
  const dismissIntro=()=>{setIntroDismissed(true);window.storage.set('pl_intro_dismissed','true').catch(()=>{});};
  // Auto-save wager and alertCfg to persistent storage when they change
  useEffect(()=>{if(prefsLoaded)savePrefs(wager,alertCfg,savedMarkets,profitableOnly);},[wager,alertCfg,prefsLoaded,profitableOnly]);
  const[countdown,setCountdown]=useState(30);
  const countdownRef=useRef(30);
  const[ringFlash,setRingFlash]=useState(false);
  const prevAprs=useRef({});
  const[flashRows,setFlashRows]=useState({});
  const prevPricesRef=useRef({});
  const[priceDir,setPriceDir]=useState({});
  const priceHistoryRef=useRef(new Map());
  const[rowTabs,setRowTabs]=useState({});
  const[copiedId,setCopiedId]=useState(null);
  const[mktA,setMktA]=useState("polymarket");
  const[mktB,setMktB]=useState("opinion");
  const[matrixView,setMatrixView]=useState(false);
  const[matrixNew,setMatrixNew]=useState(false);
  // Load and manage matrix "NEW" badge from persistent storage
  useEffect(()=>{
    (async()=>{
      try{
        const r=await window.storage.get('pl_matrix_seen');
        if(!r||r.value!=='true')setMatrixNew(true);
      }catch(e){setMatrixNew(true);}
    })();
  },[]);
  const prevMktA=useRef(mktA);
  const prevMktB=useRef(mktB);
  useEffect(()=>{if(prevMktA.current!==mktA||prevMktB.current!==mktB){setPlatformFlash(Date.now());setTimeout(()=>setPlatformFlash(null),600);}prevMktA.current=mktA;prevMktB.current=mktB;},[mktA,mktB]);
  const[showDropA,setShowDropA]=useState(false);
  const[showDropB,setShowDropB]=useState(false);
  const[platformPulse,setPlatformPulse]=useState(true);
  const[platformFlash,setPlatformFlash]=useState(null);
  useEffect(()=>{const t=setTimeout(()=>setPlatformPulse(false),1200);return()=>clearTimeout(t);},[]);
  const tableRef=useRef(null);
  const rowRefs=useRef(new Map());
  const lastBestRef=useRef(null);
  const bestCardRef=useRef(null);
  const[bestCardVisible,setBestCardVisible]=useState(true);
  useEffect(()=>{if(!bestCardRef.current)return;const obs=new IntersectionObserver(([e])=>{setBestCardVisible(e.isIntersecting);},{threshold:0.1});obs.observe(bestCardRef.current);return()=>obs.disconnect();},[]);
  // Escape key to close expanded row
  const[showShortcuts,setShowShortcuts]=useState(false);
  const closeAlerts=useCallback(()=>{setShowAlerts(false);},[]);
  useEffect(()=>{
    const handler=(e)=>{
      if(e.key==="Escape"){
        if(showShortcuts){setShowShortcuts(false);return;}
        if(showAlerts){closeAlerts();return;}
        if(expanded!==null){setExpanded(null);setSel(null);}
      }
      if(e.key==="?"&&!e.ctrlKey&&!e.metaKey&&document.activeElement?.tagName!=="INPUT"&&document.activeElement?.tagName!=="TEXTAREA"){setShowShortcuts(s=>!s);return;}
      if(e.key==="/"&&document.activeElement?.tagName!=="INPUT"&&document.activeElement?.tagName!=="TEXTAREA"){e.preventDefault();document.querySelector('.pl-search-input')?.focus();return;}
      if(e.key==="f"&&!e.ctrlKey&&!e.metaKey&&document.activeElement?.tagName!=="INPUT"&&document.activeElement?.tagName!=="TEXTAREA"){setShowF(p=>!p);return;}
      if(e.key==="a"&&!e.ctrlKey&&!e.metaKey&&document.activeElement?.tagName!=="INPUT"&&document.activeElement?.tagName!=="TEXTAREA"){if(showAlerts){closeAlerts();}else{setShowAlerts(true);}return;}
      if(e.key==="e"&&!e.ctrlKey&&!e.metaKey&&document.activeElement?.tagName!=="INPUT"&&document.activeElement?.tagName!=="TEXTAREA"){toggleEffects();return;}
    };
    document.addEventListener("keydown",handler);
    return()=>document.removeEventListener("keydown",handler);
  },[expanded,showShortcuts,showAlerts,closeAlerts]);
  const resetAll=()=>{setFilters({expiryDays:500,minVolume:0,minLiquidity:1000,minApr:0});setSearch("");setCatFilter("All");};
  const resetF=resetAll;
  const CATS=useMemo(()=>["All","Saved",...Array.from(new Set(MOCK.map(m=>m.category))).sort()],[]);
  // Category counts (from filtered-except-category data)
  const catCounts=useMemo(()=>{
    const base=prices.filter(o=>{
      if(search&&!(o.event+' '+o.polyName+' '+o.opinName).toLowerCase().includes(search.toLowerCase()))return false;
      const daysLeft=(new Date()-new Date(o.expiry))<0?(new Date(o.expiry)-new Date())/86400000:0;
      if(daysLeft>filters.expiryDays&&(new Date(o.expiry)-new Date())/86400000>filters.expiryDays)return false;
      if(o.volume<filters.minVolume)return false;
      if(o.bookDepth<filters.minLiquidity)return false;
      return true;
    });
    const counts={All:base.length,Saved:base.filter(o=>savedMarkets.has(o.id)).length};
    base.forEach(o=>{counts[o.category]=(counts[o.category]||0)+1;});
    return counts;
  },[prices,search,filters,savedMarkets]);
  const showToast=(msg,url)=>{setToast({msg,url});setTimeout(()=>setToast(null),2500);};

  // Compute estimated profit for table column
  const estProfit=(o)=>{
    const a=getPriceA(o),b=getPriceB(o);
    const costBasis=a.yes*(1+pAFee)+(1-b.yes)*(1+pBFee);
    const roi=Math.max(0,((1-costBasis)/costBasis)*100);
    return roi;
  };

  // Compute detailed trade info for dropdown
  const tradeDetail=(o,w)=>{
    const aFee=pAFee;
    const bFee=pBFee;
    const aP=getPriceA(o),bP=getPriceB(o);
    const polyPrice=aP.yes;
    const shares=Math.floor(w/(polyPrice+(1-bP.yes)));
    const polyCost=shares*polyPrice;
    const polyFeeAmt=polyCost*aFee;
    const polyTotal=polyCost+polyFeeAmt;
    const opinPrice=1-bP.yes;
    const opinCost=shares*opinPrice;
    const opinFeeAmt=opinCost*bFee;
    const opinTotal=opinCost+opinFeeAmt;
    // Combined
    const costBasis=polyTotal+opinTotal;
    const toReturn=shares;
    const netPnl=toReturn-costBasis;
    const roi=costBasis>0?(netPnl/costBasis)*100:0;
    const maxProfit=Math.floor(o.bookDepth*0.8/(polyPrice+(1-bP.yes)));
    const daysToExpiry=Math.max(1,(new Date(o.expiry)-new Date())/86400000);
    const annualizedAPR=costBasis>0?(netPnl/costBasis)*(365/daysToExpiry)*100:0;
    return{polyPrice,opinPrice,shares,polyCost,polyFeeAmt,polyTotal,opinCost,opinFeeAmt,opinTotal,costBasis,toReturn,netPnl,roi,maxProfit:maxProfit*(polyPrice+(1-bP.yes)),annualizedAPR,daysToExpiry};
  };

  useEffect(()=>{
    const civ=setInterval(()=>{countdownRef.current=Math.max(0,countdownRef.current-1);setCountdown(countdownRef.current);},1000);
    return()=>clearInterval(civ);
  },[]);

  useEffect(()=>{
    const iv=setInterval(()=>{
      setLastUpdate(new Date());
      countdownRef.current=30;setCountdown(30);setRingFlash(true);setTimeout(()=>setRingFlash(false),400);
      setPrices(prev=>{
      const next=prev.map(p=>{
          const newAll={};PLATFORM_KEYS.forEach(k=>{const base=p.allPrices?.[k]||p.prices?.[k]||{yes:0.5,no:0.5};newAll[k]={yes:Math.max(0.01,Math.min(0.99,base.yes+(Math.random()-0.5)*0.02)),no:Math.max(0.01,Math.min(0.99,base.no+(Math.random()-0.5)*0.02))};});
          const newPoly=newAll.polymarket;const newOpin=newAll.opinion;
          const newSpread=Math.max(0.005,Math.abs(newOpin.yes-newPoly.yes));
          const costBasis=newPoly.yes*1.0217+(1-newOpin.yes);
          const netPnl=1-costBasis;
          const daysToExp=Math.max(1,(new Date(p.expiry)-new Date())/86400000);
          const computedAPR=costBasis>0?(netPnl/costBasis)*(365/daysToExp)*100:0;
          return{...p,allPrices:newAll,polymarket:newPoly,opinion:newOpin,spread:newSpread,apr:computedAPR};
        });
        const flashes={};
        const dirs={};
        next.forEach(p=>{
          const old=prevAprs.current[p.id];
          if(old!==undefined){
            const diff=p.apr-old;
            if(diff>1)flashes[p.id]="green";
            else if(diff<-1)flashes[p.id]="red";
          }
          prevAprs.current[p.id]=p.apr;
          // Track price directions
          const prevP=prevPricesRef.current[p.id];
          if(prevP){
            const polyDir=p.polymarket.yes>prevP.poly?"up":p.polymarket.yes<prevP.poly?"down":null;
            const opinDir=p.opinion.yes>prevP.opin?"up":p.opinion.yes<prevP.opin?"down":null;
            dirs[p.id]={poly:polyDir,opin:opinDir};
          }
          prevPricesRef.current[p.id]={poly:p.polymarket.yes,opin:p.opinion.yes};
          // Track price history for sparklines
          const hist=priceHistoryRef.current.get(p.id)||[];
          hist.push(p.polymarket.yes);
          if(hist.length>15)hist.shift();
          priceHistoryRef.current.set(p.id,hist);
          const oHist=priceHistoryRef.current.get("o"+p.id)||[];
          oHist.push(p.opinion.yes);
          if(oHist.length>15)oHist.shift();
          priceHistoryRef.current.set("o"+p.id,oHist);
        });
        if(Object.keys(flashes).length>0){
          setFlashRows(flashes);
          setTimeout(()=>setFlashRows({}),600);
        }
        setPriceDir(dirs);
        return next;
      });
    },30000);
    // Initialize prevAprs and prevPricesRef
    prices.forEach(p=>{prevAprs.current[p.id]=p.apr;prevPricesRef.current[p.id]={poly:p.polymarket.yes,opin:p.opinion.yes};priceHistoryRef.current.set(p.id,[p.polymarket.yes]);priceHistoryRef.current.set("o"+p.id,[p.opinion.yes]);});
    return()=>clearInterval(iv);
  },[]);

  const now=new Date();
  // Dynamic platform pair helpers (moved before filtering)
  const pA=PLATFORMS[mktA],pB=PLATFORMS[mktB];
  const pAColor=pA.color,pBColor=pB.color,pAIcon=pA.icon,pBIcon=pB.icon,pAName=pA.name,pBName=pB.name,pAShort=pA.short,pBShort=pB.short;
  const pAFee=pA.fee,pBFee=pB.fee;
  const getPriceA=(o)=>o.allPrices?.[mktA]||o.prices?.[mktA]||o.polymarket||{yes:0.5,no:0.5};
  const getPriceB=(o)=>o.allPrices?.[mktB]||o.prices?.[mktB]||o.opinion||{yes:0.5,no:0.5};
  const getNameA=(o)=>o.names?.[mktA]||o.polyName||o.event;
  const getNameB=(o)=>o.names?.[mktB]||o.opinName||o.event;
  const dynSpread=(o)=>Math.max(0,Math.abs(getPriceA(o).yes-getPriceB(o).yes));
  const dynAPR=(o)=>{const a=getPriceA(o),b=getPriceB(o);const cb=a.yes*(1+pAFee)+(1-b.yes)*(1+pBFee);const np=1-cb;const dte=Math.max(1,(new Date(o.expiry)-new Date())/86400000);return cb>0?(np/cb)*(365/dte)*100:0;};
  const signalScore=(o)=>{const aprVal=dynAPR(o);const aprNorm=Math.min(100,Math.max(0,aprVal));const liq=Math.min(100,Math.max(0,o.liquidity));const sprd=Math.min(100,Math.max(0,dynSpread(o)*1000));const dte=Math.max(0,(new Date(o.expiry)-new Date())/86400000);const expiryBonus=Math.min(100,Math.max(0,100-(dte/10)));return Math.round((sprd*0.40)+(liq*0.30)+(aprNorm*0.20)+(expiryBonus*0.10));};
  const preFiltered=prices.filter(o=>{
    if(search&&!(o.event+' '+o.polyName+' '+o.opinName).toLowerCase().includes(search.toLowerCase()))return false;
    const daysLeft=(new Date(o.expiry)-now)/86400000;
    if(daysLeft>filters.expiryDays)return false;
    if(o.volume<filters.minVolume)return false;
    if(o.bookDepth<filters.minLiquidity)return false;
    if(catFilter==="Saved"&&!savedMarkets.has(o.id))return false;
    if(catFilter!=="All"&&catFilter!=="Saved"&&o.category!==catFilter)return false;
    return true;
  });
  const hiddenUnprofitable=profitableOnly?preFiltered.filter(o=>o.apr<=0).length:0;
  // Context-sensitive empty state counts
  const hiddenByThreshold=prices.filter(o=>{
    const dl=(new Date(o.expiry)-now)/86400000;
    return dl>filters.expiryDays||o.volume<filters.minVolume||o.bookDepth<filters.minLiquidity;
  }).length;
  const hiddenByCategory=prices.filter(o=>{
    if(search&&!(o.event+' '+o.polyName+' '+o.opinName).toLowerCase().includes(search.toLowerCase()))return true;
    if(catFilter==="Saved"&&!savedMarkets.has(o.id))return true;
    if(catFilter!=="All"&&catFilter!=="Saved"&&o.category!==catFilter)return true;
    return false;
  }).length;
  const profitableInOtherCats=prices.filter(o=>o.apr>0&&o.category!==catFilter).length;
  const filtered=preFiltered.filter(o=>{
    if(profitableOnly&&o.apr<=0)return false;
    if(filters.minApr>0&&dynAPR(o)<filters.minApr)return false;
    return true;
  }).sort((a,b)=>{
    if(sortBy==="expiry"){
      const da=new Date(a.expiry).getTime(),db=new Date(b.expiry).getTime();
      return sortDir==="desc"?db-da:da-db;
    }
    if(sortBy==="signal"){
      const sa=signalScore(a),sb=signalScore(b);
      return sortDir==="desc"?sb-sa:sa-sb;
    }
    return sortDir==="desc"?b[sortBy]-a[sortBy]:a[sortBy]-b[sortBy];
  });

  const best=filtered.length>0?filtered[0]:null;
  // Auto-expand top row on initial load
  const resolvedExpanded = expanded;
  const togSort=c=>{if(sortBy===c)setSortDir(d=>d==="desc"?"asc":"desc");else{setSortBy(c);setSortDir("desc");}};
  const SI=({col})=>{const isActive=sortBy===col;return <span style={{color:isActive?T.text:T.textTertiary,opacity:isActive?1:0.45,marginLeft:4,fontSize:9,fontFamily:T.mono,transition:"all .2s"}}>{isActive?(sortDir==="asc"?"\u25b2":"\u25bc"):"\u25b2\u25bc"}</span>;};
  const th=S.th;
  const sth=(col,extra={})=>({...th,...extra,color:sortBy===col?T.textSecondary:T.textTertiary,cursor:"pointer",position:"relative",borderBottom:sortBy===col?`2px solid ${T.auroraText}`:"none"});

  // ── Hoisted from IIFEs — avoids return inside IIFE in JSX (Babel bug) ──
  // Best signal card vars
  const _bestVisible=!!(best&&best.apr>0);
  if(_bestVisible)lastBestRef.current=best;
  const _displayBest=best||lastBestRef.current;
  const _isFrozen=!_bestVisible&&!!_displayBest;
  const _showSignal=!!_displayBest;
  // Filter summary vars
  const _filtersActive=filters.minVolume>0||filters.minLiquidity>1000||filters.expiryDays<500;
  const _filterActiveCount=(filters.minVolume>0?1:0)+(filters.minLiquidity>1000?1:0)+(filters.expiryDays<500?1:0)+(filters.minApr>0?1:0);
  const _filterHiddenCount=prices.length-preFiltered.length+(profitableOnly?hiddenUnprofitable:0);
  // Active filter tags vars
  const _filterTags=[];
  if(filters.expiryDays<500)_filterTags.push({label:`Expiry < ${filters.expiryDays} days`,clear:()=>setFilters(p=>({...p,expiryDays:500}))});
  if(filters.minVolume>0)_filterTags.push({label:`Volume > $${filters.minVolume>=1e6?(filters.minVolume/1e6).toFixed(1)+"M":(filters.minVolume/1e3).toFixed(0)+"K"}`,clear:()=>setFilters(p=>({...p,minVolume:0}))});
  if(filters.minLiquidity>1000)_filterTags.push({label:`Liquidity > $${filters.minLiquidity>=1e6?(filters.minLiquidity/1e6).toFixed(1)+"M":filters.minLiquidity>=1e3?(filters.minLiquidity/1e3).toFixed(0)+"K":filters.minLiquidity}`,clear:()=>setFilters(p=>({...p,minLiquidity:1000}))});
  if(filters.minApr>0)_filterTags.push({label:`APR > ${filters.minApr}%`,clear:()=>setFilters(p=>({...p,minApr:0}))});
  if(catFilter!=="All")_filterTags.push({label:catFilter,clear:()=>setCatFilter("All")});
  const _hasTags=_filterTags.length>0;
  // Saved summary bar vars
  const _hasSaved=savedMarkets.size>0;
  const _savedArr=_hasSaved?prices.filter(o=>savedMarkets.has(o.id)):[];
  const _totalCapital=wager*savedMarkets.size;
  const _totalPnl=_savedArr.reduce((sum,o)=>{const _td2=tradeDetail(o,wager);return sum+_td2.netPnl;},0);
  const _weightedAPR=_savedArr.length>0?_savedArr.reduce((sum,o)=>sum+dynAPR(o),0)/_savedArr.length:0;

  return(
    <div style={{background:"transparent",minHeight:"100vh",position:"relative",zIndex:10}}>
      <nav style={{background:"rgba(255,255,255,0.028)",backdropFilter:"blur(120px) saturate(1.4)",WebkitBackdropFilter:"blur(120px) saturate(1.4)",borderBottom:"none",boxShadow:"0 8px 40px rgba(0,0,0,0.50), inset 0 -1px 0 rgba(255,255,255,0.07), 0 0 0 0.5px rgba(255,255,255,0.05)",position:"sticky",top:0,zIndex:50}}>
        <div style={{maxWidth:1400,margin:"0 auto",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <div style={{cursor:"pointer"}} onClick={()=>nav("landing")}><Logo/></div>
            <div style={{width:1,height:18,background:T.border}}/>
            <span style={{fontSize:10,fontWeight:600,color:T.textTertiary,fontFamily:T.mono,letterSpacing:2}}>SCANNER</span>
          </div>
          <div className="pl-nav-right" style={{display:"flex",alignItems:"center",gap:16}}>
            <LiveDot secondsAgo={30-countdown} reconnecting={countdown<=0}/>
            <button aria-label={effectsDisabled?"Enable background effects":"Disable background effects"} onClick={toggleEffects} title={effectsDisabled?"Enable effects":"Disable effects"} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:28,height:28,borderRadius:8,border:"none",cursor:"pointer",background:effectsDisabled?"rgba(255,255,255,0.02)":"rgba(255,255,255,0.04)",color:effectsDisabled?T.textTertiary:T.text,transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08)",fontSize:13,padding:0}}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";}}
              onMouseOut={e=>{e.currentTarget.style.background=effectsDisabled?"rgba(255,255,255,0.02)":"rgba(255,255,255,0.04)";}}
            >{effectsDisabled?"✦":"✧"}</button>
            <button aria-label={matrixView?"Switch to pair view":"Switch to matrix view"} className="pl-matrix-btn" onClick={()=>{setMatrixView(v=>!v);if(matrixNew){setMatrixNew(false);window.storage.set('pl_matrix_seen','true').catch(()=>{});}}} title="" style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:4,height:28,borderRadius:8,border:"none",cursor:"pointer",padding:"0 10px",position:"relative",
              background:matrixView?"rgba(255,255,255,0.06)":"rgba(255,255,255,0.02)",
              color:matrixView?T.text:T.textTertiary,transition:"all .2s",boxShadow:matrixView?"inset 0 1px 0 rgba(255,255,255,0.14), 0 2px 8px rgba(0,0,0,0.2)":"inset 0 1px 0 rgba(255,255,255,0.08)",fontSize:9,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono}}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.color=T.text;const tip=e.currentTarget.querySelector('.matrix-tooltip');if(tip){tip.style.opacity='1';tip.style.transform='translateX(-50%) translateY(0)';}}}
              onMouseOut={e=>{e.currentTarget.style.background=matrixView?"rgba(255,255,255,0.06)":"rgba(255,255,255,0.02)";e.currentTarget.style.color=matrixView?T.text:T.textTertiary;const tip=e.currentTarget.querySelector('.matrix-tooltip');if(tip){tip.style.opacity='0';tip.style.transform='translateX(-50%) translateY(-4px)';}}}
            ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>{matrixView?"MATRIX":"PAIR"}{matrixNew&&!matrixView&&<span style={{position:"absolute",top:-3,right:-3,width:7,height:7,borderRadius:"50%",background:T.positive,animation:"hotPulse 2s ease-in-out infinite",boxShadow:"0 0 6px rgba(52,199,89,0.8)"}}/>}
            <div className="matrix-tooltip" style={{position:"absolute",top:"calc(100% + 8px)",left:"50%",transform:"translateX(-50%) translateY(-4px)",opacity:0,transition:"opacity 0.2s ease, transform 0.2s ease",background:"rgba(20,20,20,0.97)",backdropFilter:"blur(100px) saturate(1.30)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:10,padding:"10px 14px",width:240,zIndex:99999,boxShadow:"0 12px 40px rgba(0,0,0,0.7)",pointerEvents:"none",whiteSpace:"normal",textAlign:"left",letterSpacing:"normal",textTransform:"none",fontWeight:400}}>
              <div style={{position:"absolute",top:-4,left:"50%",transform:"translateX(-50%) rotate(45deg)",width:8,height:8,background:"rgba(20,20,20,0.97)",borderLeft:"1px solid rgba(255,255,255,0.12)",borderTop:"1px solid rgba(255,255,255,0.12)"}}/>
              <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:5}}>MATRIX VIEW</div>
              <div style={{fontSize:11,fontFamily:T.body,color:T.textSecondary,lineHeight:1.5}}>See all 4 platforms side-by-side instead of the selected pair. Highlights the highest price on each row.</div>
            </div>
            </button>
            {(!bestCardVisible&&best)?<div onClick={()=>{bestCardRef.current?.scrollIntoView({behavior:'smooth',block:'start'});}} style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",padding:"4px 12px",borderRadius:100,background:"rgba(255,255,255,0.032)",backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)",border:"none",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.16), 0 2px 8px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(255,255,255,0.06)",animation:"revealFade 0.3s ease-out",transition:"all .2s"}}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.055)";}}
              onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.032)";}}>
              <span style={{fontSize:10,fontFamily:T.mono,color:T.textSecondary,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{best.event.length>20?best.event.slice(0,20)+"…":best.event}</span>
              <span style={{fontSize:11,fontWeight:700,fontFamily:T.mono,...(dynAPR(best)>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:{color:T.positive})}}>{dynAPR(best).toFixed(1)}%</span>
              <span style={{fontSize:10,color:T.textTertiary}}>↓</span>
            </div>:<div style={{display:"flex",alignItems:"center",gap:6,color:T.textTertiary,fontSize:11,fontFamily:T.mono,padding:"4px 12px",borderRadius:100,background:"rgba(255,255,255,0.032)",backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)",border:"none",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.16), 0 2px 8px rgba(0,0,0,0.30), 0 0 0 0.5px rgba(255,255,255,0.06)"}}><ICl/>{lastUpdate.toLocaleTimeString()}</div>}
            {/* Countdown timer ring */}
            <div aria-live="polite" aria-label={`Next refresh in ${countdown} seconds`} style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{position:"relative",width:24,height:24}}>
                <svg width="24" height="24" viewBox="0 0 24 24" style={{transform:"rotate(-90deg)"}}>
                  <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2"/>
                  <circle cx="12" cy="12" r="10" fill="none" stroke={ringFlash?"#ffffff":countdown<=5?"#E05555":"#34C759"} strokeWidth="2" strokeLinecap="round" strokeDasharray={2*Math.PI*10} strokeDashoffset={2*Math.PI*10*(1-countdown/30)} style={{transition:ringFlash?"stroke 0.1s ease":"stroke-dashoffset 1s linear, stroke 0.3s ease"}}/>
                </svg>
              </div>
              <button
                title={dataMode==="live"?"Switch to Mock mode":"Switch to Live mode"}
                onClick={()=>{
                  if(dataMode==="live"){setDataMode("mock");setPrices(MOCK.map(p=>{const allP={};PLATFORM_KEYS.forEach(k=>{allP[k]=p.prices?.[k]||{yes:0.5,no:0.5};});const pm=allP.polymarket,op=allP.opinion;const cb=pm.yes*1.0217+(1-op.yes),np=1-cb;const dte=Math.max(1,(new Date(p.expiry)-new Date())/86400000);return{...p,allPrices:allP,polymarket:pm,opinion:op,polyName:p.names?.polymarket||p.polyName,opinName:p.names?.opinion||p.opinName,apr:cb>0?(np/cb)*(365/dte)*100:0};}));}
                  else setDataMode("live");
                }}
                style={{fontSize:10,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:dataMode==="live"?"#00C9A7":T.textTertiary,background:dataMode==="live"?"rgba(0,201,167,0.12)":"rgba(255,255,255,0.02)",border:"none",cursor:"pointer",padding:"3px 8px",borderRadius:6,transition:"all .2s",boxShadow:dataMode==="live"?"inset 0 1px 0 rgba(0,201,167,0.25), 0 0 8px rgba(0,201,167,0.15)":"inset 0 1px 0 rgba(255,255,255,0.08)"}}
                onMouseOver={e=>{e.currentTarget.style.background=dataMode==="live"?"rgba(0,201,167,0.18)":"rgba(255,255,255,0.06)";}}
                onMouseOut={e=>{e.currentTarget.style.background=dataMode==="live"?"rgba(0,201,167,0.12)":"rgba(255,255,255,0.02)";}}
              >
                {loading?<span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:T.textTertiary,display:"inline-block"}}/>:<span style={{width:5,height:5,borderRadius:"50%",background:dataMode==="live"?"#00C9A7":"#666",display:"inline-block",marginRight:5,boxShadow:dataMode==="live"?"0 0 6px #00C9A7":undefined}}/>}
                {loading?"LOADING...":dataMode==="live"?"LIVE":"MOCK"}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* ─── STICKY BEST OPPORTUNITY BAR ─── renders fixed below nav when top row scrolls off */}
      {best&&<div style={{
        position:"fixed",top:56,left:0,right:0,zIndex:45,
        opacity:bestCardVisible?0:1,
        transform:bestCardVisible?"translateY(-8px)":"translateY(0)",
        transition:"opacity 0.25s ease, transform 0.25s ease",
        pointerEvents:bestCardVisible?"none":"auto",
      }}>
        <div onClick={()=>{bestCardRef.current?.scrollIntoView({behavior:'smooth',block:'start'});}}
          style={{maxWidth:1400,margin:"0 auto",padding:"0 24px"}}>
          <div style={{
            display:"flex",alignItems:"center",gap:12,
            padding:"8px 20px",borderRadius:"0 0 16px 16px",cursor:"pointer",
            background:"rgba(12,12,12,0.92)",
            backdropFilter:"blur(120px) saturate(1.4)",WebkitBackdropFilter:"blur(120px) saturate(1.4)",
            boxShadow:"0 8px 32px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,255,255,0.07), 0 0 0 0.5px rgba(255,255,255,0.08)",
            transition:"all .2s",
          }}
          onMouseOver={e=>{e.currentTarget.style.background="rgba(18,18,18,0.96)";e.currentTarget.style.boxShadow="0 10px 40px rgba(0,0,0,0.6), inset 0 -1px 0 rgba(255,255,255,0.10), 0 0 0 0.5px rgba(255,255,255,0.12)";}}
          onMouseOut={e=>{e.currentTarget.style.background="rgba(12,12,12,0.92)";e.currentTarget.style.boxShadow="0 8px 32px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,255,255,0.07), 0 0 0 0.5px rgba(255,255,255,0.08)";}}>
            <span style={{fontSize:8,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,flexShrink:0}}>TOP SIGNAL</span>
            <div style={{width:1,height:12,background:"rgba(255,255,255,0.1)"}}/>
            <span style={{fontSize:11,fontFamily:T.mono,color:T.text,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{best.event}</span>
            <span style={{fontSize:13,fontWeight:700,fontFamily:T.mono,flexShrink:0,...(dynAPR(best)>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:{color:T.positive})}}>{dynAPR(best).toFixed(1)}% APR</span>
            <span style={{fontSize:9,fontFamily:T.mono,color:T.textTertiary,flexShrink:0,display:"flex",alignItems:"center",gap:4}}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15"/></svg>Scroll to top
            </span>
          </div>
        </div>
      </div>}

      <div className="pl-dash-content" style={{maxWidth:1400,margin:"0 auto",padding:"28px 24px",position:"relative",zIndex:10}}>
        {!introDismissed&&<div style={{marginBottom:16,padding:"14px 20px",borderRadius:16,background:"rgba(255,255,255,0.035)",backdropFilter:"blur(120px) saturate(1.4)",WebkitBackdropFilter:"blur(120px) saturate(1.4)",boxShadow:T.glassShadow,display:"flex",alignItems:"center",gap:12,animation:"revealFade 0.3s ease-out"}}>
          <span style={{fontSize:16,color:T.warning,flexShrink:0}}>⚡</span>
          <span style={{fontSize:12,fontFamily:T.body,color:T.textSecondary,lineHeight:1.6,flex:1}}>ProphetLabs finds price discrepancies between prediction markets. Buy YES on the cheaper platform and NO on the more expensive one — locking in a risk-free spread regardless of outcome.</span>
          <button onClick={dismissIntro} style={{flexShrink:0,width:28,height:28,borderRadius:8,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.04)",color:T.textTertiary,fontSize:14,fontWeight:300,display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08)"}}
            onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.08)";e.currentTarget.style.color=T.text;}}
            onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.color=T.textTertiary;}}>✕</button>
        </div>}
        {/* Market Pair Selector — Card Layout */}
        <div className="pl-pair-selector" style={{marginBottom:20,padding:"18px 24px",borderRadius:18,background:"rgba(255,255,255,0.035)",backdropFilter:"blur(120px) saturate(1.4)",WebkitBackdropFilter:"blur(120px) saturate(1.4)",boxShadow:T.glassShadow,position:"relative",zIndex:30,overflow:"visible"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",marginBottom:10}}>
            <span style={{...S.monoLabel,fontSize:9,letterSpacing:3,marginBottom:0,color:T.textTertiary}}>COMPARING</span>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:0,flexWrap:"wrap"}}>
            {/* Platform A Card */}
            <div style={{position:"relative",flex:"1 1 0",maxWidth:260,...(platformPulse?{animation:"pulseOnce 1s ease-out"}:{})}}>
                <div onClick={()=>setShowDropA(p=>!p)} style={{padding:"14px 18px",borderRadius:14,cursor:"pointer",background:"rgba(255,255,255,0.042)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 16px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.07)",transition:"all .2s",display:"flex",alignItems:"center",gap:12,borderLeft:`3px solid ${pAColor}`,backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)"}}
                  onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.065)";e.currentTarget.style.boxShadow=`inset 0 1px 0 rgba(255,255,255,0.20), 0 6px 20px rgba(0,0,0,0.40), 0 0 16px ${pAColor}20, 0 0 0 0.5px rgba(255,255,255,0.10)`;}}
                  onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.042)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 16px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.07)";}}>
                  <span style={{fontSize:22,color:pAColor,lineHeight:1}}>{pAIcon}</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:T.display,letterSpacing:"-0.3px"}}>{pAName}</div>
                    <div style={{fontSize:9,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:pAColor,opacity:0.8}}>BUY SIDE</div>
                    <div style={{fontSize:8,fontWeight:500,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.5,marginTop:2}}>Trust: {pA.trust}</div>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="2" style={{marginLeft:"auto",transform:showDropA?"rotate(180deg)":"rotate(0)",transition:"transform .2s"}}><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                {showDropA&&<div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,zIndex:200,background:"rgba(12,12,12,0.88)",backdropFilter:"blur(120px) saturate(1.4)",WebkitBackdropFilter:"blur(120px) saturate(1.4)",borderRadius:12,border:"1px solid rgba(255,255,255,0.12)",boxShadow:"0 12px 48px rgba(0,0,0,0.7), 0 0 0 0.5px rgba(255,255,255,0.07)",overflow:"hidden",animation:"revealFade 0.15s ease-out"}}>
                  {PLATFORM_KEYS.filter(k=>k!==mktB).map(k=>(
                    <div key={k} onClick={()=>{setMktA(k);setShowDropA(false);}} style={{padding:"10px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,background:k===mktA?"rgba(255,255,255,0.04)":"transparent",transition:"all .15s"}}
                      onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";}} onMouseOut={e=>{e.currentTarget.style.background=k===mktA?"rgba(255,255,255,0.04)":"transparent";}}>
                      <span style={{fontSize:14,color:PLATFORMS[k].color}}>{PLATFORMS[k].icon}</span>
                      <div>
                        <span style={{fontSize:11,fontWeight:600,color:k===mktA?T.text:T.textSecondary,fontFamily:T.mono,display:"block"}}>{PLATFORMS[k].name}</span>
                        <span style={{fontSize:8,fontWeight:500,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.5}}>Trust: {PLATFORMS[k].trust}</span>
                      </div>
                      {k===mktA&&<span style={{marginLeft:"auto",fontSize:10,color:T.positive}}>✓</span>}
                    </div>
                  ))}
                </div>}
              </div>

            {/* VS divider + swap button */}
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,padding:"0 12px",flexShrink:0}}>
              <button onClick={()=>{const tmpA=mktA;setMktA(mktB);setMktB(tmpA);}} title="Swap platforms" style={{width:36,height:36,borderRadius:10,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.03)",color:T.textSecondary,fontSize:14,fontWeight:400,fontFamily:T.mono,display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.2)"}}
                onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.color=T.text;e.currentTarget.style.transform="rotate(180deg)";}}
                onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.03)";e.currentTarget.style.color=T.textSecondary;e.currentTarget.style.transform="rotate(0deg)";}}>⇄</button>
              <span style={{fontSize:8,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>VS</span>
            </div>

            {/* Platform B Card */}
            <div style={{position:"relative",flex:"1 1 0",maxWidth:260,...(platformPulse?{animation:"pulseOnce 1s ease-out 0.15s"}:{})}}>
                <div onClick={()=>setShowDropB(p=>!p)} style={{padding:"14px 18px",borderRadius:14,cursor:"pointer",background:"rgba(255,255,255,0.042)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 16px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.07)",transition:"all .2s",display:"flex",alignItems:"center",gap:12,borderLeft:`3px solid ${pBColor}`,backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)"}}
                  onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.065)";e.currentTarget.style.boxShadow=`inset 0 1px 0 rgba(255,255,255,0.20), 0 6px 20px rgba(0,0,0,0.40), 0 0 16px ${pBColor}20, 0 0 0 0.5px rgba(255,255,255,0.10)`;}}
                  onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.042)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.16), 0 4px 16px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.07)";}}>
                  <span style={{fontSize:22,color:pBColor,lineHeight:1}}>{pBIcon}</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:T.display,letterSpacing:"-0.3px"}}>{pBName}</div>
                    <div style={{fontSize:9,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:pBColor,opacity:0.8}}>SELL SIDE</div>
                    <div style={{fontSize:8,fontWeight:500,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.5,marginTop:2}}>Trust: {pB.trust}</div>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="2" style={{marginLeft:"auto",transform:showDropB?"rotate(180deg)":"rotate(0)",transition:"transform .2s"}}><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                {showDropB&&<div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,zIndex:200,background:"rgba(12,12,12,0.88)",backdropFilter:"blur(120px) saturate(1.4)",WebkitBackdropFilter:"blur(120px) saturate(1.4)",borderRadius:12,border:"1px solid rgba(255,255,255,0.12)",boxShadow:"0 12px 48px rgba(0,0,0,0.7), 0 0 0 0.5px rgba(255,255,255,0.07)",overflow:"hidden",animation:"revealFade 0.15s ease-out"}}>
                  {PLATFORM_KEYS.filter(k=>k!==mktA).map(k=>(
                    <div key={k} onClick={()=>{setMktB(k);setShowDropB(false);}} style={{padding:"10px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,background:k===mktB?"rgba(255,255,255,0.04)":"transparent",transition:"all .15s"}}
                      onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";}} onMouseOut={e=>{e.currentTarget.style.background=k===mktB?"rgba(255,255,255,0.04)":"transparent";}}>
                      <span style={{fontSize:14,color:PLATFORMS[k].color}}>{PLATFORMS[k].icon}</span>
                      <div>
                        <span style={{fontSize:11,fontWeight:600,color:k===mktB?T.text:T.textSecondary,fontFamily:T.mono,display:"block"}}>{PLATFORMS[k].name}</span>
                        <span style={{fontSize:8,fontWeight:500,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.5}}>Trust: {PLATFORMS[k].trust}</span>
                      </div>
                      {k===mktB&&<span style={{marginLeft:"auto",fontSize:10,color:T.positive}}>✓</span>}
                    </div>
                  ))}
                </div>}
              </div>
          </div>
          {/* Live summary line */}
          <div style={{textAlign:"center",marginTop:12,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.04)"}}>
            <span style={{fontSize:10,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.5}}>Currently scanning <span style={{color:T.text,fontWeight:600}}>{prices.length}</span> markets across <span style={{color:pAColor,fontWeight:600}}>{pAName}</span> <span style={{opacity:0.5}}>↔</span> <span style={{color:pBColor,fontWeight:600}}>{pBName}</span></span>
          </div>
        </div>
        {/* Best signal card — always visible, dimmed when unavailable */}
        <div ref={bestCardRef} style={{minHeight:_showSignal?0:0,opacity:1,transition:"opacity 0.35s ease, margin-bottom 0.35s ease",marginBottom:_showSignal?0:0,willChange:"opacity",position:"relative"}}>
          {_showSignal&&<div style={{position:"relative",transition:"filter 0.5s ease, opacity 0.5s ease",filter:_isFrozen?"saturate(0.15) brightness(0.6)":"none",opacity:_isFrozen?0.45:1,pointerEvents:_isFrozen?"none":"auto"}}>
          {_isFrozen&&<div style={{position:"absolute",top:12,right:16,zIndex:20,display:"flex",alignItems:"center",gap:6,padding:"5px 14px",borderRadius:10,background:"rgba(255,255,255,0.04)",backdropFilter:"blur(100px) saturate(1.30)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08)",animation:"revealFade 0.4s ease-out"}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:T.textTertiary,opacity:0.5}}/>
            <span style={{fontSize:9,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>NO MATCHING SIGNALS — Adjust filters to reveal more opportunities.</span>
          </div>}
          <Card accent hover={false} style={{padding:"24px 28px",marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:16,background:_isFrozen?"rgba(255,255,255,0.015)":"rgba(255,255,255,0.032)",border:"1px solid rgba(255,255,255,0.06)",boxShadow:(!_isFrozen&&_displayBest.apr>15)?"0 0 0 1px rgba(52,199,89,0.30), 0 0 32px rgba(52,199,89,0.08), 0 8px 40px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.16)":undefined}} className="pl-signal-card">
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:8,background:"rgba(255,255,255,0.022)",backdropFilter:"blur(100px) saturate(1.30)",border:"none",animation:_isFrozen?"none":"hotPulse 2s ease-in-out infinite",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10)",fontSize:9,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:"#ffffff"}}><IF/> TOP</span>
              <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,background:T.aurora,backgroundSize:"300% 300%",animation:_isFrozen?"none":"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>BEST SIGNAL</span>
            </div>
            <div style={{marginBottom:6}}>
              <div style={{fontSize:18,fontWeight:700,color:T.text,marginBottom:6,fontFamily:T.display,letterSpacing:"-0.3px"}}>{_displayBest.event}</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <span aria-label={pAName} style={{fontSize:10,color:pAColor,marginRight:2}}>{pAIcon}</span><span style={{fontSize:9,fontWeight:600,color:pAColor,fontFamily:T.mono,letterSpacing:1}}>{pAShort.toUpperCase()}</span>
                <span style={{fontSize:14,fontWeight:600,color:T.text}}>{getNameA(_displayBest)}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span aria-label={pBName} style={{fontSize:10,color:pBColor,marginRight:2}}>{pBIcon}</span><span style={{fontSize:9,fontWeight:600,color:pBColor,fontFamily:T.mono,letterSpacing:1}}>{pBShort.toUpperCase()}</span>
                <span style={{fontSize:14,fontWeight:600,color:T.text}}>{getNameB(_displayBest)}</span>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:11,fontFamily:T.mono,padding:"4px 10px",borderRadius:10,background:pA.colorSoft,backdropFilter:"blur(100px) saturate(1.30)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.09)",border:"none",color:T.textSecondary}}>{pAIcon} {pAShort}: <span style={{color:pAColor,fontWeight:700}}>{(getPriceA(_displayBest).yes*100).toFixed(1)}{'\u00a2'}</span></span>
              <span style={{fontSize:11,fontFamily:T.mono,padding:"4px 10px",borderRadius:10,background:pB.colorSoft,backdropFilter:"blur(100px) saturate(1.30)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.09)",border:"none",color:T.textSecondary}}>{pBIcon} {pBShort}: <span style={{color:pBColor,fontWeight:700}}>{(getPriceB(_displayBest).yes*100).toFixed(1)}{'\u00a2'}</span></span>
              <span style={{fontSize:11,fontFamily:T.mono,padding:"4px 10px",borderRadius:10,background:"rgba(255,255,255,0.015)",backdropFilter:"blur(100px) saturate(1.30)",border:"none",color:T.textSecondary,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.2)"}}>Spread: <span style={{color:T.text,fontWeight:600}}>{(dynSpread(_displayBest)*100).toFixed(1)}%</span></span>
              <span style={{fontSize:11,fontFamily:T.mono,padding:"4px 10px",borderRadius:10,background:"rgba(255,255,255,0.015)",backdropFilter:"blur(100px) saturate(1.30)",border:"none",color:T.textSecondary,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.2)"}}>Vol: <span style={{color:T.text,fontWeight:500}}>${(_displayBest.volume/1e6).toFixed(1)}M</span></span>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
            <div style={{fontSize:40,fontWeight:300,fontFamily:T.display,letterSpacing:"-2px",...(!_isFrozen&&_displayBest.apr>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 5s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:{color:_isFrozen?T.textTertiary:T.positive})}}>+{_displayBest.apr.toFixed(1)}%</div>
            <div style={{fontSize:9,color:T.textTertiary,fontWeight:600,letterSpacing:2.5,fontFamily:T.mono}}>ANNUALIZED</div>
            <button onClick={()=>{if(_isFrozen)return;setSel(_displayBest);setExpanded(_displayBest.id);setTimeout(()=>{tableRef.current?.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>{rowRefs.current.get(_displayBest.id)?.scrollIntoView({behavior:'smooth',block:'nearest'});},150);},50);}} style={{marginTop:8,padding:"12px 32px",borderRadius:12,border:"none",cursor:_isFrozen?"default":"pointer",fontFamily:T.mono,fontWeight:800,fontSize:12,letterSpacing:2,background:_isFrozen?"rgba(255,255,255,0.05)":"#ffffff",color:_isFrozen?"rgba(255,255,255,0.25)":"#000000",transition:"all .25s",boxShadow:_isFrozen?"none":"0 4px 24px rgba(255,255,255,0.20), 0 0 40px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.9)",opacity:1,display:"flex",alignItems:"center",gap:8}}
              onMouseOver={e=>{if(!_isFrozen){e.currentTarget.style.transform="scale(1.04) translateY(-1px)";e.currentTarget.style.boxShadow="0 8px 32px rgba(255,255,255,0.28), 0 0 56px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.9)";}}}
              onMouseOut={e=>{if(!_isFrozen){e.currentTarget.style.transform="scale(1) translateY(0)";e.currentTarget.style.boxShadow="0 4px 24px rgba(255,255,255,0.20), 0 0 40px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.9)";}}}
            >VIEW TRADE<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg></button>
          </div>
        </Card>
        </div>}
        </div>

        <div style={{maxHeight:!resolvedExpanded?80:0,opacity:!resolvedExpanded?1:0,overflow:"hidden",transition:"max-height 0.35s ease, opacity 0.25s ease, margin-bottom 0.35s ease",marginBottom:!resolvedExpanded?20:0}}>
          <div style={{padding:"16px 20px",borderRadius:14,background:"rgba(255,255,255,0.032)",backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)",border:"none",boxShadow:T.glassShadow,display:"flex",alignItems:"center",gap:10}}>
            <ICh/>
            <span style={{fontSize:12,color:T.textSecondary,fontFamily:T.body}}>Click any market row to analyze trade details</span>
          </div>
        </div>

        <div className="pl-controls-bar" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12,flex:"1 1 auto",flexWrap:"wrap"}}>
          <div style={{position:"relative",display:"inline-flex",alignItems:"center",flex:"0 1 auto"}}>
          <input type="text" className="pl-search-input" placeholder="Search events... (press /)" value={search} onChange={e=>setSearch(e.target.value)} style={{
            background:"rgba(255,255,255,0.032)",backdropFilter:"blur(110px) saturate(1.35)",WebkitBackdropFilter:"blur(110px) saturate(1.35)",border:"none",borderRadius:12,
            padding:"10px 18px",paddingRight:search?34:18,color:T.text,fontSize:12,fontFamily:T.mono,width:260,outline:"none",
            transition:"all .3s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)"
          }}
          onFocus={e=>{e.target.style.borderColor=T.positive;e.target.style.boxShadow="0 0 0 3px rgba(255,255,255,0.06)";}}
          onBlur={e=>{e.target.style.borderColor=T.cardBorder;e.target.style.boxShadow="0 1px 4px rgba(255,255,255,0.04)";}}/>
          {search&&<button onClick={()=>setSearch('')} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:T.textTertiary,fontSize:14,fontWeight:300,padding:0,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",width:18,height:18,borderRadius:4,transition:"all .2s"}} onMouseOver={e=>{e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.04)";}} onMouseOut={e=>{e.currentTarget.style.color=T.textTertiary;e.currentTarget.style.background="none";}}>✕</button>}
          </div>
          {/* Inline platform pair selector — replaces the old "Comparing:" scroll link */}
          <div className="pl-compare-label" style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 8px 4px 10px",borderRadius:12,background:"rgba(255,255,255,0.028)",backdropFilter:"blur(110px) saturate(1.35)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.2)"}}>
            <span style={{fontSize:8,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary,marginRight:2}}>VS</span>
            <button onClick={()=>setShowDropA(p=>!p)} style={{position:"relative",display:"inline-flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:8,border:"none",cursor:"pointer",background:showDropA?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.04)",color:pAColor,fontFamily:T.mono,fontSize:10,fontWeight:700,transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10)"}}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.07)";}}
              onMouseOut={e=>{e.currentTarget.style.background=showDropA?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.04)";}}>
              <span style={{fontSize:11}}>{pAIcon}</span>{pAShort.toUpperCase()}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{opacity:0.5,transform:showDropA?"rotate(180deg)":"none",transition:"transform .2s"}}><polyline points="6 9 12 15 18 9"/></svg>
              {showDropA&&<div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:300,background:"rgba(12,12,12,0.96)",backdropFilter:"blur(120px) saturate(1.4)",borderRadius:10,border:"1px solid rgba(255,255,255,0.12)",boxShadow:"0 12px 40px rgba(0,0,0,0.7)",overflow:"hidden",animation:"revealFade 0.15s ease-out",minWidth:140}}>
                {PLATFORM_KEYS.filter(k=>k!==mktB).map(k=>(
                  <div key={k} onClick={e=>{e.stopPropagation();setMktA(k);setShowDropA(false);}} style={{padding:"8px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,background:k===mktA?"rgba(255,255,255,0.05)":"transparent",transition:"all .15s"}}
                    onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";}} onMouseOut={e=>{e.currentTarget.style.background=k===mktA?"rgba(255,255,255,0.05)":"transparent";}}>
                    <span style={{fontSize:12,color:PLATFORMS[k].color}}>{PLATFORMS[k].icon}</span>
                    <span style={{fontSize:10,fontWeight:600,color:k===mktA?T.text:T.textSecondary,fontFamily:T.mono}}>{PLATFORMS[k].name}</span>
                    {k===mktA&&<span style={{marginLeft:"auto",fontSize:9,color:T.positive}}>✓</span>}
                  </div>
                ))}
              </div>}
            </button>
            <button onClick={()=>{const tmpA=mktA;setMktA(mktB);setMktB(tmpA);}} title="Swap platforms" style={{width:22,height:22,borderRadius:6,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.025)",color:T.textSecondary,fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s"}}
              onMouseOver={e=>{e.currentTarget.style.color=T.text;e.currentTarget.style.transform="rotate(180deg)";}}
              onMouseOut={e=>{e.currentTarget.style.color=T.textSecondary;e.currentTarget.style.transform="rotate(0deg)";}}>⇄</button>
            <button onClick={()=>setShowDropB(p=>!p)} style={{position:"relative",display:"inline-flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:8,border:"none",cursor:"pointer",background:showDropB?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.04)",color:pBColor,fontFamily:T.mono,fontSize:10,fontWeight:700,transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10)"}}
              onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.07)";}}
              onMouseOut={e=>{e.currentTarget.style.background=showDropB?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.04)";}}>
              <span style={{fontSize:11}}>{pBIcon}</span>{pBShort.toUpperCase()}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{opacity:0.5,transform:showDropB?"rotate(180deg)":"none",transition:"transform .2s"}}><polyline points="6 9 12 15 18 9"/></svg>
              {showDropB&&<div style={{position:"absolute",top:"calc(100% + 4px)",right:0,zIndex:300,background:"rgba(12,12,12,0.96)",backdropFilter:"blur(120px) saturate(1.4)",borderRadius:10,border:"1px solid rgba(255,255,255,0.12)",boxShadow:"0 12px 40px rgba(0,0,0,0.7)",overflow:"hidden",animation:"revealFade 0.15s ease-out",minWidth:140}}>
                {PLATFORM_KEYS.filter(k=>k!==mktA).map(k=>(
                  <div key={k} onClick={e=>{e.stopPropagation();setMktB(k);setShowDropB(false);}} style={{padding:"8px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:8,background:k===mktB?"rgba(255,255,255,0.05)":"transparent",transition:"all .15s"}}
                    onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";}} onMouseOut={e=>{e.currentTarget.style.background=k===mktB?"rgba(255,255,255,0.05)":"transparent";}}>
                    <span style={{fontSize:12,color:PLATFORMS[k].color}}>{PLATFORMS[k].icon}</span>
                    <span style={{fontSize:10,fontWeight:600,color:k===mktB?T.text:T.textSecondary,fontFamily:T.mono}}>{PLATFORMS[k].name}</span>
                    {k===mktB&&<span style={{marginLeft:"auto",fontSize:9,color:T.positive}}>✓</span>}
                  </div>
                ))}
              </div>}
            </button>
          </div>
          </div>
          <div style={{display:"flex",gap:8}}>
          <button aria-label="Toggle filters panel" onClick={()=>setShowF(p=>!p)} style={{
            display:"inline-flex",alignItems:"center",gap:8,
            background:showF
              ?"rgba(255,255,255,0.075)"
              :(filters.expiryDays<500||filters.minVolume>0||filters.minLiquidity>1000||filters.minApr>0)
                ?"rgba(255,255,255,0.055)"
                :"rgba(255,255,255,0.038)",
            backdropFilter:"blur(110px) saturate(1.35)",
            WebkitBackdropFilter:"blur(110px) saturate(1.35)",
            border:"none",
            borderRadius:14,padding:"11px 24px",
            color:showF?T.text:(filters.expiryDays<500||filters.minVolume>0||filters.minLiquidity>1000||filters.minApr>0)?T.text:T.textSecondary,
            fontSize:12,fontFamily:T.mono,fontWeight:700,cursor:"pointer",transition:"all .25s",letterSpacing:1.5,
            boxShadow:showF
              ?"0 4px 24px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(255,255,255,0.10)"
              :(filters.expiryDays<500||filters.minVolume>0||filters.minLiquidity>1000||filters.minApr>0)
                ?"0 2px 16px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.18), 0 0 0 1px rgba(255,255,255,0.08)"
                :"inset 0 1px 0 rgba(255,255,255,0.14), 0 2px 10px rgba(0,0,0,0.3)",
            position:"relative",
          }}
          onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.075)";e.currentTarget.style.boxShadow="0 4px 24px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(255,255,255,0.10)";e.currentTarget.style.color=T.text;}}
          onMouseOut={e=>{e.currentTarget.style.background=showF?"rgba(255,255,255,0.075)":(filters.expiryDays<500||filters.minVolume>0||filters.minLiquidity>1000||filters.minApr>0)?"rgba(255,255,255,0.055)":"rgba(255,255,255,0.038)";e.currentTarget.style.boxShadow=showF?"0 4px 24px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(255,255,255,0.10)":"inset 0 1px 0 rgba(255,255,255,0.14), 0 2px 10px rgba(0,0,0,0.3)";e.currentTarget.style.color=showF?T.text:(filters.expiryDays<500||filters.minVolume>0||filters.minLiquidity>1000||filters.minApr>0)?T.text:T.textSecondary;}}
          ><IS/> FILTERS {(filters.expiryDays<500||filters.minVolume>0||filters.minLiquidity>1000||filters.minApr>0)&&<span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:18,height:18,borderRadius:9,background:T.positive,color:"#000",fontSize:9,fontWeight:800,fontFamily:T.mono,padding:"0 5px",letterSpacing:0.5}}>{(filters.expiryDays<500?1:0)+(filters.minVolume>0?1:0)+(filters.minLiquidity>1000?1:0)+(filters.minApr>0?1:0)}</span>}</button>
          <button aria-label="Toggle profitable only" onClick={()=>setProfitableOnly(p=>!p)} style={{
            display:"inline-flex",alignItems:"center",gap:6,
            background:profitableOnly?"rgba(52,199,89,0.12)":"rgba(255,255,255,0.028)",
            backdropFilter:"blur(110px) saturate(1.35)",
            WebkitBackdropFilter:"blur(110px) saturate(1.35)",
            border:profitableOnly?"1px solid rgba(52,199,89,0.35)":"none",
            borderRadius:14,padding:"11px 20px",
            color:profitableOnly?T.positive:T.textSecondary,
            fontSize:11,fontFamily:T.mono,fontWeight:700,cursor:"pointer",transition:"all .25s",letterSpacing:1.5,
            boxShadow:profitableOnly?"0 4px 20px rgba(52,199,89,0.12), inset 0 1px 0 rgba(52,199,89,0.2), 0 0 0 1px rgba(52,199,89,0.15)":"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 10px rgba(0,0,0,0.25)",
          }}
          onMouseOver={e=>{e.currentTarget.style.background=profitableOnly?"rgba(52,199,89,0.18)":"rgba(255,255,255,0.04)";}}
          onMouseOut={e=>{e.currentTarget.style.background=profitableOnly?"rgba(52,199,89,0.12)":"rgba(255,255,255,0.028)";}}
          >{profitableOnly&&<span style={{width:6,height:6,borderRadius:"50%",background:T.positive,boxShadow:"0 0 6px rgba(52,199,89,0.8)",flexShrink:0}}/>}ARB ONLY</button>
          <button aria-label="Toggle alerts configuration" onClick={()=>setShowAlerts(p=>!p)} style={{
            display:"inline-flex",alignItems:"center",gap:6,
            background:showAlerts?"rgba(255,255,255,0.038)":"rgba(255,255,255,0.028)",
            backdropFilter:"blur(110px) saturate(1.35)",
            WebkitBackdropFilter:"blur(110px) saturate(1.35)",
            border:"none",
            borderRadius:12,padding:"9px 18px",color:showAlerts?T.auroraText:T.textSecondary,
            fontSize:11,fontFamily:T.mono,fontWeight:500,cursor:"pointer",transition:"all .25s",letterSpacing:1,
            boxShadow:showAlerts?"0 2px 12px rgba(255,255,255,0.06)":"0 1px 4px rgba(255,255,255,0.04)",
          }}><IBe/> ALERTS {alertCfg.saved&&<span style={{width:5,height:5,borderRadius:"50%",background:T.positive}}/>}</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateRows:showF?"1fr":"0fr",transition:"grid-template-rows 0.4s cubic-bezier(0.4,0,0.2,1)"}}>
          <div style={{overflow:"hidden",opacity:showF?1:0,transition:"opacity 0.35s ease",transformOrigin:"top"}}>
            <Filters filters={filters} setFilters={setFilters} onReset={resetF}/>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateRows:showAlerts?"1fr":"0fr",transition:"grid-template-rows 0.4s cubic-bezier(0.4,0,0.2,1)"}}>
          <div style={{overflow:"hidden",opacity:showAlerts?1:0,transition:"opacity 0.35s ease"}}>
            <AlertPanel cfg={alertCfg} setCfg={setAlertCfg} onClose={closeAlerts}/>
          </div>
        </div>

        {/* ─── FILTER SUMMARY ─── always rendered, animated visibility */}
        <div style={{maxHeight:_filtersActive?40:0,opacity:_filtersActive?1:0,overflow:"hidden",transition:"max-height 0.3s ease, opacity 0.2s ease, margin-bottom 0.3s ease",marginBottom:_filtersActive?8:0}}>
          <div style={{padding:"4px 0"}}>
            <span style={{fontSize:9,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.3}}>{_filterActiveCount} filter{_filterActiveCount!==1?"s":""} active {_filterHiddenCount>0?`\u2014 hiding ${_filterHiddenCount} market${_filterHiddenCount!==1?"s":""}`:""}</span>
          </div>
        </div>

        {/* ─── CATEGORY PILLS ─── */}
        <div className="pl-cat-pills" style={{display:"flex",gap:6,marginBottom:6,flexWrap:"wrap",alignItems:"center"}}>
          {CATS.map(cat=>{
            const active=catFilter===cat;
            const count=catCounts[cat]||0;
            const disabled=count===0&&!active;
            return(
              <button key={cat} onClick={()=>{if(!disabled)setCatFilter(cat);}}
                title={cat==="Saved"&&count===0?"Star any market row to save it here.":undefined}
                style={{padding:"5px 13px",borderRadius:100,border:cat==="Saved"&&active?"none":cat==="Saved"?"1px solid transparent":"none",cursor:disabled?"default":"pointer",fontFamily:T.mono,fontSize:9,fontWeight:600,letterSpacing:1,textTransform:"uppercase",transition:"all .2s",position:"relative",overflow:"hidden",
                  background:cat==="Saved"&&active?"rgba(255,255,255,0.07)":cat==="Saved"?"rgba(255,255,255,0.025)":active?"rgba(255,255,255,0.07)":"rgba(255,255,255,0.018)",
                  color:cat==="Saved"&&active?T.text:cat==="Saved"?T.auroraText:active?T.text:T.textTertiary,
                  backdropFilter:T.glassBlur,
                  backgroundImage:cat==="Saved"&&active?T.aurora:"none",
                  backgroundSize:cat==="Saved"?"300% 300%":"auto",
                  animation:cat==="Saved"&&active?"aShift 4s ease infinite":"none",
                  WebkitBackgroundClip:cat==="Saved"&&active?"padding-box":"padding-box",
                  boxShadow:cat==="Saved"&&active?"inset 0 1px 0 rgba(255,255,255,0.18), 0 2px 10px rgba(0,0,0,0.3), 0 0 12px rgba(255,255,255,0.08)":active?"inset 0 1px 0 rgba(255,255,255,0.18), 0 2px 10px rgba(0,0,0,0.3)":"inset 0 1px 0 rgba(255,255,255,0.07)",
                  opacity:disabled?0.3:1,
                  pointerEvents:disabled?"none":"auto",
                }}
                onMouseOver={e=>{if(!active&&!disabled){e.currentTarget.style.background=cat==="Saved"?"rgba(255,255,255,0.05)":"rgba(255,255,255,0.038)";e.currentTarget.style.color=cat==="Saved"?T.text:T.textSecondary;}}}
                onMouseOut={e=>{if(!active&&!disabled){e.currentTarget.style.background=cat==="Saved"?"rgba(255,255,255,0.025)":"rgba(255,255,255,0.018)";e.currentTarget.style.color=cat==="Saved"?T.auroraText:T.textTertiary;}}}
              >{cat==="Saved"?"⭐ Saved":cat} <span style={{fontFamily:T.mono,color:T.textTertiary,fontSize:8,fontWeight:500,marginLeft:3}}>{count}</span>{cat==="Saved"&&<span style={{position:"absolute",bottom:0,left:"10%",right:"10%",height:1,background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 3s ease infinite",borderRadius:1,opacity:active?0.8:0.4}}/>}</button>
            );
          })}
        </div>
        {/* ─── ACTIVE FILTER TAGS ─── always rendered, animated visibility */}
        <div style={{maxHeight:_hasTags?60:0,opacity:_hasTags?1:0,overflow:"hidden",transition:"max-height 0.3s ease, opacity 0.2s ease, margin-bottom 0.3s ease",marginBottom:_hasTags?6:0}}>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {_filterTags.map((tag,i)=>(
              <span key={i} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 12px",borderRadius:100,background:"rgba(255,255,255,0.03)",fontSize:10,fontFamily:T.mono,color:T.textSecondary,letterSpacing:0.5,fontWeight:500}}>
                {tag.label}
                <span style={{cursor:"pointer",color:"rgba(255,255,255,0.5)",fontSize:11,fontWeight:600,lineHeight:1}} onClick={tag.clear}>×</span>
              </span>
            ))}
          </div>
        </div>
        {/* Result count */}
        <div style={{marginBottom:12,transition:"opacity 0.2s ease"}}>
          <span style={{fontSize:10,color:T.textTertiary,fontFamily:T.mono,letterSpacing:0.5}}>Showing <span style={{color:T.textSecondary,fontWeight:600}}>{filtered.length}</span> of <span style={{color:T.textSecondary,fontWeight:600}}>{prices.length}</span> markets</span>
        </div>

        {/* ─── SAVED SUMMARY BAR ─── */}
        <div style={{maxHeight:_hasSaved?80:0,opacity:_hasSaved?1:0,overflow:"hidden",transition:"max-height 0.4s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease, margin-bottom 0.3s ease",marginBottom:_hasSaved?12:0}}>
          <div style={{...S.miniBox,padding:"12px 20px",borderTop:"2px solid transparent",backgroundImage:`linear-gradient(rgba(255,255,255,0.012),rgba(255,255,255,0.012)), ${T.aurora}`,backgroundOrigin:"border-box",backgroundClip:"padding-box, border-box",backgroundSize:"100% 100%, 300% 300%",animation:"aShift 5s ease infinite",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
            <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:14,opacity:0.7}}>⭐</span>
                <span style={{fontSize:10,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>WATCHLIST</span>
              </div>
              <div style={{width:1,height:16,background:"rgba(255,255,255,0.08)"}}/>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:14,fontWeight:600,fontFamily:T.mono,color:T.text}}>{savedMarkets.size}</div>
                <div style={{fontSize:8,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>MARKETS</div>
              </div>
              <div style={{width:1,height:16,background:"rgba(255,255,255,0.08)"}}/>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:14,fontWeight:600,fontFamily:T.mono,color:T.text}}>${_totalCapital>=1e3?(_totalCapital/1e3).toFixed(1)+"K":_totalCapital.toLocaleString()}</div>
                <div style={{fontSize:8,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>DEPLOYED</div>
              </div>
              <div style={{width:1,height:16,background:"rgba(255,255,255,0.08)"}}/>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:14,fontWeight:600,fontFamily:T.mono,color:_totalPnl>0?T.positive:T.negative}}>{_totalPnl>=0?"+":""}${_totalPnl.toFixed(2)}</div>
                <div style={{fontSize:8,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>EST PNL</div>
              </div>
              <div style={{width:1,height:16,background:"rgba(255,255,255,0.08)"}}/>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:14,fontWeight:600,fontFamily:T.mono,...(_weightedAPR>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:{color:_weightedAPR>0?T.positive:T.negative})}}>{_weightedAPR.toFixed(1)}%</div>
                <div style={{fontSize:8,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>AVG APR</div>
              </div>
            </div>
          </div>
        </div>

        <Card hover={false} style={{overflow:"visible",borderRadius:18}} className="pl-desktop-table">
          <div ref={tableRef} style={{overflow:"visible"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>
                <th style={{...th,textAlign:"left",paddingLeft:24,minWidth:280}}>Market</th>
                {matrixView?<th style={{...th,textAlign:"center",minWidth:200}} title="All platform prices">All Platforms<InfoTip text="Shows YES prices across all 4 platforms. The highest price is highlighted with a glow."/></th>
                :<><th style={{...th,textAlign:"center",...(platformFlash?{animation:"cellFlashWhite 600ms ease-out"}:{})}} title={`YES price on ${pAName}`}><span style={{color:pAColor,marginRight:3}}>{pAIcon}</span>{pAName}<InfoTip text={`${pAName} — Trust score: ${pA.trust}/100 (${pA.settlement}).`}/></th>
                <th style={{...th,textAlign:"center",...(platformFlash?{animation:"cellFlashWhite 600ms ease-out"}:{})}} title={`YES price on ${pBName}`}><span style={{color:pBColor,marginRight:3}}>{pBIcon}</span>{pBName}<InfoTip text={`${pBName} — Trust score: ${pB.trust}/100 (${pB.settlement}).`}/></th></>}
                <th style={sth("spread",{textAlign:"center"})} onClick={()=>togSort("spread")}>Spread<InfoTip text="The price gap between platforms — your gross profit margin per share before fees."/><SI col="spread"/></th>
                <th style={sth("liquidity",{textAlign:"center"})} onClick={()=>togSort("liquidity")}>Liq<InfoTip text="Liquidity score 0–100 based on order book depth at this market. Higher scores mean larger trades can be executed with less slippage."/><SI col="liquidity"/></th>
                <th style={sth("signal",{textAlign:"center"})} onClick={()=>togSort("signal")}>Signal<InfoTip text={<div style={{lineHeight:1.8}}><div style={{fontWeight:700,letterSpacing:1.5,fontSize:9,marginBottom:6,color:T.textTertiary,fontFamily:T.mono}}>SIGNAL SCORE FORMULA</div>{[["Spread","40%"],["Liquidity","30%"],["APR","20%"],["Time-to-Expiry bonus","10%"]].map(([k,v],i)=><div key={i} style={{display:"flex",justifyContent:"space-between",gap:16,fontSize:11,fontFamily:T.mono,padding:"2px 0",borderBottom:i<3?"1px solid rgba(255,255,255,0.05)":"none"}}><span style={{color:"rgba(255,255,255,0.65)"}}>{k}</span><span style={{fontWeight:700,color:T.text}}>{v}</span></div>)}<div style={{marginTop:6,padding:"6px 8px",borderRadius:6,background:"rgba(255,255,255,0.03)",fontSize:9,fontFamily:T.mono,color:T.textTertiary,lineHeight:1.6}}>Higher = more attractive opportunity. Sort by Signal to see top picks.</div></div>}/><SI col="signal"/></th>
                <th style={sth("apr",{textAlign:"right"})} onClick={()=>togSort("apr")}>APR<SI col="apr"/></th>
                <th style={sth("volume",{textAlign:"right"})} onClick={()=>togSort("volume")}>Volume<SI col="volume"/></th>
                <th style={sth("expiry",{textAlign:"right"})} onClick={()=>togSort("expiry")}>Expiry<SI col="expiry"/></th>
                <th style={{...th,width:2,padding:0,background:T.cardSolid}}><div style={{width:1,height:20,background:"rgba(255,255,255,0.08)",margin:"0 auto"}}/></th>
                <th style={{...th,textAlign:"right",paddingRight:24,paddingLeft:24}}>ROI<InfoTip text="Flat return on your capital if the market resolves today at current prices. Unlike APR, this does not adjust for time to expiry."/></th>
                <th style={{...th,width:32,padding:"14px 4px",textAlign:"center"}}>★</th>
                <th style={{...th,width:40,paddingRight:16}}></th>
              </tr></thead>
              <tbody>
                {filtered.map((o,idx)=>{
                  const isExp=resolvedExpanded===o.id;
                  const td=isExp?tradeDetail(o,wager):null;
                  // Check if this is the first non-profitable row when profitableOnly is false
                  const prevO=idx>0?filtered[idx-1]:null;
                  const showThresholdDivider=!profitableOnly&&prevO&&prevO.apr>0&&o.apr<=0;
                  const activeTab=rowTabs[o.id]||"TRADE";
                  const setTab=(t)=>{setRowTabs(prev=>({...prev,[o.id]:t}));};
                  const polyIsYes=getPriceA(o).yes<getPriceB(o).yes;
                  const yesPlatform=polyIsYes?pAName:pBName;
                  const noPlatform=polyIsYes?pBName:pAName;
                  const yesColor=polyIsYes?pAColor:pBColor;
                  const noColor=polyIsYes?pBColor:pAColor;
                  const yesIcon=polyIsYes?pAIcon:pBIcon;
                  const noIcon=polyIsYes?pBIcon:pAIcon;
                  // ── Pre-computed cell values (avoid arrow-fn-in-JSX Babel bug) ──
                  const _histA=priceHistoryRef.current.get(o.id);
                  const _sparkHistA=(_histA&&_histA.length>=2)?_histA.slice(-10):null;
                  const _sparkMnA=_sparkHistA?Math.min(..._sparkHistA):0;
                  const _sparkMxA=_sparkHistA?Math.max(..._sparkHistA):0;
                  const _sparkRngA=_sparkHistA?(_sparkMxA-_sparkMnA||0.01):0.01;
                  const _sparkColorA=_sparkHistA?(_sparkHistA[_sparkHistA.length-1]>_sparkHistA[0]?T.positive:_sparkHistA[_sparkHistA.length-1]<_sparkHistA[0]?T.negativeRaw:"#888"):null;
                  const _sparkPtsA=_sparkHistA?_sparkHistA.map((v,i)=>`${(i/(_sparkHistA.length-1))*48},${18-(((v-_sparkMnA)/_sparkRngA)*14+2)}`).join(" "):null;
                  const _sparkLastYA=_sparkHistA?(18-(((_sparkHistA[_sparkHistA.length-1]-_sparkMnA)/_sparkRngA)*14+2)):0;
                  const _histB=priceHistoryRef.current.get("o"+o.id);
                  const _sparkHistB=(_histB&&_histB.length>=2)?_histB.slice(-10):null;
                  const _sparkMnB=_sparkHistB?Math.min(..._sparkHistB):0;
                  const _sparkMxB=_sparkHistB?Math.max(..._sparkHistB):0;
                  const _sparkRngB=_sparkHistB?(_sparkMxB-_sparkMnB||0.01):0.01;
                  const _sparkColorB=_sparkHistB?(_sparkHistB[_sparkHistB.length-1]>_sparkHistB[0]?T.positive:_sparkHistB[_sparkHistB.length-1]<_sparkHistB[0]?T.negativeRaw:"#888"):null;
                  const _sparkPtsB=_sparkHistB?_sparkHistB.map((v,i)=>`${(i/(_sparkHistB.length-1))*48},${18-(((v-_sparkMnB)/_sparkRngB)*14+2)}`).join(" "):null;
                  const _sparkLastYB=_sparkHistB?(18-(((_sparkHistB[_sparkHistB.length-1]-_sparkMnB)/_sparkRngB)*14+2)):0;
                  const _sv=dynSpread(o)*100;const _sc=_sv>=4?T.positive:_sv>=2?T.warning:T.negative;const _sbg=_sv>=4?"rgba(52,199,89,0.10)":_sv>=2?"rgba(212,168,67,0.08)":"rgba(224,85,85,0.08)";const _pPct=getPriceA(o).yes*100;const _oPct=getPriceB(o).yes*100;const _total=_pPct+_oPct||1;
                  const _sigScore=signalScore(o);const _sigColor=_sigScore>=70?T.positive:_sigScore>=40?T.warning:T.negativeRaw;const _sigBarW=Math.min(100,_sigScore);
                  const _aprVal=dynAPR(o);const _aPrc=getPriceA(o);const _bPrc=getPriceB(o);const _sprd=dynSpread(o);const _cb=_aPrc.yes*(1+pAFee)+(1-_bPrc.yes)*(1+pBFee);const _dte=Math.max(1,(new Date(o.expiry)-new Date())/86400000);
                  const _dLeft=Math.max(0,Math.ceil((new Date(o.expiry)-now)/86400000));const _monthYear=new Date(o.expiry).toLocaleDateString("en-GB",{month:"short",year:"numeric"});const _yrs=(_dLeft/365).toFixed(1);
                  const _daysLeft=Math.max(0,Math.ceil((new Date(o.expiry)-new Date())/86400000));const _riskLevel=o.liquidity<40||_daysLeft>600?"HIGH":o.liquidity<70||_daysLeft>365?"MEDIUM":"LOW";const _riskColor=_riskLevel==="LOW"?T.positive:_riskLevel==="MEDIUM"?T.warning:T.negative;const _riskBg=_riskLevel==="LOW"?"rgba(52,199,89,0.08)":_riskLevel==="MEDIUM"?"rgba(212,168,67,0.06)":"rgba(224,85,85,0.06)";
                  return(
                  <React.Fragment key={o.id}>
                  {showThresholdDivider&&<tr><td colSpan={matrixView?12:13} style={{padding:"4px 0",borderBottom:"none",background:"transparent"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 24px"}}>
                      <div style={{flex:1,borderTop:"1px dashed rgba(255,255,255,0.10)"}}/>
                      <span style={{fontSize:9,fontFamily:T.mono,color:T.textTertiary,letterSpacing:1.5,fontWeight:600,whiteSpace:"nowrap"}}>─── BELOW THRESHOLD ───</span>
                      <div style={{flex:1,borderTop:"1px dashed rgba(255,255,255,0.10)"}}/>
                    </div>
                  </td></tr>}
                  <tr className="pl-table-row" onClick={()=>{const newExp=isExp?null:o.id;setSel(o);setExpanded(newExp);if(newExp!==null){setTimeout(()=>{rowRefs.current.get(o.id)?.scrollIntoView({behavior:'smooth',block:'nearest'});},50);}}}
                    ref={el=>{if(el){rowRefs.current.set(o.id,el);if(idx===0)bestCardRef.current=el;}}}
                    tabIndex={0} role="button"
                    aria-label={`${o.event} — APR ${o.apr.toFixed(1)}%. Press Enter to expand trade details.`}
                    onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSel(o);setExpanded(isExp?null:o.id);}}}
                    style={{borderBottom:"none",cursor:"pointer",transition:"all .2s",background:isExp?"rgba(255,255,255,0.03)":sel?.id===o.id?"rgba(255,255,255,0.02)":"transparent",boxShadow:isExp?"inset 3px 0 0 "+T.auroraText:"none",outline:"none",opacity:o.apr<=0?0.6:1,animationDelay:`${idx*0.03}s`,...(flashRows[o.id]==="green"?{animation:"rowFlashGreen 600ms ease-out"}:flashRows[o.id]==="red"?{animation:"rowFlashRed 600ms ease-out"}:{})}}
                    onMouseOver={e=>{if(!isExp&&sel?.id!==o.id){e.currentTarget.style.background="rgba(255,255,255,0.015)";e.currentTarget.style.boxShadow="0 0 24px rgba(255,255,255,0.03)";}}}
                    onMouseOut={e=>{if(!isExp&&sel?.id!==o.id){e.currentTarget.style.background="transparent";e.currentTarget.style.boxShadow="none";}}}>
                    <td style={{padding:"14px 24px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        {o.status==="hot"&&<span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 8px",borderRadius:8,background:"rgba(255,255,255,0.022)",backdropFilter:"blur(100px) saturate(1.30)",border:"none",animation:"hotPulse 2s ease-in-out infinite",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10)",fontSize:9,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:"#ffffff"}}><IF/> HOT</span>}
                        <span style={{fontSize:10,color:T.textTertiary,fontFamily:T.mono,letterSpacing:0.5}}>Exp {new Date(o.expiry).toLocaleDateString("en-GB",{month:"short",year:"numeric"})}</span>
                        {isExp&&<span style={{fontSize:8,fontFamily:T.mono,color:T.auroraText,letterSpacing:1,padding:"2px 6px",borderRadius:4,background:"rgba(255,255,255,0.03)"}}>▼ DETAILS</span>}
                      </div>
                      <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:3}}>
                        <span aria-label={pAName} style={{fontSize:10,fontWeight:700,color:pAColor,fontFamily:T.mono,width:14,textAlign:"right",flexShrink:0}}>{pAIcon}</span>
                        <span style={{color:T.text,fontWeight:600,fontSize:15}}>{getNameA(o)}</span>
                      </div>
                      <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                        <span aria-label={pBName} style={{fontSize:10,fontWeight:700,color:pBColor,fontFamily:T.mono,width:14,textAlign:"right",flexShrink:0}}>{pBIcon}</span>
                        <span style={{color:T.text,fontWeight:600,fontSize:15}}>{getNameB(o)}</span>
                      </div>
                    </td>
                    {/* Platform price cells — Matrix or Pair mode */}
                    {matrixView?<td style={{textAlign:"center",padding:"10px 8px"}}>
                      <div style={{display:"flex",gap:4,justifyContent:"center",flexWrap:"wrap"}}>
                        {PLATFORM_KEYS.map(pk=>{const pl=PLATFORMS[pk];const pr=o.allPrices?.[pk]||o.prices?.[pk]||{yes:0.5};const yesVal=pr.yes*100;const isHighest=PLATFORM_KEYS.every(k2=>(o.allPrices?.[k2]||o.prices?.[k2]||{yes:0}).yes<=pr.yes);return(
                          <span key={pk} style={{display:"inline-flex",alignItems:"center",gap:3,padding:"3px 8px",borderRadius:8,fontSize:10,fontWeight:600,fontFamily:T.mono,
                            background:isHighest?`${pl.color}18`:"rgba(255,255,255,0.015)",
                            color:pl.color,
                            boxShadow:isHighest?`0 0 10px ${pl.color}20, inset 0 1px 0 rgba(255,255,255,0.10)`:"inset 0 1px 0 rgba(255,255,255,0.06)",
                            border:isHighest?`1px solid ${pl.color}33`:"1px solid transparent",
                            transition:"all .2s"}}>
                            <span style={{fontSize:8}}>{pl.icon}</span>{yesVal.toFixed(1)}
                          </span>);
                        })}
                      </div>
                    </td>
                    :<>
                    {/* Polymarket YES/NO stacked */}
                    <td style={{textAlign:"center",padding:"10px 8px",...(platformFlash?{animation:"cellFlashWhite 600ms ease-out"}:{})}}>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5}}>
                        <div style={{padding:"4px 12px",borderRadius:10,background:"rgba(255,255,255,0.022)",backdropFilter:"blur(110px) saturate(1.35)",border:"none",minWidth:58,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.2)",animation:priceDir[o.id]?.poly==="up"?"priceCellFlashGreen 400ms ease-out":priceDir[o.id]?.poly==="down"?"priceCellFlashRed 400ms ease-out":"none"}}>
                          <span style={{fontFamily:T.mono,color:pAColor,fontWeight:700,fontSize:14}}>{(getPriceA(o).yes*100).toFixed(1)}{priceDir[o.id]?.poly==="up"?<span aria-label="price up" style={{fontSize:11,color:T.positive,marginLeft:2,display:"inline-block",animation:"arrowFade 0.3s ease-out"}}>▲</span>:priceDir[o.id]?.poly==="down"?<span aria-label="price down" style={{fontSize:11,color:T.negative,marginLeft:2,display:"inline-block",animation:"arrowFade 0.3s ease-out"}}>▼</span>:null}</span>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontFamily:T.mono,fontWeight:700,marginTop:1,letterSpacing:1}}>YES</div>
                          {_sparkHistA&&<svg width="48" height="18" style={{display:"block",margin:"3px auto 0"}}><polyline points={_sparkPtsA} fill="none" stroke={_sparkColorA} strokeWidth="1.2" opacity="0.7" strokeLinejoin="round" strokeLinecap="round"/><circle cx={48} cy={_sparkLastYA} r="2" fill={_sparkColorA} opacity="0.9"/></svg>}
                        </div>
                        <div style={{padding:"4px 12px",borderRadius:10,background:"rgba(255,255,255,0.01)",backdropFilter:"blur(110px) saturate(1.35)",border:"none",minWidth:58,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.09), 0 2px 8px rgba(0,0,0,0.15)"}}>
                          <span style={{fontFamily:T.mono,color:pAColor,fontWeight:500,fontSize:14,opacity:0.7}}>{(getPriceA(o).no*100).toFixed(1)}</span>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:T.mono,fontWeight:700,marginTop:1,letterSpacing:1}}>NO</div>
                        </div>
                      </div>
                    </td>
                    {/* Opinion YES/NO stacked */}
                    <td style={{textAlign:"center",padding:"10px 8px",...(platformFlash?{animation:"cellFlashWhite 600ms ease-out"}:{})}}>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5}}>
                        <div style={{padding:"4px 12px",borderRadius:10,background:"rgba(255,255,255,0.018)",backdropFilter:"blur(110px) saturate(1.35)",border:"none",minWidth:58,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 8px rgba(0,0,0,0.2)",animation:priceDir[o.id]?.opin==="up"?"priceCellFlashGreen 400ms ease-out":priceDir[o.id]?.opin==="down"?"priceCellFlashRed 400ms ease-out":"none"}}>
                          <span style={{fontFamily:T.mono,color:pBColor,fontWeight:700,fontSize:14}}>{(getPriceB(o).yes*100).toFixed(1)}{priceDir[o.id]?.opin==="up"?<span aria-label="price up" style={{fontSize:11,color:T.positive,marginLeft:2,display:"inline-block",animation:"arrowFade 0.3s ease-out"}}>▲</span>:priceDir[o.id]?.opin==="down"?<span aria-label="price down" style={{fontSize:11,color:T.negative,marginLeft:2,display:"inline-block",animation:"arrowFade 0.3s ease-out"}}>▼</span>:null}</span>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.5)",fontFamily:T.mono,fontWeight:700,marginTop:1,letterSpacing:1}}>YES</div>
                          {_sparkHistB&&<svg width="48" height="18" style={{display:"block",margin:"3px auto 0"}}><polyline points={_sparkPtsB} fill="none" stroke={_sparkColorB} strokeWidth="1.2" opacity="0.7" strokeLinejoin="round" strokeLinecap="round"/><circle cx={48} cy={_sparkLastYB} r="2" fill={_sparkColorB} opacity="0.9"/></svg>}
                        </div>
                        <div style={{padding:"4px 12px",borderRadius:10,background:"rgba(255,255,255,0.01)",backdropFilter:"blur(110px) saturate(1.35)",border:"none",minWidth:58,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.09), 0 2px 8px rgba(0,0,0,0.15)"}}>
                          <span style={{fontFamily:T.mono,color:pBColor,fontWeight:500,fontSize:14,opacity:0.7}}>{(getPriceB(o).no*100).toFixed(1)}</span>
                          <div style={{fontSize:9,color:"rgba(255,255,255,0.35)",fontFamily:T.mono,fontWeight:700,marginTop:1,letterSpacing:1}}>NO</div>
                        </div>
                      </div>
                    </td>
                    </>}
                    <td style={{textAlign:"center",padding:"14px 8px"}}>
                      <div style={{display:"inline-flex",flexDirection:"column",alignItems:"center",gap:5,position:"relative"}}>
                        <span style={{padding:"5px 12px",borderRadius:10,fontFamily:T.mono,fontWeight:600,fontSize:12,background:_sbg,border:"1px solid "+_sc+"33",color:_sc,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.05)"}}>{_sv.toFixed(1)}%</span>
                        <div style={{width:48,height:3,borderRadius:2,overflow:"hidden",display:"flex",gap:1}}>
                          <div style={{flex:_pPct/_total,background:pAColor,borderRadius:"2px 0 0 2px",opacity:0.8}}/>
                          <div style={{flex:_oPct/_total,background:pBColor,borderRadius:"0 2px 2px 0",opacity:0.8}}/>
                        </div>
                        {o.apr<=0&&<span style={{fontSize:7,fontWeight:700,letterSpacing:1,fontFamily:T.mono,color:T.negativeRaw,padding:"1px 6px",borderRadius:4,background:"rgba(224,85,85,0.1)",border:"1px solid rgba(224,85,85,0.2)"}}>NO ARB</span>}
                      </div>
                    </td>
                    <td style={{textAlign:"center",padding:"14px 8px"}}>
                      <div style={{display:"inline-flex",alignItems:"center",gap:5,position:"relative"}}>
                        <div style={{width:40,height:4,borderRadius:2,background:"rgba(255,255,255,0.06)",boxShadow:"inset 0 1px 2px rgba(0,0,0,0.3)",overflow:"hidden"}}>
                          <div style={{height:"100%",borderRadius:2,width:`${o.liquidity}%`,background:o.liquidity>=70?T.positive:o.liquidity>=40?T.warning:T.negative,transition:"width .3s"}}/>
                        </div>
                        <span style={{fontFamily:T.mono,fontSize:10,color:o.liquidity>=70?T.positive:o.liquidity>=40?T.textSecondary:T.negative,fontWeight:500}}>{o.liquidity}</span>
                      </div>
                    </td>
                    <td style={{textAlign:"center",padding:"14px 8px"}}>
                      <div style={{display:"inline-flex",flexDirection:"column",alignItems:"center",gap:3}}>
                        <span style={{fontFamily:T.mono,fontWeight:700,fontSize:14,color:_sigColor,letterSpacing:"-0.5px"}}>{_sigScore}</span>
                        <div style={{width:32,height:3,borderRadius:2,background:"rgba(255,255,255,0.06)",overflow:"hidden"}}><div style={{height:"100%",width:`${_sigBarW}%`,borderRadius:2,background:_sigColor,transition:"width .3s"}}/></div>
                      </div>
                    </td>
                    <td style={{textAlign:"right",padding:"14px 12px",position:"relative",overflow:"visible"}}>
                      <AprCellTip apr={_aprVal} spread={_sprd} costBasis={_cb} daysToExpiry={_dte} pAFee={pAFee} pBFee={pBFee} priceA={_aPrc.yes} priceB={_bPrc.yes}/>
                    </td>
                    <td style={{textAlign:"right",padding:"14px 12px"}}>
                      <span style={{fontFamily:T.mono,color:T.textSecondary,fontSize:12,fontWeight:400}}>${o.volume>=1e6?(o.volume/1e6).toFixed(1)+"M":(o.volume/1e3).toFixed(0)+"K"}</span>
                    </td>
                    <td style={{textAlign:"right",padding:"14px 12px"}}>
                      {_dLeft<=90?<span style={{fontFamily:T.mono,color:T.warning,fontSize:11,fontWeight:600}}>{_dLeft} days</span>:_dLeft<=365?<span style={{fontFamily:T.mono,color:T.textSecondary,fontSize:11,fontWeight:400}}>{_monthYear}</span>:<span style={{fontFamily:T.mono,fontSize:11,fontWeight:400}}><span style={{color:T.textSecondary}}>{_monthYear}</span><span style={{color:T.textTertiary}}> · {_yrs}y</span></span>}
                    </td>
                    <td style={{padding:0,width:2}}><div style={{width:1,height:20,background:"rgba(255,255,255,0.06)",margin:"0 auto"}}/></td>
                    <td style={{textAlign:"right",padding:"14px 24px",paddingLeft:24}}>
                      <span style={{fontFamily:T.mono,color:estProfit(o)>3?T.positive:T.text,fontWeight:600,fontSize:13}}>{estProfit(o).toFixed(1)}%</span>
                      <div style={{fontSize:10,fontFamily:T.mono,color:T.textSecondary,fontWeight:400,marginTop:2}}>{estProfit(o)>0?"+":""}${(wager*(estProfit(o)/100)).toFixed(0)}</div>
                    </td>
                    <td style={{textAlign:"center",padding:"14px 4px"}}>
                      <span role="button" tabIndex={0} aria-label={savedMarkets.has(o.id)?"Remove from saved":"Save market"} onClick={e=>toggleSaved(o.id,e)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggleSaved(o.id,e);}}} style={{cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:24,borderRadius:6,transition:"all .2s",outline:"none",opacity:savedMarkets.has(o.id)?1:0.18}}
                        onMouseOver={e=>{e.currentTarget.style.opacity="1";e.currentTarget.style.background="rgba(255,255,255,0.04)";}}
                        onMouseOut={e=>{e.currentTarget.style.opacity=savedMarkets.has(o.id)?"1":"0.18";e.currentTarget.style.background="transparent";}}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={savedMarkets.has(o.id)?T.auroraText:T.textTertiary} stroke={savedMarkets.has(o.id)?T.auroraText:T.textTertiary} strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                      </span>
                    </td>
                    <td style={{textAlign:"center",padding:"14px 8px",paddingRight:16,color:T.textTertiary}}>
                      <IChevron expanded={isExp}/>
                    </td>
                  </tr>
                  {/* ─── EXPANDED DROPDOWN ─── */}
                  {isExp&&td&&(
                  <tr><td colSpan={matrixView?12:13} style={{padding:0,borderBottom:"none",background:T.auroraSoft}}>
                    <div style={{padding:"20px 28px"}}>
                      {/* Tab bar */}
                      <div style={{display:"flex",gap:0,marginBottom:16,borderRadius:12,overflow:"hidden",background:"rgba(255,255,255,0.012)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)"}}>
                        {["TRADE","ORDER BOOK"].map(tab=>(
                          <button key={tab} onClick={e=>{e.stopPropagation();setTab(tab);}}
                            style={{flex:1,padding:"10px 16px",border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:9,fontWeight:700,letterSpacing:2,
                              background:activeTab===tab?"rgba(255,255,255,0.04)":"transparent",
                              color:activeTab===tab?T.text:T.textTertiary,
                              boxShadow:activeTab===tab?"inset 0 -2px 0 rgba(255,255,255,0.3)":"none",
                              transition:"all .2s"}}>{tab}</button>
                        ))}
                      </div>

                      {/* Tab content — CSS Grid stacking: all tabs render in same cell, container = tallest tab height, no layout shift */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr",gridTemplateRows:"1fr"}}>

                      {/* TRADE TAB */}
                      <div style={{gridArea:"1/1",opacity:activeTab==="TRADE"?1:0,transition:"opacity 0.22s ease",pointerEvents:activeTab==="TRADE"?"auto":"none",willChange:"opacity"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"8px 14px",borderRadius:12,background:"rgba(255,255,255,0.015)",backdropFilter:"blur(100px) saturate(1.30)",border:"none",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.07)"}}>
                        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                        <span style={{fontSize:10,color:T.textSecondary,fontFamily:T.body,lineHeight:1.5}}>
                          <span style={{fontWeight:600,color:T.text}}>Strategy:</span> Buy <span style={{color:yesColor,fontWeight:600}}>YES</span> on <span style={{color:yesColor,fontWeight:600}}>{yesPlatform}</span>, <span style={{color:noColor,fontWeight:600}}>NO</span> on <span style={{color:noColor,fontWeight:600}}>{noPlatform}</span>. If the event resolves either way, one side pays out $1 per share — locking in the spread as profit.
                        </span>
                      </div>
                      <div className="pl-wager-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:12}}>
                        <div style={{display:"flex",alignItems:"center",gap:12}}>
                          <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>WAGER SIZE</span>
                          <div style={{display:"flex",alignItems:"center",position:"relative"}}>
                            <span style={{position:"absolute",left:12,fontSize:14,fontWeight:600,fontFamily:T.mono,color:T.textTertiary,pointerEvents:"none",zIndex:1}}>$</span>
                            <input type="number" min={10} value={wager} onChange={e=>{const v=Math.max(10,Number(e.target.value));setWager(v);}}
                              style={{width:130,padding:"8px 12px 8px 26px",borderRadius:12,border:wager>(o.bookDepth*0.8)?"1px solid #ff4444":"none",background:"rgba(255,255,255,0.018)",backdropFilter:"blur(100px) saturate(1.30)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 12px rgba(0,0,0,0.25)",fontFamily:T.mono,fontSize:14,fontWeight:600,color:T.text,outline:"none"}} onClick={e=>e.stopPropagation()}/>
                          </div>
                          {[100,500,1000,5000,10000].map(amt=>(
                            <button key={amt} onClick={e=>{e.stopPropagation();setWager(amt);}}
                              style={{padding:"5px 10px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:10,fontWeight:600,letterSpacing:0.5,background:wager===amt?"rgba(255,255,255,0.05)":"rgba(255,255,255,0.015)",color:wager===amt?T.text:T.textTertiary,boxShadow:wager===amt?"inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 8px rgba(0,0,0,0.2)":"inset 0 1px 0 rgba(255,255,255,0.08)",transition:"all .2s"}}
                            >{amt>=1000?"$"+(amt/1000)+"K":"$"+amt}</button>
                          ))}
                          <button onClick={e=>{e.stopPropagation();const mp=Math.floor(td.maxProfit);setWager(mp);}} title="Set wager to maximum profitable size before slippage exceeds spread"
                            style={{padding:"5px 12px",borderRadius:8,border:"1px solid rgba(255,255,255,0.18)",cursor:"pointer",fontFamily:T.mono,fontSize:10,fontWeight:700,letterSpacing:0.5,background:"rgba(255,255,255,0.06)",color:"#ffffff",transition:"all .2s",boxShadow:"0 0 8px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.12)"}}
                            onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.12)";e.currentTarget.style.borderColor="rgba(255,255,255,0.35)";e.currentTarget.style.boxShadow="0 0 14px rgba(255,255,255,0.12), inset 0 1px 0 rgba(255,255,255,0.2)";}}
                            onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.borderColor="rgba(255,255,255,0.18)";e.currentTarget.style.boxShadow="0 0 8px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.12)";}}
                          >MAX ~{td.maxProfit>=1e3?"$"+(td.maxProfit/1e3).toFixed(0)+"K":"$"+Math.floor(td.maxProfit)}</button>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
                          {wager>(o.bookDepth*0.8)&&<span style={{fontSize:13,fontFamily:T.mono,color:"#ff4444",fontWeight:700,letterSpacing:0.3}}>⚠ Exceeds max profitable size</span>}
                        </div>
                      </div>
                      <div className="pl-metric-bar" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0,borderRadius:16,overflow:"hidden",marginBottom:18,boxShadow:"0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.09)"}}>
                        <div style={{background:"rgba(255,255,255,0.025)",backdropFilter:"blur(110px) saturate(1.35)",padding:"12px 16px",textAlign:"center",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10)"}}>
                          <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:4}}>NET PNL</div>
                          <div style={{fontSize:20,fontWeight:600,fontFamily:T.mono,color:td.netPnl>0?T.positive:T.negative}}>${td.netPnl.toFixed(2)}</div>
                        </div>
                        <div style={{background:"rgba(255,255,255,0.018)",backdropFilter:"blur(110px) saturate(1.35)",padding:"12px 16px",textAlign:"center",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.09)"}}>
                          <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:4}}>LIVE APR</div>
                          <div style={{fontSize:20,fontWeight:600,fontFamily:T.mono,...(td.annualizedAPR>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:td.annualizedAPR>0?{color:T.positive}:{color:T.negative})}}>{td.annualizedAPR.toFixed(1)}%</div>
                        </div>
                        <div style={{background:"rgba(255,255,255,0.014)",backdropFilter:"blur(110px) saturate(1.35)",padding:"12px 16px",textAlign:"center",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.04)"}}>
                          <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:4}}>COST BASIS</div>
                          <div style={{fontSize:20,fontWeight:600,fontFamily:T.mono,color:T.text}}>${td.costBasis.toFixed(2)}</div>
                        </div>
                      </div>
                      <div className="pl-expanded-sides" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                        {/* Polymarket Side */}
                        <div style={{background:"rgba(255,255,255,0.012)",backdropFilter:"blur(100px) saturate(1.30)",borderRadius:18,border:"none",overflow:"hidden",boxShadow:"0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(255,255,255,0.02)"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",borderBottom:"none"}}>
                            <span style={{fontSize:10,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:pAColor}}><span aria-label={pAName} style={{marginRight:4}}>{pAIcon}</span>{pAName.toUpperCase()} SIDE</span>
                            <span style={{fontSize:11,fontWeight:800,padding:"5px 14px",borderRadius:20,background:`${polyIsYes?T.positive:T.negativeRaw}22`,color:polyIsYes?T.positive:T.negativeRaw,boxShadow:`0 0 0 1px ${polyIsYes?T.positive:T.negativeRaw}44, inset 0 1px 0 rgba(255,255,255,0.10)`,fontFamily:T.mono,letterSpacing:1,display:"inline-flex",alignItems:"center",gap:4}}>{polyIsYes?"↑ BUY YES":"↓ BUY NO"}</span>
                          </div>
                          <div style={{padding:"12px 16px"}}>
                            {[
                              ["AVG SHARE PRICE",`$${td.polyPrice.toFixed(3)}`],
                              ["SHARES TO BUY",td.shares.toLocaleString()],
                              ["TOTAL COST",`$${td.polyCost.toFixed(2)}`],
                              ["EST. FEE ("+(pAFee*100).toFixed(2)+"%)",`-$${td.polyFeeAmt.toFixed(2)}`,T.warning],
                              ["TOTAL COST (INC. FEES)",`$${td.polyTotal.toFixed(2)}`],
                              ["ROI",`${td.roi.toFixed(2)}%`],
                            ].map(([l,v,c],i)=>(
                              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"none"}}>
                                <span style={{fontSize:11,fontFamily:T.mono,fontWeight:c?700:500,color:c||T.textSecondary,letterSpacing:0.5}}>{l}</span>
                                <span style={{fontSize:12,fontFamily:T.mono,fontWeight:600,color:c||T.text}}>{v}</span>
                              </div>
                            ))}
                            <div style={{display:"flex",justifyContent:"space-between",padding:"12px 0 4px",borderTop:"none",marginTop:4}}>
                              <span style={{fontSize:11,fontFamily:T.mono,fontWeight:700,color:T.textSecondary,letterSpacing:0.5}}>PAYOUT IF THIS SIDE WINS</span>
                              <div style={{textAlign:"right"}}>
                                <span style={{fontSize:14,fontFamily:T.mono,fontWeight:700,color:T.positive}}>${td.toReturn.toLocaleString()}</span>
                                <span style={{fontSize:10,fontFamily:T.mono,color:T.positive,marginLeft:6}}>[+${(td.toReturn-td.polyTotal).toFixed(2)}]</span>
                              </div>
                            </div>
                          </div>
                        </div>
                        {/* Opinion Side */}
                        <div style={{background:"rgba(255,255,255,0.012)",backdropFilter:"blur(100px) saturate(1.30)",borderRadius:18,border:"none",overflow:"hidden",boxShadow:"0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(255,255,255,0.02)"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",borderBottom:"none"}}>
                            <span style={{fontSize:10,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:pBColor}}><span aria-label={pBName} style={{marginRight:4}}>{pBIcon}</span>{pBName.toUpperCase()} SIDE</span>
                            <span style={{fontSize:11,fontWeight:800,padding:"5px 14px",borderRadius:20,background:`${polyIsYes?T.negativeRaw:T.positive}22`,color:polyIsYes?T.negativeRaw:T.positive,boxShadow:`0 0 0 1px ${polyIsYes?T.negativeRaw:T.positive}44, inset 0 1px 0 rgba(255,255,255,0.10)`,fontFamily:T.mono,letterSpacing:1,display:"inline-flex",alignItems:"center",gap:4}}>{polyIsYes?"↓ BUY NO":"↑ BUY YES"}</span>
                          </div>
                          <div style={{padding:"12px 16px"}}>
                            {[
                              ["AVG SHARE PRICE",`$${td.opinPrice.toFixed(3)}`],
                              ["SHARES TO BUY",td.shares.toLocaleString()],
                              ["TOTAL COST",`$${td.opinCost.toFixed(2)}`],
                              ["EST. FEE ("+(pBFee*100).toFixed(2)+"%)",`-$${td.opinFeeAmt.toFixed(2)}`,td.opinFeeAmt===0?T.positive:T.warning],
                              ["TOTAL COST (INC. FEES)",`$${td.opinTotal.toFixed(2)}`],
                            ].map(([l,v,c],i)=>(
                              <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"none"}}>
                                <span style={{fontSize:11,fontFamily:T.mono,fontWeight:c?700:500,color:c||T.textSecondary,letterSpacing:0.5}}>{l}</span>
                                <span style={{fontSize:12,fontFamily:T.mono,fontWeight:600,color:c||T.text}}>{v}</span>
                              </div>
                            ))}
                            <div style={{display:"flex",justifyContent:"space-between",padding:"12px 0 4px",borderTop:"none",marginTop:4}}>
                              <span style={{fontSize:11,fontFamily:T.mono,fontWeight:700,color:T.textSecondary,letterSpacing:0.5}}>PAYOUT IF THIS SIDE WINS</span>
                              <div style={{textAlign:"right"}}>
                                <span style={{fontSize:14,fontFamily:T.mono,fontWeight:700,color:T.positive}}>${td.toReturn.toLocaleString()}</span>
                                <span style={{fontSize:10,fontFamily:T.mono,color:T.positive,marginLeft:6}}>[+${(td.toReturn-td.opinTotal).toFixed(2)}]</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                      {/* Guaranteed Net PnL Summary */}
                      <div style={{marginTop:4}}>
                        <div style={{padding:"14px 20px",borderRadius:16,background:"rgba(255,255,255,0.02)",backdropFilter:"blur(110px) saturate(1.35)",boxShadow:"0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.09)",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                          <span style={{fontSize:10,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>GUARANTEED NET PNL<span style={{fontWeight:400,opacity:0.7}}>*</span></span>
                          <span style={{fontSize:22,fontWeight:600,fontFamily:T.mono,color:td.netPnl>0?T.positive:T.negative}}>${td.netPnl.toFixed(2)} <span style={{fontSize:10,fontWeight:500,color:T.textSecondary}}>regardless of outcome</span></span>
                        </div>
                        <div style={{marginTop:5,paddingLeft:4,fontSize:9,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.3}}>* Assumes simultaneous execution at quoted prices. Slippage and execution risk may affect realized profit.</div>
                      </div>
                      {/* Risk Level — integrated from Risk tab */}
                      <div style={{display:"flex",alignItems:"center",gap:12,marginTop:8,padding:"12px 18px",borderRadius:14,background:_riskBg,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)"}}>
                        <span style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>RISK LEVEL</span>
                        <span style={{fontSize:12,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:_riskColor,padding:"3px 12px",borderRadius:8,background:"rgba(255,255,255,0.03)",border:"1px solid "+_riskColor+"33"}}>{_riskLevel}</span>
                        <span style={{fontSize:10,fontFamily:T.body,color:T.textSecondary,marginLeft:"auto"}}>{_riskLevel==="LOW"?"Good liquidity, reasonable timeline":_riskLevel==="MEDIUM"?"Moderate risk — monitor closely":"Thin liquidity or distant expiry"}</span>
                      </div>
                      {/* Copy Trade Steps button */}
                      <CopyTradeStepsBtn market={o} td={td} pAName={pAName} pBName={pBName} pAIcon={pAIcon} pBIcon={pBIcon} polyIsYes={polyIsYes} wager={wager} dynAPR={dynAPR} showToast={showToast}/>
                      </div>

                      {/* ORDER BOOK TAB */}
                      <div style={{gridArea:"1/1",opacity:activeTab==="ORDER BOOK"?1:0,transition:"opacity 0.22s ease",pointerEvents:activeTab==="ORDER BOOK"?"auto":"none",willChange:"opacity"}}>
                        <div style={{background:"rgba(255,255,255,0.012)",borderRadius:18,border:"none",overflow:"visible",boxShadow:"0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)",padding:"20px 24px"}}>
                          {/* Header */}
                          <div style={{marginBottom:16}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                              <div>
                                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                                  <span style={{fontSize:15,fontWeight:700,letterSpacing:"-0.3px",fontFamily:T.display,color:T.text}}>{pAName}</span>
                                  <span style={{fontSize:11,color:T.textTertiary,fontFamily:T.mono,fontWeight:400}}>vs</span>
                                  <span style={{fontSize:15,fontWeight:700,letterSpacing:"-0.3px",fontFamily:T.display,color:T.text}}>{pBName}</span>
                                  <span style={{fontSize:10,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary,marginLeft:4}}>ORDER BOOK</span>
                                </div>
                                <span style={{fontSize:11,fontFamily:T.body,color:T.textSecondary,lineHeight:1.6,display:"block",maxWidth:520}}>Cumulative bid/ask depth for each platform. The <span style={{color:"rgba(255,255,255,0.7)",fontWeight:500}}>shaded region</span> between dashed lines represents the arbitrage spread — wider gap means more profit per share.</span>
                              </div>
                              <div style={{padding:"6px 12px",borderRadius:8,background:"rgba(255,255,255,0.02)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)",display:"flex",alignItems:"center",gap:6}}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                                <span style={{fontSize:8,fontWeight:600,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>HOVER TO INSPECT</span>
                              </div>
                            </div>
                            <div style={{display:"flex",gap:16,flexWrap:"wrap",padding:"10px 16px",borderRadius:12,background:"rgba(255,255,255,0.015)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)"}}>
                              <div style={{display:"flex",alignItems:"center",gap:5}}>
                                <span style={{width:16,height:2,borderRadius:1,background:pAColor,display:"inline-block"}}/>
                                <span style={{fontSize:9,fontFamily:T.mono,color:pAColor,fontWeight:600,letterSpacing:0.5}}>{pAIcon} {pAShort.toUpperCase()} BIDS</span>
                              </div>
                              <div style={{display:"flex",alignItems:"center",gap:5}}>
                                <span style={{width:16,height:2,borderRadius:1,background:pAColor,opacity:0.45,display:"inline-block",backgroundImage:"repeating-linear-gradient(90deg,"+pAColor+" 0,"+pAColor+" 4px,transparent 4px,transparent 6px)"}}/>
                                <span style={{fontSize:9,fontFamily:T.mono,color:pAColor,opacity:0.55,fontWeight:500,letterSpacing:0.5}}>{pAIcon} {pAShort.toUpperCase()} ASKS</span>
                              </div>
                              <div style={{width:1,height:14,background:"rgba(255,255,255,0.06)",alignSelf:"center"}}/>
                              <div style={{display:"flex",alignItems:"center",gap:5}}>
                                <span style={{width:16,height:2,borderRadius:1,background:pBColor,display:"inline-block"}}/>
                                <span style={{fontSize:9,fontFamily:T.mono,color:pBColor,fontWeight:600,letterSpacing:0.5}}>{pBIcon} {pBShort.toUpperCase()} BIDS</span>
                              </div>
                              <div style={{display:"flex",alignItems:"center",gap:5}}>
                                <span style={{width:16,height:2,borderRadius:1,background:pBColor,opacity:0.45,display:"inline-block",backgroundImage:"repeating-linear-gradient(90deg,"+pBColor+" 0,"+pBColor+" 4px,transparent 4px,transparent 6px)"}}/>
                                <span style={{fontSize:9,fontFamily:T.mono,color:pBColor,opacity:0.55,fontWeight:500,letterSpacing:0.5}}>{pBIcon} {pBShort.toUpperCase()} ASKS</span>
                              </div>
                              <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5}}>
                                <span style={{width:12,height:8,borderRadius:2,background:"linear-gradient(90deg,"+pAColor+"22,rgba(255,255,255,0.08),"+pBColor+"22)",display:"inline-block"}}/>
                                <span style={{fontSize:9,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.5}}>SPREAD ZONE</span>
                              </div>
                            </div>
                          </div>
                          <MiniDepthChart market={o} pAColor={pAColor} pBColor={pBColor}/>
                          <OrderBookChart market={o} dualPlatform platformA={pA} platformB={pB}/>

                        </div>
                      </div>

                      </div>
                      {/* End of tab content grid container */}

                      {/* Action buttons — always visible */}
                      <div className="pl-expanded-actions" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16}}>
                        <button style={{padding:"12px",borderRadius:14,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:11,letterSpacing:2,background:"rgba(255,255,255,0.025)",backdropFilter:"blur(110px) saturate(1.35)",color:pAColor,display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)"}}
                          onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 8px 32px rgba(0,0,0,0.3), 0 0 24px rgba(255,255,255,0.05)";}}
                          onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.025)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)";}}
                          onClick={e=>{e.stopPropagation();showToast(`${pAIcon} ${pAName} — Opens in production mode`,pA.key+".com/market/"+o.id);}}>{pAIcon} GO TO {pAName.toUpperCase()} <IA/></button>
                        <button style={{padding:"12px",borderRadius:14,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:11,letterSpacing:2,background:"rgba(255,255,255,0.025)",backdropFilter:"blur(110px) saturate(1.35)",color:pBColor,display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)"}}
                          onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 8px 32px rgba(0,0,0,0.3), 0 0 24px rgba(255,255,255,0.05)";}}
                          onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.025)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)";}}
                          onClick={e=>{e.stopPropagation();showToast(`${pBIcon} ${pBName} — Opens in production mode`,pB.key+".io/market/"+o.id);}}>{pBIcon} GO TO {pBName.toUpperCase()} <IA/></button>
                        <button style={{padding:"12px",borderRadius:14,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:11,letterSpacing:2,background:"rgba(255,255,255,0.025)",backdropFilter:"blur(110px) saturate(1.35)",color:T.textSecondary,display:"flex",alignItems:"center",justifyContent:"center",gap:8,transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)"}}
                          onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.04)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 8px 32px rgba(0,0,0,0.3), 0 0 24px rgba(255,255,255,0.05)";e.currentTarget.style.color=T.text;}}
                          onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.025)";e.currentTarget.style.boxShadow="inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)";e.currentTarget.style.color=T.textSecondary;}}
                          onClick={e=>{e.stopPropagation();const prA=getPriceA(o),prB=getPriceB(o);const txt=`ProphetLabs Signal — ${o.event}\nBuy YES on ${pAName} @ ${(prA.yes*100).toFixed(1)}¢ | Buy NO on ${pBName} @ ${(prB.no*100).toFixed(1)}¢\nWager: $${wager.toLocaleString()} | Net PnL: $${td.netPnl.toFixed(2)} | APR: ${dynAPR(o).toFixed(1)}% | Expiry: ${o.expiry}`;navigator.clipboard.writeText(txt).then(()=>{showToast("Copied!","");});}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> COPY SETUP</button>
                      </div>
                    </div>
                  </td></tr>
                  )}
                  </React.Fragment>
                );})}
              </tbody>
            </table>
          </div>
          {filtered.length===0&&<div style={{textAlign:"center",padding:"72px 24px",color:T.textTertiary,animation:"revealFade 0.3s ease-out"}}><div style={{marginBottom:20}}><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{opacity:0.4,margin:"0 auto"}}>{catFilter==="Saved"?<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>:<><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></>}</svg></div><div style={{fontSize:16,fontWeight:500,color:T.textSecondary,marginBottom:8,fontFamily:T.display}}>{catFilter==="Saved"&&savedMarkets.size===0?"No saved markets yet":"No signals match your filters"}</div><div style={{fontSize:12,color:T.textTertiary,fontFamily:T.body,marginBottom:24,maxWidth:340,margin:"0 auto 24px",lineHeight:1.6}}>{catFilter==="Saved"&&savedMarkets.size===0?<span style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
              <span style={{fontSize:22}}>⭐</span>
              <span>Click ★ on any row to bookmark it</span>
              <svg width="20" height="40" viewBox="0 0 20 40" fill="none" stroke={T.textTertiary} strokeWidth="1.2" style={{opacity:0.4,animation:"pulse 2s ease-in-out infinite"}}><path d="M10 0v30M4 24l6 8 6-8"/></svg>
            </span>:"Try widening your filter range or clearing the category selection."}</div>
            {profitableOnly&&hiddenUnprofitable>0&&preFiltered.length===hiddenUnprofitable&&<div style={{fontSize:11,color:T.textSecondary,fontFamily:T.mono,marginBottom:12}}>{profitableInOtherCats} profitable markets exist in other categories <button onClick={()=>setCatFilter("All")} style={{background:"none",border:"none",cursor:"pointer",color:T.positive,fontFamily:T.mono,fontSize:11,fontWeight:600,textDecoration:"underline",padding:0}}>Show All Categories</button></div>}
            {search&&<div style={{fontSize:11,color:T.textSecondary,fontFamily:T.mono,marginBottom:12}}>No results for "{search}" — <button onClick={()=>setSearch("")} style={{background:"none",border:"none",cursor:"pointer",color:T.positive,fontFamily:T.mono,fontSize:11,fontWeight:600,textDecoration:"underline",padding:0}}>Clear search</button></div>}
            <button onClick={resetAll} style={{padding:"10px 24px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:600,fontSize:11,letterSpacing:1,background:"rgba(255,255,255,0.03)",backdropFilter:T.blur,color:T.text,boxShadow:T.glassShadow,transition:"all .2s"}} onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.boxShadow=T.cardGlow;}} onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.03)";e.currentTarget.style.boxShadow=T.glassShadow;}}>Reset All Filters</button></div>}
        </Card>

        {/* ─── MOBILE CARD VIEW ─── */}
        <div className="pl-mobile-cards">
          {/* Mobile platform pair selector chips */}
          <div style={{display:"flex",gap:6,overflowX:"auto",WebkitOverflowScrolling:"touch",paddingBottom:10,marginBottom:6,scrollbarWidth:"none",msOverflowStyle:"none"}}>
            {PLATFORM_KEYS.flatMap((a,i)=>PLATFORM_KEYS.slice(i+1).map(b=>({a,b}))).map(({a,b})=>{
              const active=((mktA===a&&mktB===b)||(mktA===b&&mktB===a));
              const plA=PLATFORMS[a],plB=PLATFORMS[b];
              return(
                <button key={a+b} onClick={()=>{setMktA(a);setMktB(b);}}
                  style={{flexShrink:0,display:"inline-flex",alignItems:"center",gap:4,padding:"6px 12px",borderRadius:100,border:"none",cursor:"pointer",
                    background:active?"#ffffff":"rgba(255,255,255,0.025)",
                    color:active?"#060606":T.textSecondary,
                    fontFamily:T.mono,fontSize:9,fontWeight:active?700:600,letterSpacing:0.5,
                    boxShadow:active?"0 2px 12px rgba(255,255,255,0.15), inset 0 1px 0 rgba(255,255,255,0.2)":"inset 0 1px 0 rgba(255,255,255,0.07)",
                    transition:"all .2s",whiteSpace:"nowrap"}}>
                  <span style={{color:active?"#060606":plA.color}}>{plA.icon}</span>{plA.short}<span style={{opacity:0.5}}>↔</span>{plB.short}<span style={{color:active?"#060606":plB.color}}>{plB.icon}</span>
                </button>
              );
            })}
          </div>
          {filtered.map((o,idx)=>{
            const isExp=resolvedExpanded===o.id;
            const td=isExp?tradeDetail(o,wager):null;
            const sv=o.spread*100;
            const sc=sv>=4?T.positive:sv>=2?T.warning:T.negative;
            const sbg=sv>=4?"rgba(52,199,89,0.10)":sv>=2?"rgba(212,168,67,0.08)":"rgba(224,85,85,0.08)";
            const activeTab=rowTabs[o.id]||"TRADE";
            const setTab=(t)=>{setRowTabs(prev=>({...prev,[o.id]:t}));};
            const polyIsYes=getPriceA(o).yes<getPriceB(o).yes;
            const yesColor=polyIsYes?pAColor:pBColor;
            const noColor=polyIsYes?pBColor:pAColor;
            const yesPlatform=polyIsYes?pAName:pBName;
            const noPlatform=polyIsYes?pBName:pAName;
            const _mobDaysLeft=Math.max(0,Math.ceil((new Date(o.expiry)-new Date())/86400000));const _mobRiskLevel=o.liquidity<40||_mobDaysLeft>600?"HIGH":o.liquidity<70||_mobDaysLeft>365?"MEDIUM":"LOW";const _mobRiskColor=_mobRiskLevel==="LOW"?T.positive:_mobRiskLevel==="MEDIUM"?T.warning:T.negative;const _mobRiskBg=_mobRiskLevel==="LOW"?"rgba(52,199,89,0.08)":_mobRiskLevel==="MEDIUM"?"rgba(212,168,67,0.06)":"rgba(224,85,85,0.06)";
            return(
            <div key={o.id} className="pl-mobile-card-item" style={{marginBottom:8,animationDelay:`${idx*0.04}s`}}>
              <div onClick={()=>{setSel(o);setExpanded(isExp?null:o.id);}}
                style={{background:isExp?"rgba(255,255,255,0.03)":"rgba(255,255,255,0.012)",backdropFilter:T.blur,borderRadius:14,padding:"14px 16px",cursor:"pointer",transition:"all .2s",border:"none",boxShadow:isExp?"inset 3px 0 0 "+T.auroraText+", "+T.cardShadow:T.glassShadow,...(flashRows[o.id]==="green"?{animation:"rowFlashGreen 600ms ease-out"}:flashRows[o.id]==="red"?{animation:"rowFlashRed 600ms ease-out"}:{})}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,flexWrap:"wrap"}}>
                      <span style={{fontSize:9,fontFamily:T.mono,padding:"2px 8px",borderRadius:6,background:"rgba(255,255,255,0.02)",color:T.textTertiary,letterSpacing:1,fontWeight:600}}>{o.category}</span>
                      {o.status==="hot"&&<span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 6px",borderRadius:6,background:"rgba(255,255,255,0.022)",animation:"hotPulse 2s ease-in-out infinite",fontSize:8,fontWeight:700,letterSpacing:1,fontFamily:T.mono,color:"#ffffff"}}><IF/> HOT</span>}
                    </div>
                    <div style={{fontSize:14,fontWeight:600,color:T.text,marginBottom:3,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>
                      <span aria-label={pAName} style={{fontSize:9,color:pAColor,marginRight:3}}>{pAIcon}</span>{getNameA(o)}
                    </div>
                    <div style={{fontSize:13,fontWeight:500,color:T.textSecondary,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:1,WebkitBoxOrient:"vertical"}}>
                      <span aria-label={pBName} style={{fontSize:9,color:pBColor,marginRight:3}}>{pBIcon}</span>{getNameB(o)}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
                    <div style={{fontFamily:T.display,fontWeight:600,fontSize:20,letterSpacing:"-0.5px",...(o.apr>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:o.apr>0?{color:T.positive}:{color:T.negativeRaw})}}>{o.apr>0?"+":""}{o.apr.toFixed(1)}%</div>
                    <div style={{fontSize:8,fontFamily:T.mono,color:T.textTertiary,letterSpacing:1,marginTop:2}}>APR</div>
                  </div>
                </div>
                {/* Two-row price comparison */}
                <div style={{marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.012)"}}>
                    <span style={{fontSize:10,color:pAColor,fontWeight:700,fontFamily:T.mono,width:14}}>{pAIcon}</span>
                    <span style={{fontSize:9,fontFamily:T.mono,color:pAColor,fontWeight:600,letterSpacing:1,width:36}}>{pAShort.toUpperCase()}</span>
                    <span style={{fontSize:18,fontWeight:700,fontFamily:T.mono,color:pAColor}}>{(getPriceA(o).yes*100).toFixed(1)}<span style={{fontSize:11,fontWeight:500}}>¢</span></span>
                    {priceDir[o.id]?.poly==="up"?<span style={{fontSize:11,color:T.positive,animation:"arrowFade 0.3s ease-out"}}>▲</span>:priceDir[o.id]?.poly==="down"?<span style={{fontSize:11,color:T.negative,animation:"arrowFade 0.3s ease-out"}}>▼</span>:null}
                    <span style={{marginLeft:"auto",fontSize:9,fontFamily:T.mono,color:T.textSecondary}}>YES</span>
                  </div>
                  <div style={{height:1,background:"rgba(255,255,255,0.06)",margin:"0 10px"}}/>
                  <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:10,background:"rgba(255,255,255,0.008)"}}>
                    <span style={{fontSize:10,color:pBColor,fontWeight:700,fontFamily:T.mono,width:14}}>{pBIcon}</span>
                    <span style={{fontSize:9,fontFamily:T.mono,color:pBColor,fontWeight:600,letterSpacing:1,width:36}}>{pBShort.toUpperCase()}</span>
                    <span style={{fontSize:18,fontWeight:700,fontFamily:T.mono,color:pBColor}}>{(getPriceB(o).yes*100).toFixed(1)}<span style={{fontSize:11,fontWeight:500}}>¢</span></span>
                    {priceDir[o.id]?.opin==="up"?<span style={{fontSize:11,color:T.positive,animation:"arrowFade 0.3s ease-out"}}>▲</span>:priceDir[o.id]?.opin==="down"?<span style={{fontSize:11,color:T.negative,animation:"arrowFade 0.3s ease-out"}}>▼</span>:null}
                    <span style={{marginLeft:"auto",fontSize:9,fontFamily:T.mono,color:T.textSecondary}}>YES</span>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"space-between"}}>
                  <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{padding:"3px 8px",borderRadius:8,fontFamily:T.mono,fontWeight:600,fontSize:10,background:sbg,border:"1px solid "+sc+"33",color:sc}}>{sv.toFixed(1)}%</span>
                    <span style={{fontSize:9,fontFamily:T.mono,color:T.textTertiary}}>Exp {new Date(o.expiry).toLocaleDateString("en-GB",{month:"short",year:"numeric"})}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span role="button" tabIndex={0} aria-label={savedMarkets.has(o.id)?"Remove from saved":"Save market"} onClick={e=>{e.stopPropagation();toggleSaved(o.id,e);}} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();toggleSaved(o.id,e);}}} style={{cursor:"pointer",display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:24,borderRadius:6,outline:"none",opacity:savedMarkets.has(o.id)?1:0.18,transition:"opacity .2s"}}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill={savedMarkets.has(o.id)?T.auroraText:T.textTertiary} stroke={savedMarkets.has(o.id)?T.auroraText:T.textTertiary} strokeWidth="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </span>
                    <IChevron expanded={isExp}/>
                  </div>
                </div>
              </div>
              {/* Mobile expanded detail */}
              {isExp&&td&&(
              <div style={{background:T.auroraSoft,borderRadius:"0 0 16px 16px",padding:"16px",marginTop:-4}}>
                {/* Tab bar */}
                <div style={{display:"flex",gap:0,marginBottom:14,borderRadius:12,overflow:"hidden",background:"rgba(255,255,255,0.012)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.06)"}}>
                  {["TRADE","ORDER BOOK"].map(tab=>(
                    <button key={tab} onClick={e=>{e.stopPropagation();setTab(tab);}}
                      style={{flex:1,padding:"12px 10px",border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:9,fontWeight:700,letterSpacing:1.5,
                        background:activeTab===tab?"rgba(255,255,255,0.04)":"transparent",
                        color:activeTab===tab?T.text:T.textTertiary,
                        boxShadow:activeTab===tab?"inset 0 -2px 0 rgba(255,255,255,0.3)":"none",
                        transition:"all .2s",minHeight:44}}>
                      {tab==="TRADE"?"📊 ":tab==="ORDER BOOK"?"📈 ":""}{tab}
                    </button>
                  ))}
                </div>

                {/* Mobile tab content — CSS Grid stacking for consistent height */}
                <div style={{display:"grid",gridTemplateColumns:"1fr",gridTemplateRows:"1fr"}}>

                {/* TRADE TAB */}
                <div style={{gridArea:"1/1",opacity:activeTab==="TRADE"?1:0,transition:"opacity 0.22s ease",pointerEvents:activeTab==="TRADE"?"auto":"none",willChange:"opacity"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12,padding:"6px 10px",borderRadius:10,background:"rgba(255,255,255,0.015)",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.07)"}}>
                  <span style={{fontSize:9,color:T.textSecondary,fontFamily:T.body,lineHeight:1.4}}>
                    <span style={{fontWeight:600,color:T.text}}>Strategy:</span> Buy <span style={{color:yesColor,fontWeight:600}}>YES</span> on <span style={{color:yesColor,fontWeight:600}}>{yesPlatform}</span>, <span style={{color:noColor,fontWeight:600}}>NO</span> on <span style={{color:noColor,fontWeight:600}}>{noPlatform}</span>.
                  </span>
                </div>
                <div className="pl-wager-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:8,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary}}>WAGER</span>
                    <div style={{display:"flex",alignItems:"center",position:"relative"}}>
                      <span style={{position:"absolute",left:10,fontSize:12,fontWeight:600,fontFamily:T.mono,color:T.textTertiary,pointerEvents:"none",zIndex:1}}>$</span>
                      <input type="number" min={10} value={wager} onChange={e=>{const v=Math.max(10,Number(e.target.value));setWager(v);}}
                        style={{width:100,padding:"6px 10px 6px 22px",borderRadius:10,border:wager>(o.bookDepth*0.8)?"1px solid #ff4444":"none",background:"rgba(255,255,255,0.018)",backdropFilter:"blur(100px) saturate(1.30)",fontFamily:T.mono,fontSize:12,fontWeight:600,color:T.text,outline:"none"}} onClick={e=>e.stopPropagation()}/>
                    </div>
                    {[100,500,1000,5000,10000].map(amt=>(
                      <button key={amt} onClick={e=>{e.stopPropagation();setWager(amt);}}
                        style={{padding:"4px 8px",borderRadius:6,border:"none",cursor:"pointer",fontFamily:T.mono,fontSize:9,fontWeight:600,background:wager===amt?"rgba(255,255,255,0.05)":"rgba(255,255,255,0.015)",color:wager===amt?T.text:T.textTertiary,transition:"all .2s"}}
                      >{amt>=1000?"$"+(amt/1000)+"K":"$"+amt}</button>
                    ))}
                  </div>
                </div>
                <div className="pl-metric-bar" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0,borderRadius:12,overflow:"hidden",marginBottom:12,boxShadow:"0 4px 24px rgba(0,0,0,0.3)"}}>
                  <div style={{background:"rgba(255,255,255,0.025)",padding:"10px 12px",textAlign:"center"}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:3}}>NET PNL</div>
                    <div style={{fontSize:16,fontWeight:600,fontFamily:T.mono,color:td.netPnl>0?T.positive:T.negative}}>${td.netPnl.toFixed(2)}</div>
                  </div>
                  <div style={{background:"rgba(255,255,255,0.018)",padding:"10px 12px",textAlign:"center"}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:3}}>LIVE APR</div>
                    <div style={{fontSize:16,fontWeight:600,fontFamily:T.mono,...(td.annualizedAPR>15?{background:T.aurora,backgroundSize:"300% 300%",animation:"aShift 4s ease infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}:td.annualizedAPR>0?{color:T.positive}:{color:T.negative})}}>{td.annualizedAPR.toFixed(1)}%</div>
                  </div>
                  <div style={{background:"rgba(255,255,255,0.014)",padding:"10px 12px",textAlign:"center"}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:2,fontFamily:T.mono,color:T.textTertiary,marginBottom:3}}>COST</div>
                    <div style={{fontSize:16,fontWeight:600,fontFamily:T.mono,color:T.text}}>${td.costBasis.toFixed(2)}</div>
                  </div>
                </div>
                <div className="pl-expanded-sides" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  <div style={{background:"rgba(255,255,255,0.012)",borderRadius:12,overflow:"hidden"}}>
                    <div style={{padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:9,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:pAColor}}><span aria-label={pAName}>{pAIcon}</span> {pAShort.toUpperCase()}</span>
                      <span style={{fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:16,background:`${polyIsYes?T.positive:T.negativeRaw}22`,color:polyIsYes?T.positive:T.negativeRaw,boxShadow:`0 0 0 1px ${polyIsYes?T.positive:T.negativeRaw}44`,fontFamily:T.mono,letterSpacing:0.8,display:"inline-flex",alignItems:"center",gap:3}}>{polyIsYes?"↑ BUY YES":"↓ BUY NO"}</span>
                    </div>
                    <div style={{padding:"6px 12px 10px"}}>
                      {[["PRICE",`$${td.polyPrice.toFixed(3)}`],["SHARES",td.shares.toLocaleString()],["COST",`$${td.polyTotal.toFixed(2)}`]].map(([l,v],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}>
                          <span style={{fontSize:11,fontFamily:T.mono,color:T.textSecondary}}>{l}</span>
                          <span style={{fontSize:10,fontFamily:T.mono,fontWeight:600,color:T.text}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{background:"rgba(255,255,255,0.012)",borderRadius:12,overflow:"hidden"}}>
                    <div style={{padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:9,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:pBColor}}><span aria-label={pBName}>{pBIcon}</span> {pBShort.toUpperCase()}</span>
                      <span style={{fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:16,background:`${polyIsYes?T.negativeRaw:T.positive}22`,color:polyIsYes?T.negativeRaw:T.positive,boxShadow:`0 0 0 1px ${polyIsYes?T.negativeRaw:T.positive}44`,fontFamily:T.mono,letterSpacing:0.8,display:"inline-flex",alignItems:"center",gap:3}}>{polyIsYes?"↓ BUY NO":"↑ BUY YES"}</span>
                    </div>
                    <div style={{padding:"6px 12px 10px"}}>
                      {[["PRICE",`$${td.opinPrice.toFixed(3)}`],["SHARES",td.shares.toLocaleString()],["COST",`$${td.opinTotal.toFixed(2)}`]].map(([l,v],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}>
                          <span style={{fontSize:11,fontFamily:T.mono,color:T.textSecondary}}>{l}</span>
                          <span style={{fontSize:10,fontFamily:T.mono,fontWeight:600,color:T.text}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Guaranteed Net PnL — mobile */}
                <div style={{marginTop:10}}>
                  <div style={{padding:"12px 14px",borderRadius:12,background:"rgba(255,255,255,0.02)",backdropFilter:"blur(110px) saturate(1.35)",boxShadow:"0 4px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.09)"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
                      <span style={{fontSize:8,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>GUARANTEED NET PNL<span style={{fontWeight:400,opacity:0.7}}>*</span></span>
                      <span style={{fontSize:9,fontWeight:500,color:T.textSecondary,fontFamily:T.mono}}>regardless of outcome</span>
                    </div>
                    <div style={{fontSize:22,fontWeight:600,fontFamily:T.mono,color:td.netPnl>0?T.positive:T.negative,textAlign:"center"}}>${td.netPnl.toFixed(2)}</div>
                  </div>
                  <div style={{marginTop:4,paddingLeft:2,fontSize:9,fontFamily:T.mono,color:T.textTertiary,letterSpacing:0.3}}>* Assumes simultaneous execution at quoted prices. Slippage and execution risk may affect realized profit.</div>
                </div>
                {/* Risk Level inline */}
                <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,padding:"8px 12px",borderRadius:10,background:_mobRiskBg}}>
                  <span style={{fontSize:7,fontWeight:700,letterSpacing:1.5,fontFamily:T.mono,color:T.textTertiary}}>RISK</span>
                  <span style={{fontSize:10,fontWeight:700,letterSpacing:1,fontFamily:T.mono,color:_mobRiskColor,padding:"2px 8px",borderRadius:6,background:"rgba(255,255,255,0.03)",border:"1px solid "+_mobRiskColor+"33"}}>{_mobRiskLevel}</span>
                  <span style={{fontSize:9,fontFamily:T.body,color:T.textSecondary,marginLeft:"auto"}}>{_mobRiskLevel==="LOW"?"Good liquidity":_mobRiskLevel==="MEDIUM"?"Monitor closely":"High caution"}</span>
                </div>
                {/* Copy Trade Steps — mobile */}
                <CopyTradeStepsBtn market={o} td={td} pAName={pAName} pBName={pBName} pAIcon={pAIcon} pBIcon={pBIcon} polyIsYes={polyIsYes} wager={wager} dynAPR={dynAPR} showToast={showToast}/>
                </div>

                {/* ORDER BOOK TAB */}
                <div style={{gridArea:"1/1",opacity:activeTab==="ORDER BOOK"?1:0,transition:"opacity 0.22s ease",pointerEvents:activeTab==="ORDER BOOK"?"auto":"none",willChange:"opacity"}}>
                  <div style={{background:"rgba(255,255,255,0.012)",borderRadius:12,overflow:"visible",padding:"12px"}}>
                    <OrderBookChart market={o} compact dualPlatform/>
                  </div>
                </div>

                </div>
                {/* End of mobile tab grid container */}

                {/* Action buttons — always visible */}
                <div className="pl-expanded-actions" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:12}}>
                  <button style={{padding:"14px 10px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:10,letterSpacing:1.2,background:"rgba(255,255,255,0.025)",backdropFilter:"blur(60px) saturate(1.3)",color:pAColor,display:"flex",alignItems:"center",justifyContent:"center",gap:6,minHeight:48,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)",transition:"all .2s"}} onClick={e=>{e.stopPropagation();showToast(`${pAIcon} ${pAName} — Opens in production mode`,pA.key+".com/market/"+o.id);}}>{pAIcon} {pAShort.toUpperCase()} <IA/></button>
                  <button style={{padding:"14px 10px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:700,fontSize:10,letterSpacing:1.2,background:"rgba(255,255,255,0.025)",backdropFilter:"blur(60px) saturate(1.3)",color:pBColor,display:"flex",alignItems:"center",justifyContent:"center",gap:6,minHeight:48,boxShadow:"inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 16px rgba(0,0,0,0.25)",transition:"all .2s"}} onClick={e=>{e.stopPropagation();showToast(`${pBIcon} ${pBName} — Opens in production mode`,pB.key+".io/market/"+o.id);}}>{pBIcon} {pBShort.toUpperCase()} <IA/></button>
                </div>
              </div>
              )}
            </div>
            );})}
          {filtered.length===0&&<div style={{textAlign:"center",padding:"56px 20px",color:T.textTertiary}}><div style={{marginBottom:16}}><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{opacity:0.4,margin:"0 auto"}}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></div><div style={{fontSize:14,fontWeight:500,color:T.textSecondary,marginBottom:6,fontFamily:T.display}}>No signals match your filters</div><div style={{fontSize:11,color:T.textTertiary,fontFamily:T.body,marginBottom:20,lineHeight:1.6}}>Try widening your filter range or clearing the category selection.</div><button onClick={resetAll} style={{padding:"10px 22px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:T.mono,fontWeight:600,fontSize:10,letterSpacing:1,background:"rgba(255,255,255,0.03)",backdropFilter:T.blur,color:T.text,boxShadow:T.glassShadow}}>Reset All Filters</button></div>}
        </div>


        <div style={{marginTop:28,padding:"16px 0",borderTop:"none",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",gap:24}}>
            <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,letterSpacing:1.5}}>Fees: estimated</span>
          </div>
          <span style={{fontSize:9,color:T.textTertiary,fontFamily:T.mono,letterSpacing:1.5}}>prophetLabs v0.1 {'\u2014'} mock</span>
        </div>
      </div>
      {/* ─── KEYBOARD SHORTCUTS MODAL ─── */}
      {showShortcuts&&<div onClick={()=>setShowShortcuts(false)} style={{position:"fixed",inset:0,zIndex:9997,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(0,0,0,0.5)",backdropFilter:"blur(100px) saturate(1.30)",animation:"fadeUp 0.2s ease-out"}}>
        <div onClick={e=>e.stopPropagation()} className="pl-shortcuts-modal" style={{background:"rgba(16,16,16,0.92)",backdropFilter:"blur(120px) saturate(1.4)",borderRadius:20,padding:"28px 32px",maxWidth:380,width:"90%",boxShadow:"0 24px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.12), 0 0 0 0.5px rgba(255,255,255,0.08)",border:"none",animation:"revealFade 0.2s ease-out"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
            <div style={{fontSize:15,fontWeight:600,color:T.text,fontFamily:T.display,letterSpacing:"-0.3px"}}>Keyboard Shortcuts</div>
            <button onClick={()=>setShowShortcuts(false)} style={{background:"rgba(255,255,255,0.04)",border:"none",cursor:"pointer",color:T.textTertiary,fontSize:14,fontWeight:300,width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:8,transition:"all .2s"}}
              onMouseOver={e=>{e.currentTarget.style.color=T.text;e.currentTarget.style.background="rgba(255,255,255,0.08)";}}
              onMouseOut={e=>{e.currentTarget.style.color=T.textTertiary;e.currentTarget.style.background="rgba(255,255,255,0.04)";}}>✕</button>
          </div>
          {[
            ["/","Focus search"],
            ["F","Toggle filters"],
            ["A","Toggle alerts"],
            ["E","Toggle visual effects"],
            ["↑ ↓","Navigate rows when table is focused"],
            ["Enter","Expand/collapse selected row"],
            ["Esc","Close expanded row / dismiss modal"],
            ["?","Show this help"],
          ].map(([key,desc],i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0",borderBottom:i<7?"1px solid rgba(255,255,255,0.04)":"none"}}>
              <kbd style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:32,padding:"3px 8px",borderRadius:6,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.10)",fontSize:11,fontWeight:600,fontFamily:T.mono,color:T.text,letterSpacing:0.5,boxShadow:"0 2px 4px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.08)"}}>{key}</kbd>
              <span style={{fontSize:12,color:T.textSecondary,fontFamily:T.body}}>{desc}</span>
            </div>
          ))}
        </div>
      </div>}
      {/* Keyboard shortcut hint button */}
      <button onClick={()=>setShowShortcuts(true)} className="pl-kbd-hint" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" style={{position:"fixed",bottom:20,right:20,zIndex:40,width:32,height:32,borderRadius:10,border:"none",cursor:"pointer",background:"rgba(255,255,255,0.03)",backdropFilter:"blur(100px) saturate(1.30)",color:T.textTertiary,fontSize:13,fontWeight:600,fontFamily:T.mono,display:"flex",alignItems:"center",justifyContent:"center",transition:"all .2s",boxShadow:"inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 12px rgba(0,0,0,0.3)"}}
        onMouseOver={e=>{e.currentTarget.style.background="rgba(255,255,255,0.06)";e.currentTarget.style.color=T.text;}}
        onMouseOut={e=>{e.currentTarget.style.background="rgba(255,255,255,0.03)";e.currentTarget.style.color=T.textTertiary;}}>?</button>
      {/* ─── TOAST ─── */}
      {toast&&(
        <div aria-live="polite" role="status" style={{position:"fixed",bottom:28,left:"50%",transform:"translateX(-50%)",zIndex:9999,animation:"toastIn 0.25s ease",pointerEvents:"none"}}>
          <div style={{background:"rgba(15,15,15,0.92)",backdropFilter:"blur(100px) saturate(1.30)",borderRadius:100,padding:"10px 20px",boxShadow:"0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.12)",display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
            <span style={{fontFamily:T.mono,fontSize:11,fontWeight:600,color:T.text,letterSpacing:0.5,whiteSpace:"nowrap"}}>{toast.msg} <span style={{color:T.textTertiary,fontWeight:400,fontSize:10}}>(demo mode)</span></span>
            <span style={{fontFamily:T.mono,fontSize:9,color:T.textTertiary,letterSpacing:0.3,whiteSpace:"nowrap",textDecoration:"line-through",opacity:0.6}}>{toast.url}</span>
          </div>
        </div>
      )}
      <Footer maxWidth={1400} onLegalOpen={onLegalOpen}/>
    </div>
  );
};


// ─── SKELETON LOADING STATE ────────────────────────────────
const SkeletonBar=({width="100%",height=12,style={}})=>(
  <div style={{width,height,borderRadius:6,background:"linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 75%)",backgroundSize:"200% 100%",animation:"shimmer 1.5s ease-in-out infinite",...style}}/>
);
const SkeletonDash=()=>(
  <div style={{background:"transparent",minHeight:"100vh",position:"relative",zIndex:10}}>
    <nav style={{background:"rgba(255,255,255,0.012)",backdropFilter:T.blur,borderBottom:"none",boxShadow:"0 8px 40px rgba(0,0,0,0.4), inset 0 -1px 0 rgba(255,255,255,0.04)",position:"sticky",top:0,zIndex:50}}>
      <div style={{maxWidth:1400,margin:"0 auto",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <Logo/>
          <div style={{width:1,height:18,background:T.border}}/>
          <span style={{fontSize:10,fontWeight:600,color:T.textTertiary,fontFamily:T.mono,letterSpacing:2}}>SCANNER</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <div style={{display:"flex",alignItems:"center",gap:7,padding:"5px 16px",borderRadius:100,background:"rgba(255,255,255,0.025)"}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:"rgba(255,255,255,0.3)",animation:"pulse 1.5s ease-in-out infinite"}}/>
            <span style={{fontSize:10,color:"rgba(255,255,255,0.4)",fontWeight:700,letterSpacing:2,fontFamily:T.mono}}>CONNECTING</span>
          </div>
        </div>
      </div>
    </nav>
    <div style={{maxWidth:1400,margin:"0 auto",padding:"28px 24px",position:"relative",zIndex:10}}>
      {/* Skeleton Best Signal Card */}
      <Card hover={false} style={{padding:"24px 28px",marginBottom:20}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16}}>
          <div style={{flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <SkeletonBar width={60} height={20} style={{borderRadius:8}}/>
              <SkeletonBar width={90} height={14}/>
            </div>
            <SkeletonBar width="70%" height={16} style={{marginBottom:8}}/>
            <SkeletonBar width="55%" height={12} style={{marginBottom:6}}/>
            <SkeletonBar width="50%" height={12}/>
          </div>
          <div style={{textAlign:"right"}}>
            <SkeletonBar width={80} height={36} style={{marginBottom:8,borderRadius:10}}/>
            <SkeletonBar width={60} height={10}/>
          </div>
        </div>
      </Card>
      {/* Skeleton table rows */}
      <Card hover={false} style={{overflow:"hidden",borderRadius:18,padding:0}}>
        <div style={{padding:"14px 24px",background:T.cardSolid}}>
          <div style={{display:"flex",gap:32}}>
            {[120,70,70,50,40,50,60,50].map((w,i)=><SkeletonBar key={i} width={w} height={10}/>)}
          </div>
        </div>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{padding:"18px 24px",borderBottom:"1px solid rgba(255,255,255,0.02)",display:"flex",alignItems:"center",gap:32,animationDelay:`${i*0.08}s`,animation:"revealFade 0.4s ease-out both",animationDelay:`${i*0.1+0.2}s`}}>
            <div style={{flex:1,minWidth:200}}>
              <SkeletonBar width={Math.random()*80+120} height={14} style={{marginBottom:6}}/>
              <SkeletonBar width={Math.random()*60+100} height={12}/>
            </div>
            <SkeletonBar width={56} height={38} style={{borderRadius:10}}/>
            <SkeletonBar width={56} height={38} style={{borderRadius:10}}/>
            <SkeletonBar width={44} height={22} style={{borderRadius:10}}/>
            <SkeletonBar width={30} height={12}/>
            <SkeletonBar width={50} height={16}/>
            <SkeletonBar width={40} height={12}/>
          </div>
        ))}
      </Card>
      <div style={{textAlign:"center",marginTop:20}}>
        <span style={{fontSize:10,color:T.textTertiary,fontFamily:T.mono,letterSpacing:1.5,animation:"pulse 1.5s ease-in-out infinite"}}>Connecting to feeds...</span>
      </div>
    </div>
  </div>
);

// ═══════════════════════════════════════════════════════════
// APP with loading screen
// ═══════════════════════════════════════════════════════════
export default function App(){
  const[page,setPage]=useState("landing");
  const[loaded,setLoaded]=useState(false);
  const[transitioning,setTransitioning]=useState(false);
  const[nextPage,setNextPage]=useState(null);
  const[effectsDisabled,setEffectsDisabled]=useState(false);
  const[showSkeleton,setShowSkeleton]=useState(false);
  const[legalModal,setLegalModal]=useState(null);
  // Load effects preference from persistent storage
  useEffect(()=>{
    (async()=>{
      try{
        const result=await window.storage.get('pl_effects_disabled');
        if(result&&result.value==='true')setEffectsDisabled(true);
      }catch(e){}
    })();
  },[]);
  const toggleEffects=useCallback(()=>{
    setEffectsDisabled(prev=>{const next=!prev;window.storage.set('pl_effects_disabled',String(next)).catch(()=>{});return next;});
  },[]);
  const handleNavigate=useCallback((target)=>{
    if(target===page)return;
    setTransitioning(true);
    setNextPage(target);
    if(target==="dashboard"){
      setShowSkeleton(true);
      setTimeout(()=>{
        setPage(target);
        setTransitioning(false);
        setNextPage(null);
        setTimeout(()=>setShowSkeleton(false),800);
      },200);
    }else{
      setTimeout(()=>{
        setPage(target);
        setTransitioning(false);
        setNextPage(null);
      },200);
    }
  },[page]);
  const openLegal=useCallback((type)=>setLegalModal(type),[]);
  const closeLegal=useCallback(()=>setLegalModal(null),[]);
  return(
    <div style={{background:T.bg,minHeight:"100vh",position:"relative"}}>
      <GlobalStyles/>
      {!loaded&&<LoadingScreen onDone={()=>setLoaded(true)}/>}
      {!effectsDisabled&&<DepthField/>}
      <Watermark disabled={effectsDisabled}/>
      <Aurora disabled={effectsDisabled}/>
      <AuroraCurtain disabled={effectsDisabled}/>
      {loaded&&(
        <div style={{
          opacity:transitioning?0:1,
          transform:transitioning?"translateY(-8px)":"translateY(0)",
          transition:"opacity 0.2s ease, transform 0.2s ease",
        }}>
          {showSkeleton&&page==="dashboard"?<SkeletonDash/>:page==="dashboard"?<Dash onNavigate={handleNavigate} effectsDisabled={effectsDisabled} toggleEffects={toggleEffects} onLegalOpen={openLegal}/>:<Landing onNavigate={handleNavigate} onLegalOpen={openLegal}/>}
        </div>
      )}
      {/* Legal modals rendered at root level — outside all transform/filter containers */}
      {legalModal&&<LegalModal type={legalModal} onClose={closeLegal}/>}
    </div>
  );
}
