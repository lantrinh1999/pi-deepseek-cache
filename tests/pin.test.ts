import { describe, expect, it } from "vitest";
import {
  PIN_RETRY_TTL_MS,
  PIN_TTL_MS,
  endpointsUrl,
  fetchEndpoints,
  mergePinLookup,
  pickUpstream,
  pinEntryFresh,
  providerRouting,
  type OpenRouterEndpoint,
} from "../lib/pin.ts";

const endpoint = (
  tag: string,
  cacheRead: string | null = "0.01",
  status = 0,
): OpenRouterEndpoint => ({
  tag,
  status,
  pricing: cacheRead === null ? null : { input_cache_read: cacheRead },
});

describe("endpointsUrl", () => {
  it("builds a URL only for namespaced model ids", () => {
    expect(endpointsUrl("deepseek/deepseek-v4-flash")).toBe(
      "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints",
    );
    expect(endpointsUrl("deepseek-v4-flash")).toBeUndefined();
  });
});

describe("pickUpstream", () => {
  it("picks the cheapest cache-capable active upstream", () => {
    expect(
      pickUpstream([
        endpoint("pricey/fp16", "0.02"),
        endpoint("cheap/fp8", "0.001"),
        endpoint("inactive/fp8", "0.0001", -1),
      ]),
    ).toBe("cheap");
  });

  it("falls back to degraded endpoints when none are active", () => {
    expect(pickUpstream([endpoint("down", "0.01", -1)])).toBe("down");
  });

  it("ignores endpoints that do not price cache reads", () => {
    expect(pickUpstream([endpoint("nocache", null)])).toBeUndefined();
  });

  it("honours an explicit preference list", () => {
    expect(
      pickUpstream(
        [endpoint("cheap", "0.001"), endpoint("trusted", "0.09")],
        ["trusted"],
      ),
    ).toBe("trusted");
  });

  it("falls back to price when the preferred upstream is absent", () => {
    expect(
      pickUpstream([endpoint("cheap", "0.001"), endpoint("other", "0.09")], [
        "trusted",
      ]),
    ).toBe("cheap");
  });

  it("breaks price ties deterministically", () => {
    expect(pickUpstream([endpoint("zeta", "0.01"), endpoint("alpha", "0.01")])).toBe(
      "alpha",
    );
  });

  it("ignores unusable tags and empty lists", () => {
    expect(pickUpstream([])).toBeUndefined();
    expect(pickUpstream([{ tag: undefined, status: 0, pricing: { input_cache_read: "1" } }])).toBeUndefined();
  });
});

describe("pin cache", () => {
  it("expires successful lookups after the long TTL", () => {
    const entry = { slug: "x", at: 0, degraded: false };
    expect(pinEntryFresh(entry, PIN_TTL_MS - 1)).toBe(true);
    expect(pinEntryFresh(entry, PIN_TTL_MS + 1)).toBe(false);
  });

  it("retries failed lookups sooner", () => {
    const entry = { slug: "x", at: 0, degraded: true };
    expect(pinEntryFresh(entry, PIN_RETRY_TTL_MS - 1)).toBe(true);
    expect(pinEntryFresh(entry, PIN_RETRY_TTL_MS + 1)).toBe(false);
    expect(pinEntryFresh(undefined, 0)).toBe(false);
  });

  it("keeps a known-good upstream when a refresh fails", () => {
    const merged = mergePinLookup({ slug: "good", at: 0, degraded: false }, undefined, 10);
    expect(merged).toEqual({ slug: "good", at: 10, degraded: true });
  });

  it("records a failed first lookup as degraded and empty", () => {
    expect(mergePinLookup(undefined, undefined, 10)).toEqual({
      slug: undefined,
      at: 10,
      degraded: true,
    });
  });

  it("replaces the entry on success", () => {
    expect(mergePinLookup({ slug: "old", at: 0, degraded: true }, "new", 5)).toEqual(
      { slug: "new", at: 5, degraded: false },
    );
  });
});

describe("providerRouting", () => {
  it("builds an order pin", () => {
    expect(providerRouting(undefined, "deepinfra", true)).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: true,
    });
  });

  it("never overrides routing the caller already set", () => {
    expect(providerRouting({ order: ["x"] }, "deepinfra", true)).toBeUndefined();
    expect(providerRouting({}, "deepinfra", true)).toBeUndefined();
  });

  it("does nothing without a slug", () => {
    expect(providerRouting(undefined, undefined, true)).toBeUndefined();
  });
});

describe("fetchEndpoints", () => {
  const respond = (body: unknown, init: { ok?: boolean } = {}) =>
    (async () =>
      ({
        ok: init.ok ?? true,
        json: async () => body,
      }) as Response) as unknown as typeof fetch;

  it("returns the endpoint list", async () => {
    const endpoints = await fetchEndpoints(
      "deepseek/deepseek-v4-flash",
      respond({ data: { endpoints: [endpoint("a")] } }),
    );
    expect(endpoints).toEqual([endpoint("a")]);
  });

  it("returns undefined for a non-OK response", async () => {
    expect(
      await fetchEndpoints("a/b", respond({}, { ok: false })),
    ).toBeUndefined();
  });

  it("returns undefined for a malformed body", async () => {
    expect(
      await fetchEndpoints("a/b", respond({ data: { endpoints: "nope" } })),
    ).toBeUndefined();
  });

  it("swallows network errors", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchEndpoints("a/b", failing)).toBeUndefined();
  });

  it("skips the request for bare ids", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch;
    expect(await fetchEndpoints("bare-id", spy)).toBeUndefined();
    expect(called).toBe(false);
  });
});
