// Local fixture only. Not referenced by the deployment configuration.
import worker, { WaveMCP, OAuthTransientState } from "../../src/index.js";
import { saveTokenRecord } from "../../src/wave-oauth.js";
export { WaveMCP, OAuthTransientState };
// All outbound network calls are blocked. Only an in-memory Wave response exists.
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== "https://gql.waveapps.com/graphql/public") throw new Error("Fixture blocked outbound request");
  const body = JSON.parse(init.body);
  return Response.json({ data: { business: { id: body.variables.id, name: "Fixture business" } } });
};
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== "/fixture/authorize") {
      // Keep the production resource audience while delivering only over loopback.
      const url = new URL(request.url); url.protocol = "https:"; url.host = "wave.amesvt.com"; url.port = "";
      return worker.fetch(new Request(url, request), env, ctx);
    }
    // Initialize real provider helpers. Replace only the human Wave login leg.
    await worker.fetch(new Request(new URL("/", request.url)), env, ctx);
    const { authUrl, userId, tokenKey, writesEnabled } = await request.json();
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(authUrl));
    await saveTokenRecord(env.OAUTH_KV, userId, tokenKey, {
      access_token: "fixture-wave-token", refresh_token: "fixture-refresh",
      expires_at: Date.now() + 3600000, writesEnabled,
    }, env.DATA_ENCRYPTION_KEY);
    return Response.json(await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest, userId, metadata: {}, scope: authRequest.scope,
      props: { waveUserId: userId, waveEmail: `${userId}@example.invalid`, tokenKey, writesEnabled },
    }));
  },
};
