import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { buildUrl, useApiQuery, useOmaInfiniteApiQuery } from "../lib/useApiQuery";
import { useApi } from "../lib/api";
import { formatCompact, isoAdd, isoDiff, isoToday, shortenId } from "../lib/format";
import { useI18n } from "../i18n";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { RANGE_PRESETS, UsageRangeControls } from "../components/UsageRangeControls";
import { Select, SelectOption } from "../components/Select";

/**
 * Ledger — the itemized 流水, one level below the usage dashboard
 * (linked from it with the current range carried in the URL). Readers
 * land here on demand; the dashboard stays summary-first.
 *
 * Row semantics — each row is one decision-relevant fact, and its value
 * is defined by what it answers:
 *   - model_call:  one model invocation and its full token economics —
 *                  input / cached-read / output (three prices, three
 *                  quantities; hiding the cache split hides the biggest
 *                  lever). BYOK: billed by the provider.
 *   - sandbox_active_seconds: platform-metered compute — THE billed
 *                  runtime line, with the sandbox runtime dimension.
 *   - tool_use:    behavior audit ("which tool fired") — not priced.
 *   - session_alive_seconds: activity audit ("when was the session
 *                  active") — NOT billed, which is why it groups apart
 *                  from sandbox seconds instead of hiding among them.
 *
 * The transport reuses the console's existing OMA cursor envelope
 * (data/next_cursor/total); the design note's richer LedgerPage fields
 * (completeness, projection lag) arrive with the real endpoint.
 * Further demo-only divergence from the contract rows, by design:
 * per-row `unit` and `agent_name` travel inline (v3 serves them via
 * listKinds + a display join), and `q` is a demo-only session-id
 * substring search.
 */

const MAX_SPAN_DAYS = 90;

interface LedgerRow {
  id: number;
  ts: string;
  session_id: string;
  agent_id: string;
  agent_name: string;
  kind:
    | "model_call"
    | "sandbox_active_seconds"
    | "session_alive_seconds"
    | "tool_use";
  value: number;
  unit: "s" | "call";
  input_tokens?: number;
  cached_read_tokens?: number;
  output_tokens?: number;
  model_id?: string;
  tool_name?: string;
  runtime_id?: string;
}

// Groups follow billing semantics, not measurement shape: sandbox time
// (billed) and session time (unbilled activity) never share a group.
// Each group is 1:1 with exactly one contract kind, so the wire param
// carries the exact kind — the group vocabulary is UI-only.
const LEDGER_GROUPS = ["all", "model_calls", "sandbox", "tools", "sessions"] as const;
type LedgerGroup = (typeof LEDGER_GROUPS)[number];
const GROUP_KIND: Record<LedgerGroup, string | undefined> = {
  all: undefined,
  model_calls: "model_call",
  sandbox: "sandbox_active_seconds",
  tools: "tool_use",
  sessions: "session_alive_seconds",
};

