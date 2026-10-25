import { useI18n } from "../i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * Shared range controls for the usage surfaces: preset chips + custom
 * from/to date inputs. Presets are relative to today; editing the dates
 * leaves preset mode, and a matching preset re-lights.
 */
export const RANGE_PRESETS = [7, 14, 30] as const;

export function UsageRangeControls({
  from,
  to,
  maxTo,
  activePreset,
  onPreset,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  maxTo: string;
  activePreset: number | null;
  onPreset: (days: number) => void;
  onFrom: (iso: string) => void;
  onTo: (iso: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 p-1 border border-border rounded-md bg-bg">
        {RANGE_PRESETS.map((p) => (
          <Button
            key={p}
            variant="ghost"
            size="xs"
            aria-pressed={activePreset === p}
            onClick={() => onPreset(p)}
            className={
              activePreset === p
                ? "rounded-md bg-brand text-brand-fg hover:bg-brand"
                : "rounded-md text-fg-muted hover:bg-bg-surface/60"
            }
          >
            {p === 7 ? t.usage.last7 : p === 14 ? t.usage.last14 : t.usage.last30}
          </Button>
        ))}
      </div>
      <Input
        type="date"
        value={from}
        max={to}
        aria-label={t.usage.from}
        onChange={(e) => onFrom(e.target.value)}
        className="h-8 w-[132px] text-xs text-fg-muted"
      />
      <span className="text-fg-subtle text-xs">–</span>
      <Input
        type="date"
        value={to}
        min={from}
        max={maxTo}
        aria-label={t.usage.to}
        onChange={(e) => onTo(e.target.value)}
        className="h-8 w-[132px] text-xs text-fg-muted"
      />
    </div>
  );
}
