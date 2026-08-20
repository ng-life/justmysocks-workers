import { parse } from "yaml";

const CLASH_ENDPOINT = "https://jmssub.net/members/getsub.php";
const TRAFFIC_ENDPOINT = "https://justmysocks6.net/members/getbwcounter.php";
const UPSTREAM_TIMEOUT_MS = 20_000;

type WorkerEnv = WorkerEnvBindings & {
  ACCESS_TOKEN?: string;
};

export interface TrafficRaw {
  monthly_bw_limit_b: number;
  bw_counter_b: number;
  bw_reset_day_of_month: number;
}

export interface SubscriptionInfo {
  upload: number;
  download: number;
  used: number;
  remaining: number;
  total: number;
  reset_day: number;
  expires_at?: string;
  expire?: number;
}

type Proxy = Record<string, unknown>;

export interface CacheConfig {
  freshTtlSeconds: number;
  staleTtlSeconds: number;
  failureCooldownSeconds: number;
}

export type CacheStatus = "HIT" | "MISS" | "STALE";

export interface CacheResult<T> {
  value: T;
  status: CacheStatus;
}

interface CacheEnvelope<T> {
  value?: T;
  fetchedAt?: number;
  retryAfter?: number;
  error?: string;
}

export interface CacheStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed\n", { status: 405 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return json({ status: "ok" });
      }
      if (url.pathname === "/") {
        return new Response(
          "justmysocks worker: GET /clash, GET /quanx, GET /loon, GET /api/subscription, GET /healthz\n",
        );
      }
      if (!["/clash", "/quanx", "/loon", "/api/subscription"].includes(url.pathname)) {
        return json({ error: "not found" }, 404);
      }

      authorize(request, url, env);
      validateIdentity(url);
      const cacheConfig = cacheConfigFromEnv(env);
      const cache = caches.default;
      const trafficUrl = buildTrafficUrl(url);

      if (url.pathname === "/api/subscription") {
        const traffic = await cachedTraffic(cache, trafficUrl, url.origin, cacheConfig);
        return json(normalizeTraffic(traffic.value), 200, {
          "x-cache-traffic": traffic.status,
        });
      }

      const [clash, traffic] = await Promise.all([
        cachedClash(cache, buildClashUrl(url), url.origin, cacheConfig),
        cachedTraffic(cache, trafficUrl, url.origin, cacheConfig),
      ]);
      const info = normalizeTraffic(traffic.value);
      if (url.pathname === "/clash") {
        return subscriptionResponse(
          clash.value,
          "application/yaml; charset=utf-8",
          "justmysocks.yaml",
          info,
          clash.status,
          traffic.status,
        );
      }
      if (url.pathname === "/loon") {
        return subscriptionResponse(
          convertClashToLoon(clash.value),
          "text/plain; charset=utf-8",
          "justmysocks-loon.conf",
          info,
          clash.status,
          traffic.status,
        );
      }
      return subscriptionResponse(
        convertClashToQuanx(clash.value),
        "text/plain; charset=utf-8",
        "justmysocks.conf",
        info,
        clash.status,
        traffic.status,
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal error";
      return json({ error: message }, status);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

function authorize(request: Request, url: URL, env: WorkerEnv): void {
  if (!env.ACCESS_TOKEN) return;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (url.searchParams.get("token") !== env.ACCESS_TOKEN && bearer !== env.ACCESS_TOKEN) {
    throw new HttpError(401, "unauthorized");
  }
}

function validateIdentity(url: URL): void {
  if (!url.searchParams.get("service")?.trim() || !url.searchParams.get("id")?.trim()) {
    throw new HttpError(400, "service and id are required");
  }
}

export function buildClashUrl(requestUrl: URL): URL {
  const url = new URL(CLASH_ENDPOINT);
  copyParam(requestUrl, url, "service");
  copyParam(requestUrl, url, "id");
  url.searchParams.set("format", "clash");
  for (const key of ["noss", "novless", "exclude", "usedomains"]) {
    copyParam(requestUrl, url, key);
  }
  return url;
}

export function buildTrafficUrl(requestUrl: URL): URL {
  const url = new URL(TRAFFIC_ENDPOINT);
  copyParam(requestUrl, url, "service");
  copyParam(requestUrl, url, "id");
  return url;
}

function copyParam(from: URL, to: URL, key: string): void {
  const value = from.searchParams.get(key);
  if (value !== null) to.searchParams.set(key, value);
}

export function cacheConfigFromEnv(env: WorkerEnv): CacheConfig {
  const freshTtlSeconds = positiveInteger(env.CACHE_FRESH_TTL_SECONDS, 600, "CACHE_FRESH_TTL_SECONDS");
  const staleTtlSeconds = positiveInteger(env.CACHE_STALE_TTL_SECONDS, 3600, "CACHE_STALE_TTL_SECONDS");
  const failureCooldownSeconds = positiveInteger(
    env.CACHE_FAILURE_COOLDOWN_SECONDS,
    30,
    "CACHE_FAILURE_COOLDOWN_SECONDS",
  );
  if (freshTtlSeconds < 60) {
    throw new HttpError(500, "CACHE_FRESH_TTL_SECONDS must be at least 60");
  }
  if (staleTtlSeconds < freshTtlSeconds) {
    throw new HttpError(
      500,
      "CACHE_STALE_TTL_SECONDS must be greater than or equal to CACHE_FRESH_TTL_SECONDS",
    );
  }
  return { freshTtlSeconds, staleTtlSeconds, failureCooldownSeconds };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(500, `${name} must be a positive integer`);
  }
  return parsed;
}

