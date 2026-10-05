import { createServer } from "node:http";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Only the opt-in native integration test starts this synthetic supplier.
export async function briefSupplier(directory: string) {
  let count = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) {
      void chunk;
    }
    if (req.url?.endsWith("count_tokens")) {
      const contextCount = await readFile(
        join(directory, "context-token-count"),
        "utf8",
      )
        .then(Number)
        .catch(() => 10);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ input_tokens: contextCount }));
      return;
    }
    const id = ++count;
    await writeFile(join(directory, `supplier-started-${id}`), "ready");
    await new Promise<void>((done) => {
      const timer = setInterval(() => {
        void access(join(directory, `supplier-release-${id}`))
          .then(() => {
            clearInterval(timer);
            done();
          })
          .catch(() => {});
      }, 10);
      res.once("close", () => {
        clearInterval(timer);
        done();
      });
    });
    if (res.destroyed) return;
    const brief = {
      title: "Native cancellation fixture",
      objective: "Agree scope",
      responseLanguage: "English",
      ourPosition: "",
      clientPosition: "",
      priorities: [],
      agenda: [
        {
          title: "Scope",
          objective: "Agree scope",
          talkingPoints: [],
          keywords: [],
        },
      ],
      desiredOutcomes: [],
      questionsToAsk: ["What is the scope?"],
      factsToUse: [],
      concessions: [],
      redLines: [],
      prohibitedClaims: [],
      unauthorizedCommitments: [],
      risks: [],
    };
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [{ type: "text", text: JSON.stringify(brief) }],
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
