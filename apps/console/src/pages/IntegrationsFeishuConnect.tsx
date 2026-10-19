import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "../i18n";
import { getActiveTenantId } from "../lib/api";
import { useManagedApi } from "../lib/useManagedApi";

/**
 * Connect Feishu: scan a QR code to create a self-built Feishu app that
 * answers as the chosen Agent. The control plane proxies `/matter/*` to the
 * OpenMatter service (apps/matter), which runs the registration and keeps
 * the app secret; the browser only ever sees the QR code and the status.
 */

const BASE = "/matter/connect/feishu";
const POLL_MS = 3000;

type ConnectStatus =
  | { status: "pending"; url: string; qrSvg: string; expiresAt: string }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "failed"; reason: string }
  | {
      status: "registered";
      appId: string;
      brand: string;
      setup?: { ready: boolean; problems: string[] };
      setupUnavailable?: true;
    };

/** Settled: nothing more will change without the user starting over. */
const settled = (s: ConnectStatus) =>
  s.status !== "pending" && !(s.status === "registered" && !s.setup && !s.setupUnavailable);

class MatterError extends Error {
  constructor(readonly status: number, readonly code: string | undefined) {
    super(code ?? `HTTP ${status}`);
  }
}

async function matter<T>(path: string, init?: RequestInit): Promise<T> {
  const tenant = getActiveTenantId();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(tenant ? { "x-active-tenant": tenant } : {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new MatterError(res.status, typeof body.error === "string" ? body.error : undefined);
  }
  return (await res.json()) as T;
}

/** The QR code as an image, so markup in the SVG can never run. */
const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function IntegrationsFeishuConnect() {
  const { t } = useI18n();
  const m = t.feishuConnect;
  const managedApi = useManagedApi();
  const [params] = useSearchParams();
  const [agents, setAgents] = useState<{ id: string; name: string }[] | null>(null);
  const [agentId, setAgentId] = useState(params.get("agent_id") ?? "");
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    managedApi.agents
      .list({ limit: 200 })
      .then((r) => {
        if (live) setAgents(r.data.map((a) => ({ id: a.id, name: a.name || a.id })));
      })
      .catch(() => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [managedApi]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const describe = useCallback(
    (err: unknown) =>
      err instanceof MatterError && err.code === "matter_not_configured"
        ? m.notConfigured
        : err instanceof MatterError && err.status === 502
          ? m.unavailable
          : m.startFailed,
    [m],
  );

  const poll = useCallback(
    (id: string) => {
      timer.current = setTimeout(async () => {
        try {
          const next = await matter<ConnectStatus>(`/registrations/${encodeURIComponent(id)}`);
          setStatus(next);
          if (!settled(next)) poll(id);
        } catch {
          setError(m.statusFailed);
        }
      }, POLL_MS);
    },
    [m],
  );

  async function start() {
    clearTimeout(timer.current);
    setStarting(true);
    setError(null);
    setStatus(null);
    try {
      const { id, status: first } = await matter<{ id: string; status: ConnectStatus }>(
        "/registrations",
        { method: "POST", body: JSON.stringify({ agentId }) },
      );
      setStatus(first);
      if (!settled(first)) poll(id);
    } catch (err) {
      setError(describe(err));
    } finally {
      setStarting(false);
    }
  }

  const busy = starting || status?.status === "pending";

  return (
    <div className="console-integration-route">
      <div className="console-integration-page">
        <header className="mb-8">
          <h1 className="font-display text-xl leading-tight font-semibold tracking-tight text-fg">
            {m.title}
          </h1>
          <p className="mt-1.5 text-base text-fg-muted max-w-xl">{m.intro}</p>
        </header>

        <section className="max-w-md space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="feishu-connect-agent">{m.agent}</Label>
            <Select value={agentId} onValueChange={setAgentId} disabled={busy}>
              <SelectTrigger id="feishu-connect-agent" aria-label={m.agent} className="w-full">
                <SelectValue placeholder={agents === null ? t.common.loading : m.chooseAgent} />
              </SelectTrigger>
              <SelectContent>
                {(agents ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agents !== null && agents.length === 0 && (
              <p className="text-sm text-fg-muted">{m.noAgents}</p>
            )}
          </div>

          <Button onClick={() => void start()} disabled={agentId === "" || busy}>
            {starting ? m.starting : status === null ? m.start : m.restart}
          </Button>

          {error && (
            <div role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          {status?.status === "pending" && (
            <div className="space-y-3">
              <img
                src={svgDataUrl(status.qrSvg)}
                alt={m.qrAlt}
                width={224}
                height={224}
                className="rounded-md border border-border bg-white p-2"
              />
              <p className="text-sm">
                <a href={status.url} target="_blank" rel="noopener noreferrer" className="text-brand underline">
                  {m.openIn}
                </a>
              </p>
              <p className="text-sm text-fg-muted">{m.waiting}</p>
            </div>
          )}

          {status?.status === "registered" && (
            <div className="space-y-2 text-sm">
              <p className="text-fg">
                {m.created} <code>{status.appId}</code>
              </p>
              {status.setupUnavailable ? (
                <p className="text-fg-muted">{m.checkUnavailable}</p>
              ) : !status.setup ? (
                <p className="text-fg-muted">{m.checking}</p>
              ) : status.setup.ready ? (
                <p className="text-fg">{m.ready}</p>
              ) : (
                <>
                  <p className="text-fg">{m.fixes}</p>
                  <ul className="list-disc pl-5 text-fg-muted">
                    {status.setup.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {(status?.status === "expired" || status?.status === "denied" || status?.status === "failed") && (
            <p role="alert" className="text-sm text-danger">
              {status.status === "failed" ? status.reason || m.failed : m[status.status]}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
