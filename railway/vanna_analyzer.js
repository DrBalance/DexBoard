// DexBoard – vanna_analyzer.js
// Runs on Railway: fetch CBOE → filter → Black-Scholes → DEX/GEX/Vanna/Charm → CF KV

import fetch from "node-fetch";

// ─────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────
const CBOE_BASE    = process.env.CBOE_BASE    || "https://cdn.cboe.com/api/global/delayed_quotes/options";
const CF_KV_URL    = process.env.CF_KV_URL;   // e.g. https://drbalance-dex.workers.dev/kv
const CF_KV_SECRET = process.env.CF_KV_SECRET || "";

// ─────────────────────────────────────────────────────────────────
// Black-Scholes helpers
// ─────────────────────────────────────────────────────────────────

/** Standard normal CDF (Hart approximation) */
function normCDF(x) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Standard normal PDF */
function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * calcGreeks – Black-Scholes Vanna & Charm
 * @param {number} spot   - Current underlying price
 * @param {number} strike - Strike price
 * @param {number} dte    - Days to expiration
 * @param {number} iv     - Implied volatility (decimal, e.g. 0.20)
 * @param {number} r      - Risk-free rate (default 5%)
 * @returns {{ delta, gamma, vanna, charm } | null}
 */
export function calcGreeks(spot, strike, dte, iv, r = 0.05) {
  const T = dte / 365;
  if (T <= 0 || iv <= 0 || spot <= 0 || strike <= 0) return null;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;

  const phi  = normPDF(d1);           // φ(d1)
  const Nd1  = normCDF(d1);

  // Delta (call)
  const delta = Nd1;

  // Gamma
  const gamma = phi / (spot * iv * sqrtT);

  // Vanna = dDelta/dVol  (dealer exposure sensitivity to vol change)
  // Formula: -φ(d1) * d2 / iv
  const vanna = -phi * d2 / iv;

  // Charm = dDelta/dTime  (delta decay)
  // Formula: -φ(d1) * [ 2rT - d2*iv*√T ] / (2T*iv*√T)
  const charm = -phi * (2 * r * T - d2 * iv * sqrtT) / (2 * T * iv * sqrtT);

  return { delta, gamma, vanna, charm };
}

// ─────────────────────────────────────────────────────────────────
// Option string parser
// "SPY260424C00713000" → { symbol, expiry, type, strike, dte }
// ─────────────────────────────────────────────────────────────────
export function parseOption(optionStr) {
  const match = optionStr.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, symbol, dateStr, type, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  const expiry = `20${yy}-${mm}-${dd}`;
  const strike = parseInt(strikeStr, 10) / 1000;
  const msPerDay = 86_400_000;
  const now = new Date();
  // Use midnight ET of expiry date for DTE calculation
  const expiryDate = new Date(`${expiry}T16:00:00-05:00`);
  const dte = Math.max(0, Math.round((expiryDate - now) / msPerDay));
  return { symbol, expiry, type, strike, dte };
}

// ─────────────────────────────────────────────────────────────────
// Filter options to ATM ±10%, DTE 0-60, valid IV/Gamma/OI
// ─────────────────────────────────────────────────────────────────
export function filterOptions(options, spot) {
  const lo = spot * 0.90;
  const hi = spot * 1.10;
  return options.filter((o) => {
    const parsed = parseOption(o.option);
    if (!parsed) return false;
    return (
      o.iv > 0 &&
      o.gamma > 0 &&
      o.open_interest > 0 &&
      parsed.strike >= lo &&
      parsed.strike <= hi &&
      parsed.dte >= 0 &&
      parsed.dte <= 60
    );
  });
}

// ─────────────────────────────────────────────────────────────────
// Classify expiry into groups
// ─────────────────────────────────────────────────────────────────
export function classifyExpiry(dte) {
  if (dte === 0) return "0dte";
  if (dte <= 7)  return "weekly";
  if (dte <= 35) return "monthly";
  return "quarterly";
}

// ─────────────────────────────────────────────────────────────────
// Fetch CBOE option chain for SPY
// ─────────────────────────────────────────────────────────────────
async function fetchCBOE() {
  const url = `${CBOE_BASE}/SPY.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "DexBoard/1.0" },
  });
  if (!res.ok) throw new Error(`CBOE fetch failed: ${res.status}`);
  const json = await res.json();
  // CBOE structure: json.data.options[]
  return json;
}

// ─────────────────────────────────────────────────────────────────
// Write to CF KV via Workers internal endpoint
// CF Worker exposes POST /kv-write { key, value }
// ─────────────────────────────────────────────────────────────────
async function kvPut(key, value) {
  if (!CF_KV_URL) {
    console.warn("CF_KV_URL not set – skipping KV write for", key);
    return;
  }
  const res = await fetch(`${CF_KV_URL}/kv-write`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-kv-secret": CF_KV_SECRET,
    },
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KV write failed for ${key}: ${res.status} ${text}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Sum helper
// ─────────────────────────────────────────────────────────────────
function sum(arr, field) {
  return arr.reduce((acc, item) => acc + (item[field] || 0), 0);
}

// ─────────────────────────────────────────────────────────────────
// Main: calculateAndStore
// ─────────────────────────────────────────────────────────────────
export async function calculateAndStore(spot, vix) {
  const raw  = await fetchCBOE();
  const all  = raw?.data?.options ?? [];
  if (all.length === 0) throw new Error("CBOE returned empty options array");

  const filtered = filterOptions(all, spot);
  console.log(`Filtered ${filtered.length} / ${all.length} options`);

  // Group buckets
  const groups = {
    "0dte":     [],
    "weekly":   [],
    "monthly":  [],
    "quarterly":[],
  };

  for (const o of filtered) {
    const parsed = parseOption(o.option);
    if (!parsed) continue;
    const { strike, dte, type } = parsed;
    const group = classifyExpiry(dte);
    const greeks = calcGreeks(spot, strike, dte, o.iv);
    if (!greeks) continue;

    const isCall = type === "C";
    const sign   = isCall ? 1 : -1;

    groups[group].push({
      strike,
      dte,
      type,
      dex:   sign * (o.delta ?? greeks.delta) * o.open_interest * 100,
      gex:   o.gamma * o.open_interest * 100,
      vanna: greeks.vanna * o.open_interest * 100,
      charm: greeks.charm * o.open_interest * 100,
    });
  }

  const updatedAt = new Date().toISOString();
  const results   = {};

  for (const [group, items] of Object.entries(groups)) {
    const summary = {
      dex_total:   sum(items, "dex"),
      gex_total:   sum(items, "gex"),
      vanna_total: sum(items, "vanna"),
      charm_total: sum(items, "charm"),
      spot,
      vix,
      count:       items.length,
      strikes:     items,   // per-strike rows for heatmap
      updated_at:  updatedAt,
    };

    results[group] = {
      dex_total:   summary.dex_total,
      gex_total:   summary.gex_total,
      vanna_total: summary.vanna_total,
      charm_total: summary.charm_total,
      count:       summary.count,
    };

    await kvPut(`dex:spy:${group}`, summary);
    console.log(`[KV] dex:spy:${group} → DEX=${summary.dex_total.toFixed(0)} GEX=${summary.gex_total.toFixed(0)}`);
  }

  // Combined structure key
  const structure = {
    "0dte":      results["0dte"],
    weekly:      results["weekly"],
    monthly:     results["monthly"],
    quarterly:   results["quarterly"],
    updated_at:  updatedAt,
  };
  await kvPut("dex:spy:structure", structure);

  return { ok: true, updated_at: updatedAt, groups: results };
}
