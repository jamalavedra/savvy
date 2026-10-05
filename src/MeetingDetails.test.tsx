import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MeetingDetails } from "./MeetingDetails";
import type { MeetingHistoryItem, TranscriptTurn } from "./types";
const api = vi.hoisted(() => ({
  getMeetingTranscriptPage: vi.fn(),
  openMeetingRecording: vi.fn(),
  openMeetingTranscript: vi.fn(),
}));
vi.mock("./lib/api", () => api);
const meeting: MeetingHistoryItem = {
  clientName: "Local client",
  recommendations: [],
  session: {
    id: "session",
    clientId: null,
    briefId: null,
    state: "completed",
    startedAt: "2026-09-13T10:00:00Z",
    endedAt: "2026-09-13T10:24:00Z",
    audioPath: null,
    contextPackHash: "",
    sourceIndexRevision: "",
  },
};
const turns: TranscriptTurn[] = Array.from({ length: 51 }, (_, index) => ({
  id: String(index),
  sessionId: "session",
  channel: "other",
  text: `Turn ${index}`,
  language: "en",
  startMs: index * 1000,
  endMs: index * 1000 + 500,
  isFinal: true,
  confidence: 1,
}));
it("pages local transcript, preserves content after failures and discards late navigation results", async () => {
  api.getMeetingTranscriptPage
    .mockResolvedValueOnce(turns)
    .mockRejectedValueOnce(new Error("Local database unavailable"))
    .mockResolvedValueOnce(turns)
    .mockResolvedValueOnce([turns[50]])
    .mockResolvedValueOnce(turns)
    .mockResolvedValueOnce([]);
  api.openMeetingTranscript.mockRejectedValueOnce(
    new Error("Transcript file cannot be opened"),
  );
  const back = vi.fn();
  const view = render(<MeetingDetails meeting={meeting} onBack={back} />);
  expect(screen.getByRole("heading", { name: "Local client" })).toHaveFocus();
  await screen.findByText("Turn 49");
  expect(screen.queryByText("Turn 50")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show recording" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Turn 0")).toBeInTheDocument();
  expect(screen.getByText("Page 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry transcript" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Turn 50");
  expect(api.getMeetingTranscriptPage).toHaveBeenLastCalledWith("session", 50);
  expect(screen.getByText("Page 2")).toBeInTheDocument();
  expect(screen.queryByText("Turn 0")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Turn 0");
  expect(api.getMeetingTranscriptPage).toHaveBeenLastCalledWith("session", 0);
  expect(screen.queryByText("Turn 50")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open transcript" }));
  await screen.findByText("Error: Transcript file cannot be opened");
  fireEvent.click(screen.getByRole("button", { name: "Retry transcript" }));
  await screen.findByText("No transcript was saved for this meeting.");
  let release!: (value: TranscriptTurn[]) => void;
  api.getMeetingTranscriptPage.mockReturnValueOnce(
    new Promise<TranscriptTurn[]>((resolve) => {
      release = resolve;
    }),
  );
  view.rerender(
    <MeetingDetails
      meeting={{ ...meeting, session: { ...meeting.session, id: "second" } }}
      onBack={back}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to history" }));
  expect(back).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => {
    release(turns);
  });
  expect(screen.queryByText("Turn 0")).not.toBeInTheDocument();
});
