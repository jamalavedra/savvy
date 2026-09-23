export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "savvycopilot.com") {
      url.hostname = "www.savvycopilot.com";
      return Response.redirect(url.toString(), 308);
    }
    return env.ASSETS.fetch(request);
  },
};
