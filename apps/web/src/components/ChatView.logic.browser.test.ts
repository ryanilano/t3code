import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createWorkspaceFocusController } from "../lib/workspaceFocus";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const list = document.createElement("ul");
  const row = (name: string) => {
    const element = document.createElement("div");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.dataset.sidebarRow = name;
    element.textContent = name;
    list.append(element);
    return element;
  };
  const clicked = row("Clicked thread");
  const tabbed = row("Tabbed thread");
  document.body.append(list);
  using _list = { [Symbol.dispose]: () => list.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())).toBe(
    true,
  );

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())).toBe(
    false,
  );
});

it("leaves a text selection in the timeline alone on window return", async () => {
  const timeline = document.createElement("div");
  timeline.tabIndex = -1;
  const reply = document.createElement("p");
  reply.textContent = "Steel bridges are also easy to recycle at the end of their life.";
  timeline.append(reply);
  document.body.append(timeline);
  using _timeline = { [Symbol.dispose]: () => timeline.remove() };

  await userEvent.tripleClick(reply);
  expect(document.activeElement).toBe(timeline);
  expect(document.getSelection()?.toString()).toContain("Steel bridges");
  expect(
    shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection()),
    "refocusing the composer would clear the selected reply text",
  ).toBe(false);
});

it("keeps focus in a region with its own keys on window return", async () => {
  const region = document.createElement("div");
  region.tabIndex = -1;
  region.setAttribute("aria-keyshortcuts", "J K");
  region.textContent = "Guide prose";
  document.body.append(region);
  using _region = { [Symbol.dispose]: () => region.remove() };

  await userEvent.click(region);
  expect(document.activeElement).toBe(region);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())).toBe(
    false,
  );
});

it("refocuses the composer on window return from a clicked area after a bare key press", async () => {
  const controller = createWorkspaceFocusController(document);
  const root = document.createElement("div");
  root.innerHTML =
    '<nav data-workspace-area="sidebar" data-workspace-order="0" tabindex="-1"><button>Thread</button></nav>' +
    '<section data-workspace-area="conversation" data-workspace-order="1" tabindex="-1" style="height: 200px"></section>';
  document.body.append(root);
  using _root = {
    [Symbol.dispose]: () => {
      controller.dispose();
      root.remove();
    },
  };
  const conversation = root.querySelector("section")!;

  await userEvent.click(conversation);
  expect(document.activeElement).toBe(conversation);
  // A window switch can deliver a lone modifier key without moving focus.
  await userEvent.keyboard("{Shift}");
  expect(
    shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection()),
    "a clicked area counts as reached from the keyboard after a bare key press",
  ).toBe(true);

  await userEvent.keyboard("{F6}");
  controller.move(-1);
  await userEvent.keyboard("{F6}");
  controller.move(1);
  expect(document.activeElement).toBe(conversation);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement, document.getSelection())).toBe(
    false,
  );
});

it("keeps keyboard focus across a window switch, but not a clicked or moved focus", async () => {
  const root = document.createElement("div");
  root.innerHTML = '<button>Pull request</button><nav><a href="#threads">Threads</a></nav>';
  document.body.append(root);
  using _root = { [Symbol.dispose]: () => root.remove() };
  const button = root.querySelector("button")!;
  const link = root.querySelector("a")!;
  const blur = () => ({
    element: document.activeElement,
    focusVisible: document.activeElement?.matches(":focus-visible") ?? false,
  });
  const refocus = (focusOnBlur: ReturnType<typeof blur>) =>
    shouldRefocusComposerOnWindowFocus(
      document.activeElement,
      document.getSelection(),
      focusOnBlur,
    );

  // A clicked button the window returns to still yields to the composer.
  await userEvent.click(button);
  expect(refocus(blur())).toBe(true);

  // Tab out to the browser chrome blurs the window with nothing focused; Tab back in lands on a
  // link. The test iframe can't Tab in from outside, so it Tabs onward from the button.
  const tabbedOut = { element: document.body, focusVisible: false };
  await userEvent.tab();
  expect(document.activeElement).toBe(link);
  expect(refocus(tabbedOut), "focus Tabbed onto must stay put").toBe(false);

  // The link had keyboard focus when the window blurred (Ctrl+L, Cmd+Tab) and has it again.
  expect(refocus(blur()), "returning keyboard focus must stay put").toBe(false);

  // Focus moved by script while away, such as a dialog closing onto its trigger, still yields.
  const onLink = blur();
  button.focus();
  expect(button.matches(":focus-visible")).toBe(true);
  expect(refocus(onLink)).toBe(true);
});