async function cachedClash(
  cache: CacheStore,
  url: URL,
  cacheOrigin: string,
  config: CacheConfig,
): Promise<CacheResult<string>> {
  return cachedUpstream(cache, "clash", url, cacheOrigin, config, isValidClash, () => fetchClash(url));
}

async function cachedTraffic(
  cache: CacheStore,
  url: URL,
  cacheOrigin: string,
  config: CacheConfig,
): Promise<CacheResult<TrafficRaw>> {
  return cachedUpstream(cache, "traffic", url, cacheOrigin, config, isTrafficRaw, () => fetchTraffic(url));
}

export async function cachedUpstream<T>(
  cache: CacheStore,
  kind: "clash" | "traffic",
  url: URL,
  cacheOrigin: string,
  config: CacheConfig,
  validate: (value: unknown) => value is T,
  fetcher: () => Promise<T>,
  now: () => number = Date.now,
): Promise<CacheResult<T>> {
  const key = await cacheKey(kind, url, cacheOrigin);
  return loadOrRefresh(cache, key, config, validate, fetcher, now);
}

async function loadOrRefresh<T>(
  cache: CacheStore,
  key: string,
  config: CacheConfig,
  validate: (value: unknown) => value is T,
  fetcher: () => Promise<T>,
  now: () => number,
): Promise<CacheResult<T>> {
  const nowSeconds = Math.floor(now() / 1000);
  const envelope = await readEnvelope(cache, key, validate);
  const age =
    envelope?.fetchedAt === undefined ? undefined : Math.max(0, nowSeconds - envelope.fetchedAt);

  if (envelope?.value !== undefined && age !== undefined && age < config.freshTtlSeconds) {
    return { value: envelope.value, status: "HIT" };
  }

  if (envelope?.retryAfter !== undefined && envelope.retryAfter > nowSeconds) {
    if (envelope.value !== undefined && age !== undefined && age <= config.staleTtlSeconds) {
      return { value: envelope.value, status: "STALE" };
    }
    throw new HttpError(502, envelope.error ?? "upstream retry is cooling down");
  }

  try {
    const value = await fetcher();
    if (!validate(value)) throw new HttpError(502, "upstream returned invalid data");
    const completedAt = Math.floor(now() / 1000);
    await writeEnvelope(
      cache,
      key,
      { value, fetchedAt: completedAt },
      config.staleTtlSeconds,
    );
    return { value, status: "MISS" };
  } catch (cause) {
    const error = upstreamError(cause);
    const completedAt = Math.floor(now() / 1000);
    const failureAge =
      envelope?.fetchedAt === undefined ? undefined : Math.max(0, completedAt - envelope.fetchedAt);
    const failed: CacheEnvelope<T> = {
      ...(envelope?.value !== undefined && envelope.fetchedAt !== undefined
        ? { value: envelope.value, fetchedAt: envelope.fetchedAt }
        : {}),
      retryAfter: completedAt + config.failureCooldownSeconds,
      error: error.message,
    };
    const remainingStaleSeconds =
      failureAge === undefined
        ? config.failureCooldownSeconds
        : config.staleTtlSeconds - failureAge;
    await writeEnvelope(
      cache,
      key,
      failed,
      Math.max(config.failureCooldownSeconds, remainingStaleSeconds),
    );
    if (
      failed.value !== undefined &&
      failureAge !== undefined &&
      failureAge <= config.staleTtlSeconds
    ) {
      return { value: failed.value, status: "STALE" };
    }
    throw error;
  }
}

