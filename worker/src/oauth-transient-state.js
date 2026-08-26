// Durable Object holding short-lived OAuth state between the authorize
// redirect and the callback.
//
// KV is eventually consistent, which is fine for token records but not for a
// single-use state value that must be readable milliseconds after it is
// written and must never be replayable.
//
// The same object serves as a fixed-window rate limiter (POST /rate/<name>):
// storage operations are serialized by input gates, so a counter incremented
// here cannot race, unlike two Worker isolates sharing KV.

const STATE_TTL_MS = 10 * 60 * 1000;

export class OAuthTransientState {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "PUT") {
      const value = await request.json();
      await this.storage.put(url.pathname, { value, expires_at: Date.now() + STATE_TTL_MS });
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && url.pathname.startsWith("/rate/")) {
      return this.recordHit(url);
    }

    if (request.method === "DELETE") {
      // Read and delete in one step, so a replayed callback finds nothing.
      const stored = await this.storage.get(url.pathname);
      await this.storage.delete(url.pathname);
      if (!stored || stored.expires_at < Date.now()) {
        return Response.json({ error: "expired_or_missing" }, { status: 404 });
      }
      return Response.json(stored.value);
    }

    return new Response("Method not allowed", { status: 405 });
  }

  /**
   * Count one hit against a fixed window and report whether the caller may
   * proceed. The window index is part of the key, and the previous window's
   * counter is dropped on write, so each bucket costs at most two keys.
   */
  async recordHit(url) {
    const params = url.searchParams;
    const limit = Math.max(1, Number.parseInt(params.get("limit") ?? "5", 10) || 5);
    const windowMs = Math.max(1000, Number.parseInt(params.get("window_ms") ?? "3600000", 10) || 3600000);

    const windowIndex = Math.floor(Date.now() / windowMs);
    const bucketKey = `${url.pathname}:${windowIndex}`;
    const count = ((await this.storage.get(bucketKey)) ?? 0) + 1;

    if (count > limit) {
      // Do not keep growing the counter once limited; just refuse.
      return Response.json({ allowed: false, count: count - 1 });
    }
    await this.storage.put(bucketKey, count);
    await this.storage.delete(`${url.pathname}:${windowIndex - 1}`);
    return Response.json({ allowed: true, count });
  }
}
