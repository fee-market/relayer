import { Registry } from "../lib/metrics.js";

/**
 * Every metric the node exposes at GET /metrics. Plain definitions only (no imports of other services), so that any
 * module can count something without creating an import cycle; the gauges that need a read are filled by collectors
 * registered in index.ts, only when someone scrapes.
 */
export const registry = new Registry();

export const m = {
  relayRequests: registry.counter("feemarket_relay_requests_total", "Sponsored requests by outcome (success, rejected, reverted, error)."),
  gasUsedWei: registry.counter("feemarket_gas_used_wei_total", "Gas paid for sponsored transactions, in wei."),
  http: registry.counter("feemarket_http_requests_total", "HTTP requests by route and status class."),
  httpDuration: registry.histogram("feemarket_http_request_duration_seconds", "HTTP request duration by route."),
  txReplacements: registry.counter("feemarket_tx_replacements_total", "Stuck transactions replaced with a higher fee."),
  txStuck: registry.counter("feemarket_tx_stuck_total", "Times a transaction could not be replaced any more (replacement limit or fee cap)."),
  profitGuard: registry.counter("feemarket_profit_guard_total", "Profit guard decisions (allowed, refused, unpriced)."),
  authFailures: registry.counter("feemarket_auth_failures_total", "Failed dashboard or metrics logins."),
  relayerBalanceWei: registry.gauge("feemarket_relayer_balance_wei", "Native balance of the relayer account, in wei."),
  relayerBalanceMinWei: registry.gauge("feemarket_relayer_balance_min_wei", "Configured minimum relayer balance, in wei (0 = not set)."),
  inflight: registry.gauge("feemarket_inflight_transactions", "Broadcast transactions not yet confirmed."),
  draining: registry.gauge("feemarket_draining", "1 while the node is shutting down."),
  providerUp: registry.gauge("feemarket_rpc_provider_up", "1 when the RPC provider answered, by host."),
  uptime: registry.gauge("feemarket_uptime_seconds", "Seconds since this process started."),
  registryHalted: registry.gauge("feemarket_registry_halted", "1 when the registry is halted by the curator."),
  registrySolvent: registry.gauge("feemarket_registry_solvent", "1 when the registry holds at least what it owes, by token."),
  watcherLastRun: registry.gauge("feemarket_watcher_last_run_timestamp_seconds", "When the on-chain watcher last completed a pass."),
  watcherErrors: registry.counter("feemarket_watcher_errors_total", "Watcher passes that failed."),
  chainEvents: registry.counter("feemarket_chain_events_total", "Watched on-chain events seen, by name."),
  canaryLastSuccess: registry.gauge("feemarket_canary_last_success_timestamp_seconds", "When the end-to-end canary last succeeded."),
  canaryOk: registry.gauge("feemarket_canary_ok", "1 if the last canary run succeeded."),
};

const startedAt = Date.now();
export const uptimeSec = (): number => Math.floor((Date.now() - startedAt) / 1000);
