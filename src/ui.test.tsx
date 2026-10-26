import { createRef, type FormEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Alert, Button, Input, Select, Textarea } from "./ui";

it("keeps ordinary actions out of form submission and allows an explicit submit", () => {
  const submit = vi.fn((event: FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <Button>Inspect</Button>
      <Button type="submit">Search</Button>
    </form>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(submit).toHaveBeenCalledOnce();
});

it("preserves native labels, control types, disabled state and focus refs", () => {
  const button = createRef<HTMLButtonElement>();
  const input = createRef<HTMLInputElement>();
  render(
    <>
      <Button ref={button}>Cancel</Button>
      <label>
        Query <Input ref={input} type="search" defaultValue="Acme" />
      </label>
      <label>
        Keep copy <Input type="checkbox" defaultChecked disabled />
      </label>
      <label>
        Provider{" "}
        <Select defaultValue="notion">
          <option value="notion">Notion</option>
        </Select>
      </label>
      <label>
        Notes <Textarea defaultValue="Ready" />
      </label>
    </>,
  );
  button.current?.focus();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  input.current?.focus();
  expect(screen.getByRole("searchbox", { name: "Query" })).toHaveFocus();
  expect(screen.getByRole("checkbox", { name: "Keep copy" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Keep copy" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue(
    "notion",
  );
  expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Ready");
});

it("announces errors and progress with their intended urgency", () => {
  render(
    <>
      <Alert>Could not connect</Alert>
      <Alert variant="info">Searching</Alert>
      <Alert variant="warning" role="status">
        Two minutes remain
      </Alert>
    </>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Could not connect");
  expect(
    screen.getAllByRole("status").map((status) => status.textContent),
  ).toEqual(["Searching", "Two minutes remain"]);
});
