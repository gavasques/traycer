import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { UsageMetric } from "@/lib/usage-analytics/usage-chart-data";

export interface UsageMetricToggleProps {
  readonly metric: UsageMetric;
  readonly onChange: (metric: UsageMetric) => void;
}

/**
 * What each metric is CALLED on screen, owned by the control that puts the
 * word there. Exported because a surface can have to name the selected metric
 * somewhere the toggle itself is not - the image export's subheading, whose
 * toggle sits outside the captured region - and a second copy of the wording
 * would drift from the tab the reader actually clicked.
 */
export const USAGE_METRIC_LABELS: Readonly<Record<UsageMetric, string>> = {
  cost: "Cost",
  tokens: "Tokens",
};

export function UsageMetricToggle(props: UsageMetricToggleProps): ReactNode {
  return (
    <Tabs
      value={props.metric}
      onValueChange={(value) => {
        if (value === "cost" || value === "tokens") props.onChange(value);
      }}
    >
      <TabsList aria-label="Metric">
        <TabsTrigger value="cost" data-testid="usage-metric-cost">
          {USAGE_METRIC_LABELS.cost}
        </TabsTrigger>
        <TabsTrigger value="tokens" data-testid="usage-metric-tokens">
          {USAGE_METRIC_LABELS.tokens}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
