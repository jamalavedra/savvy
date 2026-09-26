import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MeetingReadiness from "./MeetingReadiness";
import * as api from "./lib/api";

vi.mock("tauri-plugin-macos-permissions-api", () => ({
  checkMicrophonePermission: vi.fn().mockResolvedValue(true),
  checkScreenRecordingPermission: vi.fn().mockResolvedValue(false),
}));

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

it("checks native eligibility without capture or synthetic transcription success", async () => {
  const settings = await api.getAppSettings();
  const status = await api.getAppStatus();
  const invoke = vi.fn();
  window.__TAURI_INTERNALS__ = { invoke };
  vi.spyOn(api, "getAppStatus").mockResolvedValue({
    ...status,
    platform: "macos",
  });
  vi.spyOn(api, "getTranscriptionKeyStatus").mockResolvedValue({
    deepgram: true,
    assemblyAi: false,
  });
  vi.spyOn(api, "getRecommendationProviderStatus").mockResolvedValue([]);
  const start = vi.fn();
  render(
    <MeetingReadiness
      settings={{
        ...settings,
        serviceMode: "byok",
        transcriptionProvider: "deepgram",
        microphoneOnly: false,
      }}
      clientName="Meeting readiness"
      busy={false}
      onBack={vi.fn()}
      onStart={start}
      onConfigure={vi.fn()}
    />,
  );
  await screen.findByText("API key configured");
  expect(
    screen.getByRole("heading", { name: "Meeting readiness" }),
  ).toHaveFocus();
  expect(screen.getByText("Permission granted")).toBeVisible();
  expect(screen.getByText("Permission required")).toBeVisible();
  expect(screen.getByText("Provider unavailable")).toBeVisible();
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Start meeting" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /Start with AI assistance unavailable/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start meeting" }));
  expect(start).toHaveBeenCalledTimes(1);
});

it("keeps managed start disabled after failed checks until an explicit successful recheck", async () => {
  const settings = await api.getAppSettings();
  const status = await api.getAppStatus();
  const account = await api.managedSignInFinish(await api.managedSignInBegin());
  window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
  vi.spyOn(api, "getAppStatus").mockResolvedValue({
    ...status,
    platform: "macos",
  });
  const read = vi
    .spyOn(api, "managedAccount")
    .mockRejectedValue(new Error("Offline"));
  const start = vi.fn();
  render(
    <MeetingReadiness
      settings={{ ...settings, serviceMode: "managed", microphoneOnly: true }}
      clientName="Meeting readiness"
      busy={false}
      onBack={vi.fn()}
      onStart={start}
      onConfigure={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Start meeting" })).toBeDisabled();
  expect(screen.getByText("Microphone only")).toBeVisible();
  read.mockResolvedValue({ ...account, meetingMsAvailable: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
  await screen.findByText("No allowance");
  expect(screen.getByRole("button", { name: "Start meeting" })).toBeDisabled();
  read.mockResolvedValue({ ...account, meetingMsAvailable: 60000 });
  fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start meeting" })).toBeEnabled(),
  );
  expect(start).not.toHaveBeenCalled();
});
