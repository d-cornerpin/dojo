import { getThresholdColor } from '../lib/theme';

interface BarChartItem {
  label: string;
  value: number;
  color?: string;
}

interface BarChartProps {
  data: BarChartItem[];
  maxValue?: number;
  formatValue?: (v: number) => string;
}

export const BarChart = ({ data, maxValue, formatValue }: BarChartProps) => {
  if (data.length === 0) {
    return <p className="text-sm white/30">No data</p>;
  }

  const safeData = data.map(d => ({ ...d, value: d.value ?? 0 }));
  const max = maxValue ?? Math.max(...safeData.map(d => d.value), 1);
  const fmt = formatValue ?? ((v: number) => `$${(v ?? 0).toFixed(2)}`);

  return (
    <div className="space-y-2">
      {safeData.map((item) => {
        const pct = max > 0 ? Math.min((item.value / max) * 100, 100) : 0;
        return (
          <div key={item.label} className="flex items-center gap-3">
            <span className="text-xs white/55 w-28 truncate text-right" title={item.label}>
              {item.label}
            </span>
            <div className="flex-1 bg-white/[0.05] rounded-full h-5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(pct, 1)}%`,
                  backgroundColor: item.color || '#3b82f6',
                }}
              />
            </div>
            <span className="text-xs white/70 w-20 text-right font-mono">
              {fmt(item.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
};

interface PercentageBarProps {
  value: number;
  max: number;
  color?: string;
  showLabel?: boolean;
}

export const PercentageBar = ({ value, max, color, showLabel = true }: PercentageBarProps) => {
  const safeValue = value ?? 0;
  const safeMax = max ?? 100;
  const pct = safeMax > 0 ? Math.min((safeValue / safeMax) * 100, 100) : 0;

  const autoColor = color || getThresholdColor(pct);

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-white/[0.05] rounded-full h-3 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${Math.max(pct, 0)}%`,
            backgroundColor: autoColor,
          }}
        />
      </div>
      {showLabel && (
        <span className="text-xs white/55 w-10 text-right">
          {pct.toFixed(0)}%
        </span>
      )}
    </div>
  );
};