export function UsageLedger() {
  const { t } = useI18n();
  const { api } = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [group, setGroup] = useState<LedgerGroup>(
    () => (searchParams.get("kind") as LedgerGroup) || "all",
  );
  const [agentId, setAgentId] = useState(() => searchParams.get("agent_id") ?? undefined);
  const [modelId, setModelId] = useState(() => searchParams.get("model_id") ?? undefined);
  const [runtimeId, setRuntimeId] = useState(() => searchParams.get("runtime_id") ?? undefined);
  const [qInput, setQInput] = useState(() => searchParams.get("q") ?? "");
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [exporting, setExporting] = useState(false);

  // Range arrives from the dashboard link (?from=&to=) and stays in the
  // URL so a filtered ledger view is shareable.
  const [from, setFrom] = useState(() => {
    const p = searchParams.get("from");
    return p && /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : isoAdd(isoToday(), -13);
  });
  const [to, setTo] = useState(() => {
    const p = searchParams.get("to");
    return p && /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : isoToday();
  });

  // Every filter lives in the URL — a filtered ledger view is a
  // shareable link.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        prev.set("from", from);
        prev.set("to", to);
        const dims: Array<[string, string | undefined]> = [
          ["kind", group === "all" ? undefined : group],
          ["agent_id", agentId],
          ["model_id", modelId],
          ["runtime_id", runtimeId],
          ["q", q || undefined],
        ];
        for (const [k, v] of dims) {
          if (v) prev.set(k, v);
          else prev.delete(k);
        }
        return prev;
      },
      { replace: true },
    );
  }, [from, to, group, agentId, modelId, runtimeId, q, setSearchParams]);

  const span = Math.min(isoDiff(from, to) + 1, MAX_SPAN_DAYS);
  const activePreset =
    span <= 30 && isoAdd(from, span - 1) >= isoToday()
      ? (RANGE_PRESETS.find((p) => p === span) ?? null)
      : null;

  // Debounce the search box so typing doesn't refetch per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(id);
  }, [qInput]);

  const params = useMemo(
    () => ({
      from,
      to,
      kind: GROUP_KIND[group],
      agent_id: agentId,
      model_id: modelId,
      runtime_id: runtimeId,
      q: q || undefined,
    }),
    [from, to, group, agentId, modelId, runtimeId, q],
  );
  // Filter options are data-driven from the same rollup the dashboard
  // reads — agents, models, and sandbox runtimes in the current range.
  const optionsQuery = useApiQuery<{
    by_agent: Array<{ agent_id: string; agent_name: string }>;
    by_model: Array<{ model_id: string }>;
    by_sandbox: Array<{ runtime_id: string; name: string }>;
  }>("/v1/oma/usage", { from, to });
  const feed = useOmaInfiniteApiQuery<LedgerRow>("/v1/oma/usage/ledger", {
    limit: 25,
    params,
  });
  // The feed contract drops the envelope's total; a tiny parallel read
  // carries it for the "loaded X of Y" footer.
  const totalQuery = useApiQuery<{ total: number }>("/v1/oma/usage/ledger", {
    ...params,
    limit: "1",
  });

  const setPreset = (days: number) => {
    setFrom(isoAdd(isoToday(), -(days - 1)));
    setTo(isoToday());
  };
  const setCustomFrom = (v: string) => {
    if (!v) return;
    setFrom(v);
    if (v > to) setTo(v);
    else if (isoDiff(v, to) >= MAX_SPAN_DAYS)
      setTo(isoAdd(v, MAX_SPAN_DAYS - 1));
  };
  const setCustomTo = (v: string) => {
    if (!v) return;
    setTo(v);
    if (v < from) setFrom(v);
    else if (isoDiff(from, v) >= MAX_SPAN_DAYS)
      setFrom(isoAdd(v, -(MAX_SPAN_DAYS - 1)));
  };

  const kindLabel = (k: LedgerRow["kind"]) => {
    switch (k) {
      case "model_call":
        return t.usage.kindModelCall;
      case "sandbox_active_seconds":
        return t.usage.kindSandboxActive;
      case "session_alive_seconds":
        return t.usage.kindSessionAlive;
      default:
        return t.usage.kindToolUse;
    }
  };
  const detailOf = (r: LedgerRow) =>
    r.model_id ?? r.tool_name ?? r.runtime_id ?? "—";

  /** One model call = one row = the full token economics of that call. */
  const valueCell = (r: LedgerRow) => {
    if (r.kind === "model_call") {
      return (
        <span className="whitespace-nowrap">
          {t.usage.legendInput}{" "}
          <span className="text-fg">{formatCompact(r.input_tokens ?? 0)}</span>
          <span className="text-fg-subtle"> · {t.usage.cachedShort} </span>
          <span className="text-fg">{formatCompact(r.cached_read_tokens ?? 0)}</span>
          <span className="text-fg-subtle"> · {t.usage.legendOutput} </span>
          <span className="text-fg">{formatCompact(r.output_tokens ?? 0)}</span>
        </span>
      );
    }
    return (
      <span className="whitespace-nowrap">
        {r.value.toLocaleString()}{" "}
        <span className="text-fg-subtle">{r.unit}</span>
      </span>
    );
  };

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await api<{ data: LedgerRow[] }>(
        buildUrl("/v1/oma/usage/ledger", params, { limit: "5000" }),
      );
      const header =
        "time,kind,session,agent,detail,input_tokens,cached_read_tokens,output_tokens,value,unit";
      const body = res.data
        .map((r) =>
          [
            r.ts,
            r.kind,
            r.session_id,
            r.agent_name,
            detailOf(r),
            r.input_tokens ?? "",
            r.cached_read_tokens ?? "",
            r.output_tokens ?? "",
            r.value,
            r.unit,
          ]
            // Quote every field so any future comma-bearing value
            // (agent names, tool args) can't split columns.
            .map((field) => `"${String(field).replaceAll('"', '""')}"`)
            .join(","),
        )
        .join("\n");
      // BOM so Excel opens UTF-8 agent names correctly.
      const blob = new Blob([`﻿${header}\n${body}`], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `usage-ledger_${from}_${to}${group === "all" ? "" : `_${group}`}.csv`;
      // Anchor to the DOM for older Safari, which ignores clicks on
      // detached links.
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const total = totalQuery.data?.total;
      if (res.data.length >= 5000 && total !== undefined && total > 5000) {
        toast.warning(
          `${t.usage.exportCapPrefix}${total.toLocaleString()}${t.usage.exportCapSuffix}`,
        );
      } else {
        toast.success(
          `${t.usage.exportDonePrefix}${res.data.length.toLocaleString()}${t.usage.exportDoneSuffix}`,
        );
      }
    } catch {
      toast.error(t.usage.loadFailed);
    } finally {
      setExporting(false);
    }
  }

  const groupLabels: Record<LedgerGroup, string> = {
    all: t.usage.ledgerKindAll,
    model_calls: t.usage.ledgerKindModelCalls,
    sandbox: t.usage.ledgerKindSandbox,
    tools: t.usage.ledgerKindTools,
    sessions: t.usage.ledgerKindSessions,
  };

  return (
    <div className="flex-1 overflow-y-auto bg-bg-surface">
      <div className="mx-auto w-full max-w-[1400px] px-6 lg:px-8 py-8 space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
              {t.usage.ledgerTitle}
            </h1>
          </div>
          <UsageRangeControls
            from={from}
            to={to}
            maxTo={isoToday()}
            activePreset={activePreset}
            onPreset={setPreset}
            onFrom={setCustomFrom}
            onTo={setCustomTo}
          />
        </header>

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 sm:gap-1.5">
            <div className="flex items-center gap-1 p-1 border border-border rounded-lg bg-bg">
              {LEDGER_GROUPS.map((g) => (
                <Button
                  key={g}
                  variant="ghost"
                  size="xs"
                  aria-pressed={group === g}
                  onClick={() => setGroup(g)}
                  className={
                    group === g
                      ? "rounded-md bg-fg text-bg hover:bg-fg"
                      : "rounded-md text-fg-muted hover:bg-bg-surface/60"
                  }
                >
                  {groupLabels[g]}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={agentId ?? "all"}
                onValueChange={(v) => setAgentId(v === "all" ? undefined : v)}
                placeholder={t.usage.colAgent}
                className="w-[130px]"
                aria-label={t.usage.colAgent}
              >
                <SelectOption value="all">{t.usage.ledgerKindAll}</SelectOption>
                {(optionsQuery.data?.by_agent ?? []).map((a) => (
                  <SelectOption key={a.agent_id} value={a.agent_id}>
                    {a.agent_name}
                  </SelectOption>
                ))}
              </Select>
              <Select
                value={modelId ?? "all"}
                onValueChange={(v) => setModelId(v === "all" ? undefined : v)}
                placeholder={t.usage.filterModel}
                className="w-[150px]"
                aria-label={t.usage.filterModel}
              >
                <SelectOption value="all">{t.usage.ledgerKindAll}</SelectOption>
                {(optionsQuery.data?.by_model ?? []).map((m) => (
                  <SelectOption key={m.model_id} value={m.model_id}>
                    {m.model_id}
                  </SelectOption>
                ))}
              </Select>
              <Select
                value={runtimeId ?? "all"}
                onValueChange={(v) => setRuntimeId(v === "all" ? undefined : v)}
                placeholder={t.usage.filterSandbox}
                className="w-[130px]"
                aria-label={t.usage.filterSandbox}
              >
                <SelectOption value="all">{t.usage.ledgerKindAll}</SelectOption>
                {(optionsQuery.data?.by_sandbox ?? []).map((s) => (
                  <SelectOption key={s.runtime_id} value={s.runtime_id}>
                    {s.name}
                  </SelectOption>
                ))}
              </Select>
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder={t.usage.ledgerSearch}
                aria-label={t.usage.ledgerSearch}
                className="h-8 w-44 text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={exportCsv}
                disabled={exporting || feed.isLoading}
              >
                {exporting ? t.usage.ledgerExporting : t.usage.exportCsv}
                {totalQuery.data
                  ? ` · ${totalQuery.data.total.toLocaleString()}`
                  : ""}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            {feed.error ? (
              <div className="px-6 py-6">
                <EmptyState title={t.usage.loadFailed} body={String(feed.error)} />
              </div>
            ) : feed.isLoading ? (
              <div className="px-6 py-3 space-y-2.5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-5 w-full" rounded="sm" />
                ))}
              </div>
            ) : feed.items.length === 0 ? (
              <EmptyState title={t.usage.ledgerEmpty} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-bg-surface/40 text-fg-subtle text-[11px] uppercase tracking-[0.08em] hover:bg-bg-surface/40 border-border">
                    <TableHead className="text-left px-6 py-2.5 font-medium">{t.usage.colTime}</TableHead>
                    <TableHead className="text-left px-4 py-2.5 font-medium">{t.usage.colSession}</TableHead>
                    <TableHead className="text-left px-4 py-2.5 font-medium">{t.usage.colAgent}</TableHead>
                    <TableHead className="text-left px-4 py-2.5 font-medium">{t.usage.colKind}</TableHead>
                    <TableHead className="text-left px-4 py-2.5 font-medium">{t.usage.colDetail}</TableHead>
                    <TableHead className="text-right px-6 py-2.5 font-medium">{t.usage.colValue}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feed.items.map((r) => (
                    <TableRow
                      key={r.id}
                      className="border-border hover:bg-bg-surface/40 transition-colors"
                    >
                      <TableCell className="px-6 py-2 text-fg-muted text-[12px] tabular-nums whitespace-nowrap">
                        {r.ts.slice(0, 19).replace("T", " ")} UTC
                      </TableCell>
                      <TableCell className="px-4 py-2">
                        {/* Click drills into this session's entries via
                            the session-id search. */}
                        <Button
                          variant="ghost"
                          size="xs"
                          title={r.session_id}
                          onClick={() => {
                            setQInput(r.session_id);
                            setQ(r.session_id);
                          }}
                          className="px-1 font-mono text-[12px] text-fg-muted hover:text-brand hover:underline"
                        >
                          {shortenId(r.session_id)}
                        </Button>
                      </TableCell>
                      <TableCell className="px-4 py-2 text-fg whitespace-nowrap">{r.agent_name}</TableCell>
                      <TableCell className="px-4 py-2 text-fg-muted whitespace-nowrap">
                        {kindLabel(r.kind)}
                      </TableCell>
                      <TableCell className="px-4 py-2 text-fg-subtle font-mono text-[12px]">
                        {detailOf(r)}
                      </TableCell>
                      <TableCell className="px-6 py-2 text-right text-fg-muted tabular-nums">
                        {valueCell(r)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {feed.items.length > 0 && (
              <div className="flex items-center justify-between px-6 pt-3">
                <span className="text-[11px] text-fg-subtle">
                  {t.usage.ledgerLoadedPrefix}
                  {feed.items.length}
                  {totalQuery.data
                    ? ` / ${totalQuery.data.total.toLocaleString()}`
                    : ""}
                  {t.usage.ledgerLoadedSuffix}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={feed.loadMore}
                  disabled={!feed.hasMore || feed.isLoadingMore}
                >
                  {feed.isLoadingMore ? t.common.loadingMore : t.usage.loadMore}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
