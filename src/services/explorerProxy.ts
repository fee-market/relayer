/**
 * Explorer proxy for the wallet. The wallet used to ship an Etherscan API key in the app bundle (anyone can pull it
 * out and spend the quota); now the wallet asks the relay, which holds the key. Only the two read shapes the wallet
 * needs are forwarded, with bounded sizes, so the relay is not an open Etherscan proxy:
 *
 *   history  module=account, action=txlist|tokentx  (an address, optionally one token)
 *   usage    module=logs, action=getLogs            (this registry's logs for one topic0 and one topic1)
 */
import { config } from "../config.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_IDS = new Set(["1", "10", "56", "137", "8453", "42161"]);
const MAX_PAGE = 20;
const MAX_OFFSET = 1000;

const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function int(v: unknown, def: number, max: number): number | null {
  const s = one(v);
  if (s === undefined) return def;
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

/** Returns the upstream query (without the key), or a string saying why the request is refused. */
export function buildExplorerQuery(q: Record<string, unknown>): URLSearchParams | string {
  const chainid = one(q.chainid) ?? String(config.chainId);
  if (!CHAIN_IDS.has(chainid)) return "chainid not supported";
  const page = int(q.page, 1, MAX_PAGE);
  const offset = int(q.offset, 25, MAX_OFFSET);
  if (page === null || offset === null) return "bad page or offset";

  const module = one(q.module);
  const action = one(q.action);
  const out = new URLSearchParams({ chainid, module: module ?? "", action: action ?? "", page: String(page), offset: String(offset) });

  if (module === "account" && (action === "txlist" || action === "tokentx")) {
    const address = one(q.address);
    if (!address || !ADDRESS.test(address)) return "bad address";
    out.set("address", address);
    out.set("startblock", "0");
    out.set("endblock", "99999999");
    out.set("sort", "desc");
    const token = one(q.contractaddress);
    if (token !== undefined) {
      if (!ADDRESS.test(token)) return "bad contractaddress";
      out.set("contractaddress", token);
    }
    return out;
  }

  if (module === "logs" && action === "getLogs") {
    if (chainid !== String(config.chainId)) return "logs are only served for this relay's chain";
    const address = one(q.address);
    if (!address || address.toLowerCase() !== config.feeMarketRegistry.toLowerCase()) return "logs are only served for the registry";
    const topic0 = one(q.topic0), topic1 = one(q.topic1);
    if (!topic0 || !WORD.test(topic0) || !topic1 || !WORD.test(topic1)) return "bad topic";
    out.set("address", address);
    out.set("fromBlock", "0");
    out.set("toBlock", "latest");
    out.set("topic0", topic0);
    out.set("topic0_1_opr", "and");
    out.set("topic1", topic1);
    return out;
  }
  return "unsupported request";
}

const CACHE_MS = 20_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; body: string }>();

export async function explorerFetch(query: URLSearchParams, fetchImpl: typeof fetch = fetch): Promise<{ status: number; body: string }> {
  if (!config.etherscanApiKey) return { status: 503, body: JSON.stringify({ status: "0", message: "explorer proxy not configured", result: [] }) };
  const k = query.toString();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return { status: 200, body: hit.body };
  const upstream = new URLSearchParams(query);
  upstream.set("apikey", config.etherscanApiKey);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetchImpl(`https://api.etherscan.io/v2/api?${upstream.toString()}`, { signal: ctl.signal });
    const body = await res.text();
    if (!res.ok) return { status: 502, body: JSON.stringify({ status: "0", message: "explorer unavailable", result: [] }) };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(k, { at: Date.now(), body });
    return { status: 200, body };
  } catch {
    return { status: 502, body: JSON.stringify({ status: "0", message: "explorer unavailable", result: [] }) };
  } finally {
    clearTimeout(timer);
  }
}

export function clearExplorerCache() { cache.clear(); }