async function cacheKey(kind: "clash" | "traffic", url: URL, cacheOrigin: string): Promise<string> {
  const input = new TextEncoder().encode(`${kind}\0${url.toString()}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new URL(`/__upstream_cache/${kind}/${hash}`, cacheOrigin).toString();
}

async function readEnvelope<T>(
  cache: CacheStore,
  key: string,
  validate: (value: unknown) => value is T,
): Promise<CacheEnvelope<T> | undefined> {
  let response: Response | undefined;
  try {
    response = await cache.match(new Request(key));
  } catch (error) {
    logCacheError("upstream cache read failed", error);
    return undefined;
  }
  if (response === undefined) return undefined;
  try {
    const raw = await response.text();
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    const cachedValue = value.value;
    const fetchedAt = value.fetchedAt;
    const retryAfter = value.retryAfter;
    const error = value.error;
    if (cachedValue !== undefined && !validate(cachedValue)) return undefined;
    if (
      fetchedAt !== undefined &&
      (typeof fetchedAt !== "number" || !Number.isSafeInteger(fetchedAt) || fetchedAt < 0)
    )
      return undefined;
    if (
      retryAfter !== undefined &&
      (typeof retryAfter !== "number" || !Number.isSafeInteger(retryAfter) || retryAfter < 0)
    )
      return undefined;
    if (error !== undefined && typeof error !== "string") return undefined;
    return {
      ...(cachedValue === undefined ? {} : { value: cachedValue }),
      ...(fetchedAt === undefined ? {} : { fetchedAt: fetchedAt as number }),
      ...(retryAfter === undefined ? {} : { retryAfter: retryAfter as number }),
      ...(error === undefined ? {} : { error }),
    };
  } catch {
    return undefined;
  }
}

async function writeEnvelope<T>(
  cache: CacheStore,
  key: string,
  envelope: CacheEnvelope<T>,
  ttlSeconds: number,
): Promise<void> {
  try {
    await cache.put(
      new Request(key),
      new Response(JSON.stringify(envelope), {
        headers: {
          "cache-control": `s-maxage=${Math.max(1, Math.ceil(ttlSeconds))}`,
          "content-type": "application/json; charset=utf-8",
        },
      }),
    );
  } catch (error) {
    logCacheError("upstream cache write failed", error);
  }
}

function logCacheError(message: string, error: unknown): void {
  console.error(
    JSON.stringify({
      message,
      error: error instanceof Error ? error.message : "unknown error",
    }),
  );
}

function upstreamError(cause: unknown): HttpError {
  if (cause instanceof HttpError) return cause;
  return new HttpError(502, cause instanceof Error ? cause.message : "upstream request failed");
}

async function fetchClash(url: URL): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!response.ok) throw new HttpError(502, `upstream returned HTTP ${response.status}`);
  const body = await response.text();
  if (!isValidClash(body)) throw new HttpError(502, "upstream returned invalid Clash YAML");
  return body;
}

async function fetchTraffic(url: URL): Promise<TrafficRaw> {
  const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!response.ok) throw new HttpError(502, `traffic API returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!isTrafficRaw(value)) {
    throw new HttpError(502, "traffic API is missing required numeric fields");
  }
  return value;
}

function isValidClash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const document: unknown = parse(value);
    return isRecord(document) && Array.isArray(document.proxies);
  } catch {
    return false;
  }
}

function isTrafficRaw(value: unknown): value is TrafficRaw {
  if (!isRecord(value)) return false;
  const total = value.monthly_bw_limit_b;
  const used = value.bw_counter_b;
  const resetDay = value.bw_reset_day_of_month;
  return (
    typeof total === "number" &&
    Number.isSafeInteger(total) &&
    total >= 0 &&
    typeof used === "number" &&
    Number.isSafeInteger(used) &&
    used >= 0 &&
    typeof resetDay === "number" &&
    Number.isSafeInteger(resetDay) &&
    resetDay >= 1 &&
    resetDay <= 31
  );
}

