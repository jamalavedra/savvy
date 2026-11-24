import { isServedPath } from "../src/app.ts";

export { SavvyBackend } from "./backend.ts";

const AUDIO_PATH = /^\/v1\/sessions\/[^/]+\/audio\/[^/]+$/;

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (AUDIO_PATH.test(path))
      return new Response("Audio is not available on this backend yet", {
        status: 501,
      });
    if (!isServedPath(path)) return new Response(null, { status: 404 });
    return env.BACKEND.jurisdiction("eu").getByName("primary").fetch(request);
  },
} satisfies ExportedHandler<Env>;
