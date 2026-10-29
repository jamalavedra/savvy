import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./ui";

const options = [
  { value: "salesforce", label: "Salesforce" },
  { value: "unavailable", label: "Unavailable", disabled: true },
  { value: "notion", label: "Notion" },
];
afterEach(() => vi.restoreAllMocks());

it("selects an option when WebKit does not focus buttons on mouse-down", () => {
  const select = vi.fn();
  render(
    <Select
      label="App"
      selectedValue="salesforce"
      options={options}
      onSelect={select}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "App" }));
  const notion = screen.getByRole("option", { name: "Notion" });
  if (fireEvent.mouseDown(notion))
    fireEvent.blur(document.activeElement!, { relatedTarget: null });
  fireEvent.mouseUp(notion);
  fireEvent.click(notion);
  expect(select).toHaveBeenCalledWith("notion");
});

it("shares a labeled chooser with keyboard navigation, disabled options and focus restoration", () => {
  const select = vi.fn();
  render(
    <Select
      label="App"
      selectedValue="salesforce"
      options={options}
      onSelect={select}
    />,
  );
  const trigger = screen.getByRole("button", { name: "App" });
  expect(trigger).toHaveAccessibleDescription("Salesforce");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Salesforce" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  const notion = screen.getByRole("option", { name: "Notion" });
  expect(notion).toHaveFocus();
  expect(screen.getByRole("option", { name: "Unavailable" })).toBeDisabled();
  fireEvent.keyDown(notion, { key: "Home" });
  expect(screen.getByRole("option", { name: "Salesforce" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(notion).toHaveFocus();
  fireEvent.click(notion);
  expect(select).toHaveBeenCalledWith("notion");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps searchable text outside the listbox and clears filtering after Escape", () => {
  render(
    <Select
      label="Language"
      selectedValue="en"
      options={[
        { value: "en", label: "English" },
        { value: "ca", label: "Catalan" },
      ]}
      onSelect={vi.fn()}
      searchable
    />,
  );
  const trigger = screen.getByRole("button", { name: "Language" });
  fireEvent.click(trigger);
  const search = screen.getByRole("textbox", { name: "Search languages" });
  expect(search).toHaveFocus();
  const list = screen.getByRole("listbox", { name: "Language" });
  expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "Catalan" } });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(screen.getByRole("option", { name: "Catalan" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  expect(screen.getByRole("textbox", { name: "Search languages" })).toHaveValue(
    "",
  );
  expect(screen.getAllByRole("option")).toHaveLength(2);
});

it("portals a compact menu above its trigger within the viewport", () => {
  vi.spyOn(
    HTMLButtonElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({
    x: 900,
    y: 700,
    left: 900,
    right: 1100,
    top: 700,
    bottom: 732,
    width: 200,
    height: 32,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(180);
  render(
    <div style={{ overflow: "hidden", height: 20 }}>
      <Select
        label="Model"
        selectedValue="notion"
        options={options}
        onSelect={vi.fn()}
        compact
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const list = screen.getByRole("listbox", { name: "Model" });
  const menu = list.parentElement!;
  expect(menu.parentElement).toBe(document.body);
  expect(menu).toHaveStyle({ position: "fixed" });
  expect(Number.parseFloat(menu.style.top)).toBeLessThan(700);
  expect(
    Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width),
  ).toBeLessThanOrEqual(window.innerWidth - 12);
});

it("keeps Tab navigation in the form order despite the portal", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button>Before</button>
      <Select
        label="App"
        selectedValue="salesforce"
        options={options}
        onSelect={vi.fn()}
      />
      <button>After</button>
    </>,
  );
  await user.click(screen.getByRole("button", { name: "App" }));
  expect(screen.getByRole("option", { name: "Salesforce" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "App" }));
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
});

it("shows a controlled selection and cannot open while disabled", () => {
  function Field() {
    const [value, setValue] = useState("salesforce");
    return (
      <Select
        label="App"
        options={options}
        selectedValue={value}
        onSelect={setValue}
      />
    );
  }
  const view = render(<Field />);
  fireEvent.click(screen.getByRole("button", { name: "App" }));
  fireEvent.click(screen.getByRole("option", { name: "Notion" }));
  expect(screen.getByRole("button", { name: "App" })).toHaveTextContent(
    "Notion",
  );
  expect(
    screen.getByRole("button", { name: "App" }),
  ).toHaveAccessibleDescription("Notion");
  view.rerender(
    <Select
      label="App"
      options={options}
      selectedValue="notion"
      onSelect={vi.fn()}
      disabled
    />,
  );
  const trigger = screen.getByRole("button", { name: "App" });
  expect(trigger).toBeDisabled();
  fireEvent.click(trigger);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("closes an open menu when disabled without reopening after work completes", () => {
  const props = {
    label: "App",
    options,
    selectedValue: "salesforce",
    onSelect: vi.fn(),
  };
  const view = render(<Select {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "App" }));
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  view.rerender(<Select {...props} disabled />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  view.rerender(<Select {...props} />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(props.onSelect).not.toHaveBeenCalled();
});

it("tabs to a disclosure summary and skips closed or visually hidden controls", async () => {
  const user = userEvent.setup();
  render(
    <>
      <Select
        label="Microphone"
        selectedValue="salesforce"
        options={options}
        onSelect={vi.fn()}
      />
      <div style={{ display: "none" }}>
        <button>Hidden display control</button>
      </div>
      <div style={{ visibility: "hidden" }}>
        <button>Hidden visibility control</button>
      </div>
      <details>
        <summary>Input options</summary>
        <button>Hidden input channel</button>
      </details>
      <Select
        label="Output"
        selectedValue="notion"
        options={options}
        onSelect={vi.fn()}
      />
    </>,
  );
  const summary = screen.getByText("Input options");
  await user.click(screen.getByRole("button", { name: "Microphone" }));
  await user.tab();
  expect(summary).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Output" }));
  await user.tab({ shift: true });
  expect(summary).toHaveFocus();
});

it.each(["{Enter}", " "])(
  "commits a focused option exactly once with %s",
  async (key) => {
    const user = userEvent.setup();
    const select = vi.fn();
    render(
      <Select
        label="App"
        selectedValue="salesforce"
        options={options}
        onSelect={select}
      />,
    );
    const trigger = screen.getByRole("button", { name: "App" });
    await user.click(trigger);
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "Notion" })).toHaveFocus();
    await user.keyboard(key);
    expect(select).toHaveBeenCalledExactlyOnceWith("notion");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  },
);

it("leaves Enter in the search field without committing an option", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <Select
      label="Language"
      selectedValue="salesforce"
      options={options}
      onSelect={select}
      searchable
    />,
  );
  await user.click(screen.getByRole("button", { name: "Language" }));
  const search = screen.getByRole("textbox", { name: "Search languages" });
  await user.type(search, "Notion{Enter}");
  expect(search).toHaveFocus();
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeInTheDocument();
});