export function normalizeTraffic(raw: TrafficRaw, now = new Date()): SubscriptionInfo {
  const expire = nextLosAngelesReset(raw.bw_reset_day_of_month, now);
  return {
    upload: 0,
    download: raw.bw_counter_b,
    used: raw.bw_counter_b,
    remaining: Math.max(0, raw.monthly_bw_limit_b - raw.bw_counter_b),
    total: raw.monthly_bw_limit_b,
    reset_day: raw.bw_reset_day_of_month,
    ...(expire === undefined
      ? {}
      : { expire, expires_at: new Date(expire * 1000).toISOString() }),
  };
}

function nextLosAngelesReset(day: number, now: Date): number | undefined {
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const current = dateParts(now, "America/Los_Angeles");
  for (let offset = 0; offset <= 2; offset++) {
    const monthIndex = current.month - 1 + offset;
    const year = current.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) continue;
    const candidate = zonedMidnightUtc(year, month, day, "America/Los_Angeles");
    if (candidate.getTime() > now.getTime()) return Math.floor(candidate.getTime() / 1000);
  }
  return undefined;
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const parts = dateParts(new Date(guess), timeZone, true);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0);
    guess += target - represented;
  }
  return new Date(guess);
}

function dateParts(date: Date, timeZone: string, includeHour = false) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(includeHour ? { hour: "numeric", hourCycle: "h23" as const } : {}),
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    ...(includeHour ? { hour: number("hour") } : {}),
  };
}

function subscriptionResponse(
  body: string,
  contentType: string,
  filename: string,
  info: SubscriptionInfo,
  clashStatus: CacheStatus,
  trafficStatus: CacheStatus,
): Response {
  const fields = [`upload=${info.upload}`, `download=${info.download}`, `total=${info.total}`];
  if (info.expire !== undefined) fields.push(`expire=${info.expire}`);
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `inline; filename=${filename}`,
      "subscription-userinfo": fields.join("; "),
      "cache-control": "no-store",
      "x-cache-clash": clashStatus,
      "x-cache-traffic": trafficStatus,
    },
  });
}

export function convertClashToQuanx(input: string): string {
  const document: unknown = parse(input);
  if (!isRecord(document) || !Array.isArray(document.proxies)) {
    throw new HttpError(422, "Clash YAML does not contain proxies");
  }
  const lines: string[] = [];
  for (const value of document.proxies) {
    if (!isRecord(value)) continue;
    const line = convertProxy(value);
    if (line) lines.push(line);
  }
  if (lines.length === 0) throw new HttpError(422, "no supported proxy found");
  return `${lines.join("\n")}\n`;
}

export function convertClashToLoon(input: string): string {
  const document: unknown = parse(input);
  if (!isRecord(document) || !Array.isArray(document.proxies)) {
    throw new HttpError(422, "Clash YAML does not contain proxies");
  }
  const lines: string[] = [];
  for (const value of document.proxies) {
    if (!isRecord(value)) continue;
    const line = convertProxyToLoon(value);
    if (line) lines.push(line);
  }
  if (lines.length === 0) throw new HttpError(422, "no Loon-compatible proxy found");
  return `${lines.join("\n")}\n`;
}

