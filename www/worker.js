export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    if (url.hostname === "savvycopilot.com") {
      url.hostname = "www.savvycopilot.com";
      response = Response.redirect(url.toString(), 308);
    } else {
      response = await env.ASSETS.fetch(request);
    }
    const headers = new Headers(response.headers);
    headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
