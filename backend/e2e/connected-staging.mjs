// Opt-in live staging acceptance: real Composio, Deepgram, and managed AI.
// Requires a disposable staging account with allowance and invented 16 kHz PCM speech.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import WebSocket from "ws";

const base =
  process.env.SAVVY_E2E_SERVICE_URL ?? "https://staging-api.savvycopilot.com";
const audience = "https://staging-api.savvycopilot.com";
const originHeader = base.startsWith("http://127.0.0.1:")
  ? { "cf-connecting-ip": "203.0.113.10" }
  : {};
const tokenPath = process.env.SAVVY_E2E_TOKEN_FILE;
const metadataPath = process.env.SAVVY_E2E_OAUTH_FILE;
const pcmPaths = [
  process.env.SAVVY_E2E_MIC_PCM,
  process.env.SAVVY_E2E_SYSTEM_PCM,
];
const durationMs = Number(process.env.SAVVY_E2E_DURATION_MS ?? 725_000);
const allowReconnect = process.env.SAVVY_E2E_ALLOW_RECONNECT === "1";
assert(
  tokenPath && metadataPath && pcmPaths.every(Boolean),
  "Set token, OAuth metadata, and both PCM file paths",
);
assert(
  Number.isInteger(durationMs) && durationMs >= 30_000,
  "Meeting duration must be at least 30 seconds",
);
const pcm = pcmPaths.map((path) => readFileSync(path));
assert(pcm.every((audio) => audio.length >= 3200 && audio.length % 2 === 0));
const metadata = JSON.parse(readFileSync(metadataPath, "utf8")).metadata;
let tokens = JSON.parse(readFileSync(tokenPath, "utf8"));
let leaseVersion;
let sockets = [];
let timer;
let session;
let commandId = 0;
let reconnects = 0;
const transcript = { microphone: [], system: [] };
const sentFrames = { microphone: 0, system: 0 };
const closed = [];
let lastTickAt = Date.now();
let maxTickGapMs = 0;
const result = {
  startedAt: new Date().toISOString(),
  service: base,
  liveProviders: true,
  durationMs,
  source: "notion",
};

async function refreshToken() {
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: "savvy-desktop-staging",
      resource: audience,
    }),
  });
  assert.equal(response.status, 200, "Staging OAuth refresh failed");
  const next = await response.json();
  assert(
    next.access_token &&
      next.refresh_token &&
      next.refresh_token !== tokens.refresh_token,
  );
  writeFileSync(tokenPath + ".tmp", JSON.stringify(next), { mode: 0o600 });
  renameSync(tokenPath + ".tmp", tokenPath);
  tokens = next;
}

async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + tokens.access_token,
      ...originHeader,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    200,
    `${path}: ${response.status} ${data.code ?? ""}`,
  );
  return data;
}

async function connect() {
  const view = await api("/v1/sessions", { sessionId: session });
  leaseVersion = view.leaseVersion;
  assert.equal(view.state, "active", "Meeting is no longer active");
  sockets = await Promise.all(["microphone", "system"].map(openChannel));
}

async function openChannel(channel) {
  const socket = new WebSocket(
    base.replace(/^http/, "ws") +
      `/v1/sessions/${session}/audio/${channel}?leaseVersion=${leaseVersion}&language=en`,
    {
      headers: {
        authorization: "Bearer " + tokens.access_token,
        ...originHeader,
      },
    },
  );
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const text =
      message.type === "Results"
        ? message.channel?.alternatives?.[0]?.transcript?.trim()
        : "";
    if (text && message.is_final) transcript[channel].push(text);
  });
  socket.on("close", (code, reason) =>
    closed.push({
      channel,
      code,
      reason: reason.toString().slice(0, 80),
      at: new Date().toISOString(),
    }),
  );
  socket.on("error", (error) =>
    closed.push({
      channel,
      error: error.code ?? error.message,
      at: new Date().toISOString(),
    }),
  );
  await once(socket, "open");
  return socket;
}

