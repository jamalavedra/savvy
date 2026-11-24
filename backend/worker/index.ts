import { isServedPath } from "../src/app.ts";

export { SavvyBackend } from "./backend.ts";

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!isServedPath(path)) return new Response(null, { status: 404 });
    const forwarded = new Request(request);
    forwarded.headers.delete("x-savvy-proxy-ip");
    const client = request.headers.get("cf-connecting-ip");
    if (client) forwarded.headers.set("x-savvy-proxy-ip", client);
    return env.BACKEND.jurisdiction("eu").getByName("primary").fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
