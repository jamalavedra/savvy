import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import AudioCheck from "./AudioCheck";
import * as api from "./lib/api";
import { listen } from "@tauri-apps/api/event";
const CHECK_ONE = "00000000-0000-4000-8000-000000000001";
const CHECK_TWO = "00000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.spyOn(crypto, "randomUUID")
    .mockReset()
    .mockReturnValueOnce(CHECK_ONE)
    .mockReturnValue(CHECK_TWO);
  native.invoke.mockReset().mockResolvedValue(CHECK_ONE);
});
const native = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue("check-1"),
  listener: undefined as undefined | ((event: { payload: unknown }) => void),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, callback) => {
    native.listener = callback;
    return native.unlisten;
  }),
}));
it("requires an explicit start, keeps signal separate from transcription, and stops on navigation", async () => {
  const { unmount } = render(<AudioCheck managed microphoneOnly />);
  const signal = await screen.findByRole("button", { name: "Check signal" });
  await act(async () => {});
  expect(native.invoke).not.toHaveBeenCalled();
  fireEvent.click(signal);
  expect(native.invoke).toHaveBeenCalledWith("audio_check_start", {
    transcribe: false,
    id: CHECK_ONE,
  });
  act(() =>
    native.listener?.({
      payload: {
        id: CHECK_ONE,
        status: "listening",
        microphoneLevel: 0.8,
        systemLevel: 0,
        message: "",
      },
    }),
  );
  expect(
    screen.queryByText(/real transcript was received/i),
  ).not.toBeInTheDocument();
  act(() =>
    native.listener?.({
      payload: {
        id: CHECK_ONE,
        status: "finished",
        microphoneLevel: 0,
        systemLevel: 0,
        message: "Transcription has not been tested.",
      },
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Transcription has not been tested",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Start transcription test" }),
  );
  expect(native.invoke).toHaveBeenLastCalledWith("audio_check_start", {
    transcribe: true,
    id: CHECK_TWO,
  });
  unmount();
  await act(async () => {});
  expect(native.invoke).toHaveBeenCalledWith("audio_check_stop", {
    id: CHECK_TWO,
  });
  expect(native.unlisten).toHaveBeenCalled();
});

it("cancels a native check whose start completes after navigation", async () => {
  let completeStart!: (id: string) => void;
  native.invoke.mockImplementation((command: string) =>
    command === "audio_check_start"
      ? new Promise<string>((resolve) => {
          completeStart = resolve;
        })
      : Promise.resolve(),
  );
  const { unmount } = render(<AudioCheck managed microphoneOnly />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  unmount();
  native.invoke.mockClear();
  await act(async () => completeStart("late-check"));
  expect(native.invoke).toHaveBeenCalledWith("audio_check_stop", {
    id: CHECK_ONE,
  });
});

it("honors Stop while the native start command is still pending", async () => {
  let completeStart!: (id: string) => void;
  native.invoke.mockImplementation((command: string) =>
    command === "audio_check_start"
      ? new Promise<string>((resolve) => {
          completeStart = resolve;
        })
      : Promise.resolve(),
  );
  const { unmount } = render(<AudioCheck managed microphoneOnly />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop check" }));
  native.invoke.mockClear();
  await act(async () => completeStart("stopped-before-ready"));
  expect(native.invoke).toHaveBeenCalledWith("audio_check_stop", {
    id: CHECK_ONE,
  });
  unmount();
});

it("ignores completion events from an earlier audio check", async () => {
  native.invoke.mockResolvedValue("current-check");
  const { unmount } = render(<AudioCheck managed microphoneOnly />);
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  });
  act(() =>
    native.listener?.({
      payload: {
        id: "previous-check",
        status: "passed",
        microphoneLevel: 0,
        systemLevel: 0,
        message: "A real transcript was received.",
      },
    }),
  );
  expect(screen.getByRole("status")).not.toHaveTextContent(
    "A real transcript was received.",
  );
  expect(
    screen.getByRole("button", { name: "Stop check" }),
  ).toBeInTheDocument();
  unmount();
});

