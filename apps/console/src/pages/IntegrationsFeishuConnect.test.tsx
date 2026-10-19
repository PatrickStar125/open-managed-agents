import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { IntegrationsFeishuConnect } from "./IntegrationsFeishuConnect";

const managedApi = {
  agents: { list: vi.fn(async () => ({ data: [{ id: "agent-1", name: "Helpdesk" }] })) },
};
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managedApi }));

const QR = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: { url: string; init?: RequestInit }[];
let replies: Response[];

beforeEach(() => {
  calls = [];
  replies = [];
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return replies.shift() ?? json(500, {});
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Routes>
          <Route path="/integrations/feishu" element={<IntegrationsFeishuConnect />} />
          <Route path="/integrations/feishu/publish" element={<IntegrationsFeishuConnect />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );

describe("IntegrationsFeishuConnect", () => {
  it("starts a registration for the chosen Agent, shows the QR code and follows it to done", async () => {
    replies.push(
      json(201, {
        id: "reg_1",
        status: { status: "pending", url: "https://open.feishu.cn/x?user_code=UC", qrSvg: QR, expiresAt: "2026-01-01T00:00:00Z" },
      }),
      json(200, { status: "registered", appId: "cli_new", brand: "feishu" }),
      json(200, { status: "registered", appId: "cli_new", brand: "feishu", setup: { ready: false, problems: ["Publish the app version"] } }),
    );
    open("/integrations/feishu/publish?agent_id=agent-1");
    expect(await screen.findByText("Helpdesk")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show QR code" }));
    const qr = await screen.findByRole("img", { name: "QR code to scan with Feishu" });
    // An image, never inline markup: the SVG cannot run script.
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;/);
    expect(document.querySelector("script")).toBeNull();
    expect(calls[0]?.url).toBe("/matter/connect/feishu/registrations");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ agentId: "agent-1" });
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(screen.getByRole("button", { name: "Show a new QR code" })).toBeDisabled();

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByText("Checking the app's setup…")).toBeInTheDocument();
    expect(calls[1]?.url).toBe("/matter/connect/feishu/registrations/reg_1");

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByText("Publish the app version")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(calls).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Show a new QR code" })).toBeEnabled();
  });

  it("needs an Agent before it starts", async () => {
    open("/integrations/feishu");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("button", { name: "Show QR code" })).toBeDisabled();
  });

  it("explains a deployment without Matter", async () => {
    replies.push(json(404, { error: "matter_not_configured" }));
    open("/integrations/feishu/publish?agent_id=agent-1");
    fireEvent.click(await screen.findByRole("button", { name: "Show QR code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("MATTER_URL is not configured");
  });

  it("tells an expired code apart from a failure", async () => {
    replies.push(json(201, { id: "reg_2", status: { status: "expired" } }));
    open("/integrations/feishu/publish?agent_id=agent-1");
    fireEvent.click(await screen.findByRole("button", { name: "Show QR code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The QR code expired");
  });
});
