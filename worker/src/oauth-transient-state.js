// Durable Object holding short-lived OAuth state between the authorize
// redirect and the callback.
//
// KV is eventually consistent, which is fine for token records but not for a
// single-use state value that must be readable milliseconds after it is
// written and must never be replayable.

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
}