it("shows only the current returned transcript and finishes setup explicitly", async () => {
  const finish = vi.fn();
  render(<AudioCheck managed microphoneOnly onComplete={finish} />);
  await act(async () => {});
  fireEvent.click(
    screen.getByRole("button", { name: "Start transcription test" }),
  );
  act(() =>
    native.listener?.({
      payload: {
        id: CHECK_ONE,
        status: "passed",
        microphoneLevel: 0,
        systemLevel: 0,
        message: "A real transcript was received.",
        transcript: "Actual supplier words <script>",
      },
    }),
  );
  expect(
    screen.getByRole("region", { name: "Test transcript" }),
  ).toHaveTextContent("Actual supplier words <script>");
  expect(finish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(finish).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Test again" }));
  expect(
    screen.queryByRole("region", { name: "Test transcript" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Finish setup" }),
  ).not.toBeInTheDocument();
});

it("distinguishes each detected source from silence and resets evidence on retry", async () => {
  render(<AudioCheck managed microphoneOnly={false} />);
  await act(async () => {});
  const mic = screen.getByLabelText("Microphone signal status");
  const system = screen.getByLabelText("System audio signal status");
  expect(mic).toHaveTextContent("Not checked");
  fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  const emit = (
    id: string,
    status: string,
    microphoneLevel: number,
    systemLevel: number,
  ) =>
    act(() =>
      native.listener?.({
        payload: { id, status, microphoneLevel, systemLevel, message: "" },
      }),
    );
  emit("stale-check", "listening", 1, 1);
  expect(mic).toHaveTextContent("No signal detected yet");
  emit(CHECK_ONE, "listening", 0, 0);
  expect(system).toHaveTextContent("No signal detected yet");
  emit(CHECK_ONE, "listening", 0.2, 0);
  expect(mic).toHaveTextContent(
    "Input detected. This does not test transcription.",
  );
  expect(system).toHaveTextContent("No signal detected yet");
  emit(CHECK_ONE, "finished", 0, 0);
  expect(mic).toHaveTextContent("Input detected");
  expect(system).toHaveTextContent("Check your input and try again");
  expect(
    screen.queryByRole("button", { name: "Finish setup" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  expect(mic).toHaveTextContent("No signal detected yet");
  emit(CHECK_TWO, "listening", Number.NaN, 0.3);
  expect(mic).toHaveTextContent("No signal detected yet");
  expect(system).toHaveTextContent("Input detected");
});

it("saves microphone selection before capture and keeps the previous choice on failure", async () => {
  const settings = await api.getAppSettings();
  const devices = vi.spyOn(api, "getInputDevices").mockResolvedValue([
    { name: "Built-in", isDefault: true, channels: 1 },
    { name: "USB", isDefault: false, channels: 2 },
  ]);
  const read = vi.spyOn(api, "getAppSettings").mockResolvedValue({
    ...settings,
    selectedMicrophone: null,
    selectedChannel: null,
  });
  let complete!: (value: typeof settings) => void;
  const save = vi.spyOn(api, "updateAppSettings").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const { unmount } = render(
    <AudioCheck managed microphoneOnly configureInput onComplete={vi.fn()} />,
  );
  await act(async () => {});
  const mic = screen.getByRole("combobox", { name: "Microphone" });
  fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  act(() =>
    native.listener?.({
      payload: {
        id: CHECK_ONE,
        status: "listening",
        microphoneLevel: 0.5,
        systemLevel: 0,
        message: "",
      },
    }),
  );
  act(() =>
    native.listener?.({
      payload: {
        id: CHECK_ONE,
        status: "finished",
        microphoneLevel: 0,
        systemLevel: 0,
        message: "",
      },
    }),
  );
  expect(screen.getByLabelText("Microphone signal status")).toHaveTextContent(
    "Input detected",
  );
  native.invoke.mockClear();

  fireEvent.change(mic, { target: { value: "USB" } });
  await act(async () => {});
  expect(save).toHaveBeenCalledWith({
    ...settings,
    selectedMicrophone: "USB",
    selectedChannel: null,
  });
  expect(mic).toHaveValue("");
  expect(screen.getByRole("button", { name: "Explore Savvy" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check signal" })).toBeDisabled();
  expect(native.invoke).not.toHaveBeenCalledWith(
    "audio_check_start",
    expect.anything(),
  );
  await act(async () =>
    complete({ ...settings, selectedMicrophone: "USB", selectedChannel: null }),
  );
  expect(mic).toHaveValue("USB");
  expect(screen.getByLabelText("Microphone signal status")).toHaveTextContent(
    "Not checked",
  );
  fireEvent.click(screen.getByText("Input options"));
  expect(screen.getByRole("combobox", { name: "Input channel" })).toBeVisible();
  save.mockRejectedValueOnce(new Error("Cannot save input"));
  fireEvent.change(mic, { target: { value: "Built-in" } });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot save input",
  );
  expect(mic).toHaveValue("USB");
  fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
  expect(mic).toBeDisabled();
  unmount();
  devices.mockRestore();
  read.mockRestore();
  save.mockRestore();
});

it.each([false, true])(
  "advances only after input and waits for signal cleanup (microphoneOnly=%s)",
  async (microphoneOnly) => {
    render(
      <AudioCheck
        managed
        microphoneOnly={microphoneOnly}
        configureInput
        onComplete={vi.fn()}
      />,
    );
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: "Check your microphone" }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Start transcription test" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
    const emit = (status: string, mic: number, system: number) =>
      act(() =>
        native.listener?.({
          payload: {
            id: CHECK_ONE,
            status,
            microphoneLevel: mic,
            systemLevel: system,
            message: "",
          },
        }),
      );
    emit("listening", 0.3, 0);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    if (!microphoneOnly) {
      expect(
        screen.getByRole("heading", { name: "Check meeting audio" }),
      ).toHaveFocus();
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      expect(
        screen.queryByLabelText("Microphone signal status"),
      ).not.toBeInTheDocument();
      emit("listening", 0, 0.2);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
    expect(native.invoke).toHaveBeenLastCalledWith("audio_check_stop", {
      id: CHECK_ONE,
    });
    expect(
      screen.getByRole("heading", { name: "Check transcription" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Start transcription test" }),
    ).toBeDisabled();
    emit("cancelled", 0, 0);
    expect(
      screen.getByRole("button", { name: "Start transcription test" }),
    ).toBeEnabled();
    expect(native.invoke).not.toHaveBeenCalledWith("audio_check_start", {
      id: CHECK_TWO,
      transcribe: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start transcription test" }),
    );
    expect(native.invoke).toHaveBeenLastCalledWith("audio_check_start", {
      id: CHECK_TWO,
      transcribe: true,
    });
  },
);

it("recovers from a failed event subscription without starting capture", async () => {
  vi.mocked(listen).mockRejectedValueOnce(
    new Error("event bridge unavailable"),
  );
  render(<AudioCheck managed microphoneOnly />);
  expect(
    await screen.findByRole("button", { name: "Reconnect audio checks" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "event bridge unavailable",
  );
  expect(screen.getByRole("button", { name: "Check signal" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Reconnect audio checks" }),
  );
  await act(async () => {});
  expect(
    screen.queryByRole("button", { name: "Reconnect audio checks" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check signal" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Audio has not been checked",
  );
  expect(native.invoke).not.toHaveBeenCalled();
});

it("opens either audio permission pane without claiming a successful check", async () => {
  window.__TAURI_INTERNALS__ = {};
  try {
    render(<AudioCheck managed microphoneOnly={false} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Check signal" }));
    act(() =>
      native.listener?.({
        payload: {
          id: CHECK_ONE,
          status: "failed",
          microphoneLevel: 0,
          systemLevel: 0,
          message: "Capture unavailable",
        },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open meeting audio settings" }),
    );
    expect(native.invoke).toHaveBeenLastCalledWith("open_audio_settings", {
      system: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Open microphone settings" }),
    );
    expect(native.invoke).toHaveBeenLastCalledWith("open_audio_settings", {
      system: false,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Capture unavailable");
  } finally {
    delete window.__TAURI_INTERNALS__;
  }
});

it("removes a subscription that completes after navigation exactly once", async () => {
  let complete!: (remove: () => void) => void;
  vi.mocked(listen).mockImplementationOnce(
    () =>
      new Promise<() => void>((resolve) => {
        complete = resolve;
      }),
  );
  const remove = vi.fn();
  const { unmount } = render(<AudioCheck managed microphoneOnly />);
  unmount();
  await act(async () => complete(remove));
  expect(remove).toHaveBeenCalledOnce();
});