function convertProxyToLoon(proxy: Proxy): string | undefined {
  const type = stringField(proxy, "type").toLowerCase();
  const server = stringField(proxy, "server");
  const port = numberOrString(proxy, "port");
  const name = loonName(jmsTag(stringField(proxy, "name")));
  const udp = boolField(proxy, "udp", true);

  if (type === "ss") {
    const options = ["fast-open=false", `udp=${udp}`];
    if (["obfs", "simple-obfs"].includes(optionalString(proxy, "plugin") ?? "")) {
      const mode = nestedString(proxy, "plugin-opts", "mode");
      const host = nestedString(proxy, "plugin-opts", "host");
      if (mode) options.push(`obfs-name=${clean(mode)}`);
      if (host) options.push(`obfs-host=${clean(host)}`);
    }
    return `${name} = Shadowsocks,${server},${port},${stringField(proxy, "cipher")},${loonQuote(stringField(proxy, "password"))},${options.join(",")}`;
  }
  if (type === "vmess") {
    const network = optionalString(proxy, "network") ?? "tcp";
    const tls = boolField(proxy, "tls", false);
    const options = [
      `transport=${clean(network)}`,
      `alterId=${optionalNumberOrString(proxy, "alterId") ?? "0"}`,
      `over-tls=${tls}`,
    ];
    addLoonTransportOptions(proxy, network, options);
    addLoonTlsOptions(proxy, tls, options);
    options.push(`udp=${udp}`);
    return `${name} = vmess,${server},${port},${optionalString(proxy, "cipher") ?? "auto"},${loonQuote(stringField(proxy, "uuid"))},${options.join(",")}`;
  }
  if (type === "vless") {
    const network = optionalString(proxy, "network") ?? "tcp";
    const tls = boolField(proxy, "tls", false);
    const options = [`transport=${clean(network)}`, `over-tls=${tls}`];
    addLoonTransportOptions(proxy, network, options);
    const flow = optionalString(proxy, "flow");
    const publicKey = nestedString(proxy, "reality-opts", "public-key");
    const shortId = nestedString(proxy, "reality-opts", "short-id");
    if (flow) options.push(`flow=${clean(flow)}`);
    if (publicKey) options.push(`public-key=${loonQuote(publicKey)}`);
    if (shortId) options.push(`short-id=${clean(shortId)}`);
    addLoonTlsOptions(proxy, tls, options);
    options.push(`udp=${udp}`);
    return `${name} = VLESS,${server},${port},${loonQuote(stringField(proxy, "uuid"))},${options.join(",")}`;
  }
  if (type === "trojan") {
    const network = optionalString(proxy, "network") ?? "tcp";
    const options = [`transport=${clean(network)}`];
    addLoonTransportOptions(proxy, network, options);
    addLoonTlsOptions(proxy, true, options);
    options.push(`udp=${udp}`);
    return `${name} = trojan,${server},${port},${loonQuote(stringField(proxy, "password"))},${options.join(",")}`;
  }
  if (type === "http") {
    const protocol = boolField(proxy, "tls", false) ? "https" : "http";
    const values = [`${name} = ${protocol}`, server, port];
    const username = optionalString(proxy, "username");
    if (username !== undefined) {
      values.push(loonQuote(username), loonQuote(optionalString(proxy, "password") ?? ""));
    }
    if (protocol === "https") addLoonTlsOptions(proxy, true, values);
    return values.join(",");
  }
  if (type === "socks5") {
    const values = [`${name} = socks5`, server, port];
    const username = optionalString(proxy, "username");
    if (username !== undefined) {
      values.push(loonQuote(username), loonQuote(optionalString(proxy, "password") ?? ""));
    }
    const sni = optionalString(proxy, "sni") ?? optionalString(proxy, "servername");
    if (sni) values.push(`sni=${clean(sni)}`);
    values.push(`skip-cert-verify=${boolField(proxy, "skip-cert-verify", false)}`, `udp=${udp}`);
    return values.join(",");
  }
  return undefined;
}

function addLoonTransportOptions(proxy: Proxy, network: string, options: string[]): void {
  if (network !== "ws" && network !== "http") return;
  const path = nestedString(proxy, "ws-opts", "path");
  const host = nestedString(proxy, "ws-opts", "headers", "Host");
  if (path) options.push(`path=${loonQuote(path)}`);
  if (host) options.push(`host=${loonQuote(host)}`);
}

function addLoonTlsOptions(proxy: Proxy, tls: boolean, options: string[]): void {
  if (!tls) return;
  const sni = optionalString(proxy, "sni") ?? optionalString(proxy, "servername");
  if (sni) options.push(`sni=${clean(sni)}`);
  options.push(`skip-cert-verify=${boolField(proxy, "skip-cert-verify", false)}`);
}

