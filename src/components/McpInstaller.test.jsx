// (C)
// @vitest-environment happy-dom
// McpInstaller's access-token prompt is a Modal nested inside the MCP servers
// Modal. Pinned in the v0.7.6 lint fix round 1: the token field gets focus on
// open, and when the prompt closes focus stays inside the outer dialog (its
// Tab trap) instead of dropping to <body>. The opener ("+ Agent Mode") is
// still disabled at that moment because the add is in flight.
import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (cmd) => (cmd === "mcp_servers_list" ? [] : null)),
}));
vi.mock("@backend", () => ({ invoke: (...a) => invokeMock(...a), listen: vi.fn(async () => () => {}), isTauri: () => true }));
vi.mock("../appMeta.js", () => ({ openExternal: vi.fn() }));

import McpInstaller from "./McpInstaller.jsx";
import { ToastProvider } from "./Toast.jsx";

afterEach(() => cleanup());

test("the token prompt focuses its field and hands focus back inside the outer dialog", async () => {
  render(<ToastProvider><McpInstaller open onClose={() => {}} /></ToastProvider>);
  await act(async () => {});
  // Catalog order: filesystem, github, ... ; GitHub needs a token.
  const addGithub = screen.getAllByRole("button", { name: "+ Agent Mode" })[1];
  addGithub.focus();
  await act(async () => { fireEvent.click(addGithub); });
  const field = await screen.findByPlaceholderText(/Paste token/);
  expect(document.activeElement).toBe(field);
  await act(async () => { fireEvent.click(screen.getByText("Skip")); });
  const outer = screen.getByRole("dialog", { name: "MCP servers" });
  expect(outer.contains(document.activeElement)).toBe(true);
  await waitFor(() => expect(invokeMock.mock.calls.some(([c]) => c === "mcp_server_add")).toBe(true));
});
