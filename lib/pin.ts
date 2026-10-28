/**
 * OpenRouter upstream pinning.
 *
 * OpenRouter load-balances a model across upstream providers, and each upstream
 * keeps its own KV cache. Requests landing on different upstreams get almost no
 * prefix-cache hits, so a cache-conscious session wants every request to reach
 * the same upstream.
 *
 * Everything here is pure except `fetchEndpoints`, and the fetch never blocks a
 * request: the caller asks for a slug, gets whatever is already known, and the
 * lookup resolves in the background for the next request.
 */

export interface OpenRouterEndpoint {
  provider_name?: string;
  /** Unique endpoint id, e.g. `deepinfra/fp8`. The slug is the part before `/`. */
  tag?: string;
  /** 0 = active, -1/-2 = degraded or disabled, absent = unknown. */
  status?: number;
  pricing?: { input_cache_read?: string | null } | null;
}

export interface ProviderRouting {
  order: string[];
  allow_fallbacks: boolean;
}

export interface PinCacheEntry {
  slug?: string;
  at: number;
  /** True when the last lookup failed; re-checked on the short TTL. */
  degraded: boolean;
}

/** Successful lookups stay trusted for 6h. */
export const PIN_TTL_MS = 6 * 60 * 60 * 1000;
/** Failed lookups retry after 30m. */
export const PIN_RETRY_TTL_MS = 30 * 60 * 1000;
export const PIN_TIMEOUT_MS = 10_000;

/**
 * OpenRouter endpoint ids always carry the vendor namespace, so the model id
 * doubles as the slug. Bare ids (`deepseek-v4-flash`) cannot be resolved without
 * a vendor table, and pinning is skipped for them.
 */
export function endpointsUrl(modelId: string): string | undefined {
  if (!modelId.includes("/")) return undefined;
  return `https://openrouter.ai/api/v1/models/${modelId}/endpoints`;
}

function cachePrice(endpoint: OpenRouterEndpoint): number | undefined {
  const raw = endpoint.pricing?.input_cache_read;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Choose the upstream to pin.
 *
 * Only endpoints that publish an `input_cache_read` price can serve prefix
 * cache hits, and active ones (`status === 0`) are preferred over degraded ones.
 * When `preferred` names upstreams explicitly, the first match wins — that is the
 * escape hatch for users who care about upstream reputation more than price.
 * Otherwise the cheapest cache-capable upstream wins, with the tag as a stable
 * tie-breaker.
 */
export function pickUpstream(
  endpoints: OpenRouterEndpoint[],
  preferred?: string[] | null,
): string | undefined {
  const cacheable = endpoints.filter(
    (endpoint) => cachePrice(endpoint) !== undefined,
  );
  const active = cacheable.filter((endpoint) => endpoint.status === 0);
  const pool = active.length > 0 ? active : cacheable;
  if (pool.length === 0) return undefined;

  const slugs = pool
    .map((endpoint) => endpoint.tag?.split("/")[0]?.trim())
    .filter((slug): slug is string => Boolean(slug));
  if (slugs.length === 0) return undefined;

  if (preferred && preferred.length > 0) {
    const lowered = slugs.map((slug) => slug.toLowerCase());
    for (const wanted of preferred) {
      const index = lowered.indexOf(wanted.toLowerCase());
      if (index !== -1) return slugs[index];
    }
  }

  const ranked = [...pool]
    .map((endpoint, index) => ({
      endpoint,
      slug: slugs[index] as string | undefined,
      price: cachePrice(endpoint) ?? Number.POSITIVE_INFINITY,
    }))
    .filter((item): item is { endpoint: OpenRouterEndpoint; slug: string; price: number } =>
      Boolean(item.slug),
    )
    .sort((a, b) => a.price - b.price || a.slug.localeCompare(b.slug));

  return ranked[0]?.slug;
}

export function pinEntryFresh(
  entry: PinCacheEntry | undefined,
  now: number,
): boolean {
  if (!entry) return false;
  const ttl = entry.degraded ? PIN_RETRY_TTL_MS : PIN_TTL_MS;
  return now - entry.at < ttl;
}

/**
 * Merge a lookup into the cache.
 *
 * A failed lookup must not throw away a known-good upstream: the previous slug
 * keeps serving (marked degraded) until the next short-TTL retry succeeds.
 */
export function mergePinLookup(
  previous: PinCacheEntry | undefined,
  fetchedSlug: string | undefined,
  now: number,
): PinCacheEntry {
  if (!fetchedSlug) {
    return previous?.slug
      ? { slug: previous.slug, at: now, degraded: true }
      : { slug: undefined, at: now, degraded: true };
  }
  return { slug: fetchedSlug, at: now, degraded: false };
}

/**
 * Build the `provider` routing object for a request payload.
 *
 * Returns undefined — meaning "leave the payload alone" — when the payload
 * already carries user routing (never overwrite an explicit choice) or when no
 * upstream is known yet.
 */
export function providerRouting(
  existing: unknown,
  slug: string | undefined,
  allowFallbacks: boolean,
): ProviderRouting | undefined {
  if (existing !== undefined && existing !== null) return undefined;
  if (!slug) return undefined;
  return { order: [slug], allow_fallbacks: allowFallbacks };
}

/** Fetch the endpoint list. Never throws; returns undefined on any failure. */
export async function fetchEndpoints(
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterEndpoint[] | undefined> {
  const url = endpointsUrl(modelId);
  if (!url) return undefined;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      data?: { endpoints?: OpenRouterEndpoint[] };
    };
    const endpoints = body.data?.endpoints;
    return Array.isArray(endpoints) ? endpoints : undefined;
  } catch {
    return undefined;
  }
}