function streamAudio() {
  const offsets = [0, 0];
  lastTickAt = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    maxTickGapMs = Math.max(maxTickGapMs, now - lastTickAt);
    lastTickAt = now;
    sockets.forEach((socket, index) => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > 32_000
      )
        return;
      const frame = Buffer.alloc(1600);
      const audio = pcm[index];
      for (let i = 0; i < frame.length; i += 2) {
        frame[i] = audio[offsets[index]];
        frame[i + 1] = audio[offsets[index] + 1];
        offsets[index] = (offsets[index] + 2) % audio.length;
      }
      socket.send(frame);
      sentFrames[index === 0 ? "microphone" : "system"]++;
    });
  }, 50);
}

try {
  await refreshToken();
  const status = await api("/v1/sources/connections");
  const notion = status.connections.find((item) => item.provider === "notion");
  assert(
    notion?.connected,
    "Notion connection is not active for this Savvy account",
  );
  const search = await api("/v1/sources/search", {
    provider: "notion",
    kind: "page",
    accountId: notion.accountId,
    query: "Savvy connector test",
  });
  const page = search.records.find(
    (item) => item.title === "Savvy connector test — Acme renewal",
  );
  assert(page, "Fictional Acme Notion page was not found");
  const fetched = await api("/v1/sources/fetch", page);
  assert.match(fetched.content, /Maya Chen/);
  assert.match(fetched.content, /24000/);
  result.recordId = page.recordId;
  result.refreshedAt = new Date().toISOString();

  session = randomUUID();
  const native = process.env.SAVVY_E2E_NATIVE_FILE
    ? JSON.parse(readFileSync(process.env.SAVVY_E2E_NATIVE_FILE, "utf8"))
    : null;
  if (native) {
    assert.equal(native.refresh[0].status, "fresh");
    assert.equal(native.evidence.length, 1);
    assert.match(native.evidence[0].relativePath, /^savvy-source-/);
    assert.match(native.evidence[0].excerpt, /Maya Chen/);
    result.nativeLocalImport = true;
  }
  const sourceId = native?.evidence[0].id ?? randomUUID();
  const evidence = native?.evidence ?? [
    {
      id: sourceId,
      kind: "client",
      relativePath: "savvy-source-notion-acme.md",
      locator: { label: "Savvy connector test — Acme renewal" },
      excerpt: fetched.content,
    },
  ];
  const request = native?.modelRequest
    ? {
        ...native.modelRequest,
        sessionId: session,
        generationId: 1,
        transcriptRevision: 1,
        trigger: "manual",
        recentTurns: [],
        focalTurnIds: [],
      }
    : {
        sessionId: session,
        generationId: 1,
        transcriptRevision: 1,
        trigger: "manual",
        language: "en",
        briefMarkdown:
          "# Acme renewal\nAnswer the customer's question using the attached source.",
        hardConstraints: [],
        evidence,
        meetingLedger: { items: [] },
        recentTurns: [],
        focalTurnIds: [],
      };
  await connect();
  await api(`/v1/sessions/${session}/context`, {
    request: { ...request, generationId: 0, transcriptRevision: 0 },
  });
  streamAudio();
  const began = Date.now();
  let advised = false;
  let rotated = false;
  while (Date.now() - began < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const elapsed = Date.now() - began;
    if (
      !advised &&
      elapsed > 12_000 &&
      transcript.system.length &&
      transcript.microphone.length
    ) {
      const turnText =
        transcript.system.find((text) => /buyer|approve|renewal/i.test(text)) ??
        transcript.system[0];
      assert(
        !/Maya Chen|24000/i.test(turnText),
        "Spoken question contains the source answer",
      );
      const turn = randomUUID();
      request.recentTurns = [
        {
          id: turn,
          sessionId: session,
          channel: "other",
          text: turnText,
          language: "en",
          startMs: 0,
          endMs: elapsed,
          isFinal: true,
          confidence: 0.99,
        },
      ];
      request.focalTurnIds = [turn];
      const advice = await api(`/v1/sessions/${session}/recommendations`, {
        idempotencyKey: "connected-live-" + session,
        leaseVersion,
        request,
      });
      assert.deepEqual(advice.advice.evidenceIds, [sourceId]);
      assert.match(
        `${advice.advice.say} ${advice.advice.rationale}`,
        /Maya Chen/,
      );
      result.advice = {
        citedImportedSource: true,
        namedBuyerFromSource: true,
        elapsedMs: elapsed,
      };
      advised = true;
      console.log("Real transcript produced source-cited managed advice");
    }
    if (!rotated && elapsed > durationMs / 2 && durationMs > 120_000) {
      clearInterval(timer);
      const paused = await api(`/v1/sessions/${session}/pause`, {
        leaseVersion,
        commandId: ++commandId,
      });
      leaseVersion = paused.leaseVersion;
      for (const socket of sockets) socket.close();
      await refreshToken();
      const resumed = await api(`/v1/sessions/${session}/resume`, {
        leaseVersion,
        commandId: ++commandId,
      });
      leaseVersion = resumed.leaseVersion;
      await connect();
      streamAudio();
      rotated = true;
      console.log("OAuth rotation and explicit meeting resume passed");
    }
    if (elapsed % 60_000 < 1000)
      console.log(
        `Meeting elapsed ${Math.round(elapsed / 1000)}s, max tick gap ${maxTickGapMs}ms`,
      );
    if (allowReconnect) {
      let attempts = 0;
      while (sockets.some((socket) => socket.readyState !== WebSocket.OPEN)) {
        assert(++attempts <= 4, "Too many audio reconnect attempts");
        const index = sockets.findIndex(
          (socket) => socket.readyState !== WebSocket.OPEN,
        );
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        const view = await api("/v1/sessions", { sessionId: session });
        assert.equal(
          view.state,
          "active",
          "Meeting paused after transport interruption",
        );
        leaseVersion = view.leaseVersion;
        const channel = index === 0 ? "microphone" : "system";
        sockets[index] = await openChannel(channel);
        reconnects++;
        console.log(
          `Recovered ${channel} stream after public transport interruption`,
        );
      }
    }
    assert(
      sockets.every((socket) => socket.readyState === WebSocket.OPEN),
      `Audio socket closed during meeting: ${JSON.stringify({ closed, sentFrames, maxTickGapMs })}`,
    );
  }
  assert(advised, "No real final transcript produced advice");
  assert(
    transcript.microphone.length && transcript.system.length,
    "Both audio channels need final transcripts",
  );
  assert(
    transcript.microphone.some((text) =>
      /checking|responsible|approval/i.test(text),
    ),
    "Microphone speech was not attributed to its channel",
  );
  assert(
    transcript.system.some((text) => /buyer|renewal/i.test(text)),
    "Customer speech was not attributed to its channel",
  );
  result.finalTurns = {
    microphone: transcript.microphone.length,
    system: transcript.system.length,
  };
  result.rotated = rotated;
  result.actualDurationMs = Date.now() - began;
  result.maxTickGapMs = maxTickGapMs;
  result.sentFrames = sentFrames;
  result.reconnects = reconnects;
  console.log(JSON.stringify(result));
} finally {
  clearInterval(timer);
  if (session) {
    try {
      let view = await api("/v1/sessions", { sessionId: session });
      if (view.state !== "stopped") {
        try {
          await api(`/v1/sessions/${session}/stop`, {
            leaseVersion: view.leaseVersion,
            commandId: ++commandId,
          });
        } catch (error) {
          if (!error.message.includes("session_conflict")) throw error;
          view = await api("/v1/sessions", { sessionId: session });
          await api(`/v1/sessions/${session}/stop`, {
            leaseVersion: view.leaseVersion,
            commandId: ++commandId,
          });
        }
      }
    } catch (error) {
      console.error("Meeting cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }
  for (const socket of sockets) socket.close();
}
