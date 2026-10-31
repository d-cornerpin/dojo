// The Healer report's per-check size cap, and the visible line that says what it left out.
import { createLogger } from '../logger.js';

const logger = createLogger('healer-item-cap');

export interface DiagnosticItem {
  severity: 'critical' | 'warning' | 'info';
  code: string;
  title: string;
  detail: string;
  agentId?: string;
  agentName?: string;
}

/**
 * Cap the rendered text at `maxChars`; critical items are never dropped (their length still counts),
 * so the lower severities of that check go first.
 */
export function capItemsByText(
  items: DiagnosticItem[],
  maxChars: number,
  collectorLabel: string,
): DiagnosticItem[] {
  const renderLength = (xs: DiagnosticItem[]): number =>
    xs.reduce((sum, i) => sum + i.title.length + i.detail.length + 12, 0);

  if (renderLength(items) <= maxChars) return items;

  // Sort: keep critical, then warning, then info. Truncate from the tail.
  const sevOrder: Record<DiagnosticItem['severity'], number> = {
    critical: 0, warning: 1, info: 2,
  };
  const sorted = [...items].sort(
    (a, b) => sevOrder[a.severity] - sevOrder[b.severity],
  );

  const kept: DiagnosticItem[] = [];
  let len = 0;
  let dropped = 0;
  for (const item of sorted) {
    const itemLen = item.title.length + item.detail.length + 12;
    if (item.severity === 'critical' || len + itemLen <= maxChars) {
      kept.push(item);
      len += itemLen;
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    logger.warn('Diagnostic collector cap fired — dropping low-severity items', {
      collector: collectorLabel,
      total: items.length,
      kept: kept.length,
      dropped,
      maxChars,
    });
  }

  return kept;
}

/**
 * `capItemsByText` plus one visible line when it left items out, so the report never drops items
 * silently (R25): the person reading it sees "N more were left out" for that check.
 */
export function capItemsShowingOmissions(
  items: DiagnosticItem[],
  maxChars: number,
  collectorLabel: string,
): DiagnosticItem[] {
  const kept = capItemsByText(items, maxChars, collectorLabel);
  const omitted = items.length - kept.length;
  if (omitted <= 0) return kept;
  return [...kept, {
    severity: 'info',
    code: 'items_left_out',
    title: `${omitted} more ${omitted === 1 ? 'item was' : 'items were'} left out of the ${collectorLabel.replace(/_/g, ' ')} check`,
    detail: `The ${collectorLabel.replace(/_/g, ' ')} check found ${items.length} items; the report had room for ${kept.length}. The ${omitted} left out are the lower-priority ones.`,
  }];
}

