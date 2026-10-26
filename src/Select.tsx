import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { Button, Input } from "./ui";
import { moveListboxFocus } from "./lib/listbox";

export function Select({
  options,
  selectedValue,
  onSelect,
  label,
  disabled = false,
  compact = false,
  searchable = false,
  className = "",
}: {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  selectedValue: string;
  onSelect: (value: string) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  searchable?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({
    position: "fixed",
    left: 0,
    top: 0,
    width: 200,
    maxHeight: 210,
    right: "auto",
    bottom: "auto",
  });
  const wrapper = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const valueId = useId();
  const selected = options.find((option) => option.value === selectedValue);
  const visibleOptions = options.filter((option) =>
    option.label.toLowerCase().includes(query.toLowerCase()),
  );
  if (disabled && open) {
    setOpen(false);
    setQuery("");
  }

  function close() {
    setOpen(false);
    setQuery("");
  }
  function contains(target: EventTarget | null) {
    return (
      target instanceof Node &&
      (wrapper.current?.contains(target) || menu.current?.contains(target))
    );
  }
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || !menu.current) return;
      const gap = compact ? 12 : 4;
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - 12);
      const above = Math.max(0, rect.top - gap - 12);
      const height = Math.min(menu.current.scrollHeight, 210);
      const showAbove = compact || (below < height && above > below);
      const maxHeight = Math.min(210, showAbove ? above : below);
      const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 24);
      setPosition({
        position: "fixed",
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: showAbove
          ? Math.max(12, rect.top - gap - Math.min(height, maxHeight))
          : rect.bottom + gap,
        width,
        maxHeight,
        right: "auto",
        bottom: "auto",
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, disabled, compact, query]);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const target = searchable
      ? search.current
      : (menu.current?.querySelector<HTMLButtonElement>(
          '[role="option"][aria-selected="true"]:not(:disabled)',
        ) ??
        menu.current?.querySelector<HTMLButtonElement>(
          '[role="option"]:not(:disabled)',
        ));
    target?.focus();
  }, [open, disabled, searchable]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!contains(event.target)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        trigger.current?.focus();
        close();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const blur = (target: EventTarget | null) => {
    if (!contains(target)) close();
  };
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          "a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]",
        ),
      ).filter((element) => {
        const summary = element.matches("details > summary:first-of-type");
        if (
          (element.tabIndex < 0 &&
            !(summary && !element.hasAttribute("tabindex"))) ||
          element.matches(":disabled") ||
          menu.current?.contains(element)
        )
          return false;
        for (
          let parent: HTMLElement | null = element;
          parent;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          if (
            parent.hidden ||
            parent.hasAttribute("inert") ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse"
          )
            return false;
          if (
            parent instanceof HTMLDetailsElement &&
            !parent.open &&
            !parent.querySelector(":scope > summary")?.contains(element)
          )
            return false;
        }
        return true;
      });
      const current = controls.indexOf(trigger.current!);
      const next = controls[current + (event.shiftKey ? -1 : 1)];
      event.preventDefault();
      close();
      (next ?? trigger.current)?.focus();
    } else moveListboxFocus(event);
  }
  return (
    <span
      className={`settings-dropdown ui-select ${compact ? "compact" : ""} ${className}`.trim()}
      ref={wrapper}
      onBlur={(event) => blur(event.relatedTarget)}
    >
      <Button
        variant="plain"
        ref={trigger}
        className="dropdown-control"
        disabled={disabled}
        aria-label={label}
        aria-describedby={valueId}
        aria-haspopup="listbox"
        aria-controls={open && !disabled ? listId : undefined}
        aria-expanded={open && !disabled}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {compact && <i className="footer-dot" />}
        <span id={valueId}>{selected?.label ?? "Select an option…"}</span>
        <ChevronDown width={15} height={15} />
      </Button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menu}
            className={`dropdown-menu select-menu${compact ? " compact" : ""}`}
            style={position}
            onKeyDown={menuKeys}
            onBlur={(event) => blur(event.relatedTarget)}
          >
            {searchable && (
              <Input
                ref={search}
                className="dropdown-search"
                value={query}
                placeholder="Search languages…"
                aria-label="Search languages"
                aria-controls={listId}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
            <div id={listId} role="listbox" aria-label={label}>
              {visibleOptions.map((option) => (
                <Button
                  variant="plain"
                  role="option"
                  tabIndex={-1}
                  disabled={option.disabled}
                  aria-selected={option.value === selectedValue}
                  className={option.value === selectedValue ? "selected" : ""}
                  key={`${option.value}-${option.label}`}
                  onClick={() => {
                    trigger.current?.focus();
                    close();
                    onSelect(option.value);
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            {visibleOptions.length === 0 && (
              <span className="dropdown-empty" role="status">
                No matching options
              </span>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