function convertProxy(proxy: Proxy): string | undefined {
  const type = stringField(proxy, "type").toLowerCase();
  const server = stringField(proxy, "server");
  const port = numberOrString(proxy, "port");
  const tag = jmsTag(stringField(proxy, "name"));
  const base = `${server}:${port}`;
  if (type === "ss") {
    return `shadowsocks=${base}, method=${stringField(proxy, "cipher")}, password=${clean(stringField(proxy, "password"))}, udp-relay=${boolField(proxy, "udp", true)}, tag=${tag}`;
  }
  if (type === "vless") {
    const options = [`method=none`, `password=${clean(stringField(proxy, "uuid"))}`];
    const network = optionalString(proxy, "network") ?? "tcp";
    const tls = boolField(proxy, "tls", false);
    if (network === "ws") {
      options.push(`obfs=${tls ? "wss" : "ws"}`);
      const host = nestedString(proxy, "ws-opts", "headers", "Host") ?? optionalString(proxy, "servername");
      if (host) options.push(`obfs-host=${clean(host)}`);
      const path = nestedString(proxy, "ws-opts", "path");
      if (path) options.push(`obfs-uri=${clean(path)}`);
    } else if (tls) {
      options.push("obfs=over-tls");
      const host = optionalString(proxy, "servername");
      if (host) options.push(`obfs-host=${clean(host)}`);
    }
    const publicKey = nestedString(proxy, "reality-opts", "public-key");
    if (publicKey) options.push(`reality-base64-pubkey=${clean(publicKey)}`);
    const shortId = nestedString(proxy, "reality-opts", "short-id");
    if (shortId) options.push(`reality-hex-shortid=${clean(shortId)}`);
    const flow = optionalString(proxy, "flow");
    if (flow) options.push(`vless-flow=${clean(flow)}`);
    options.push(`tag= ${tag}`);
    return `vless=${base}, ${options.join(", ")}`;
  }
  if (type === "vmess") {
    const options = [
      `method=${optionalString(proxy, "cipher") ?? "auto"}`,
      `password=${clean(stringField(proxy, "uuid"))}`,
    ];
    const network = optionalString(proxy, "network") ?? "tcp";
    const tls = boolField(proxy, "tls", false);
    if (network === "ws") {
      options.push(`obfs=${tls ? "wss" : "ws"}`);
      const host = nestedString(proxy, "ws-opts", "headers", "Host") ?? optionalString(proxy, "servername");
      if (host) options.push(`obfs-host=${clean(host)}`);
      const path = nestedString(proxy, "ws-opts", "path");
      if (path) options.push(`obfs-uri=${clean(path)}`);
    } else if (tls) options.push("obfs=over-tls");
    const sni = optionalString(proxy, "servername");
    if (sni) options.push(`tls-host=${clean(sni)}`);
    options.push(`udp-relay=${boolField(proxy, "udp", true)}`, `tag=${tag}`);
    return `vmess=${base}, ${options.join(", ")}`;
  }
  if (type === "trojan") {
    const options = [`password=${clean(stringField(proxy, "password"))}`, "over-tls=true"];
    const sni = optionalString(proxy, "sni") ?? optionalString(proxy, "servername");
    if (sni) options.push(`tls-host=${clean(sni)}`);
    options.push(`udp-relay=${boolField(proxy, "udp", true)}`, `tag=${tag}`);
    return `trojan=${base}, ${options.join(", ")}`;
  }
  if (type === "http" || type === "socks5") {
    const options: string[] = [];
    const username = optionalString(proxy, "username");
    const password = optionalString(proxy, "password");
    if (username) options.push(`username=${clean(username)}`);
    if (password) options.push(`password=${clean(password)}`);
    options.push(`tag=${tag}`);
    return `${type}=${base}, ${options.join(", ")}`;
  }
  return undefined;
}

function jmsTag(name: string): string {
  const endpoint = name.includes("@") ? name.slice(name.lastIndexOf("@") + 1) : "";
  const host = endpoint.replace(/:\d+$/, "");
  return clean(host.includes(".") ? host.split(".")[0] : name);
}

function stringField(value: Proxy, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new HttpError(422, `missing string field ${key}`);
  return field;
}

function optionalString(value: Proxy, key: string): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function numberOrString(value: Proxy, key: string): string {
  const field = value[key];
  if (typeof field === "string" || typeof field === "number") return String(field);
  throw new HttpError(422, `missing field ${key}`);
}

function optionalNumberOrString(value: Proxy, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" || typeof field === "number" ? String(field) : undefined;
}

function boolField(value: Proxy, key: string, fallback: boolean): boolean {
  return typeof value[key] === "boolean" ? (value[key] as boolean) : fallback;
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function clean(value: string): string {
  return value.replace(/[,\r\n]/g, " ").trim();
}

function loonName(value: string): string {
  return value.replace(/[,=\r\n]/g, " ").trim();
}

function loonQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
