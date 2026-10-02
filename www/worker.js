const HSTS = "max-age=31536000; includeSubDomains";

function withHsts(response) {
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", HSTS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "savvycopilot.com") {
      url.hostname = "www.savvycopilot.com";
      return withHsts(Response.redirect(url.toString(), 308));
    }
    return withHsts(await env.ASSETS.fetch(request));
  },
};
