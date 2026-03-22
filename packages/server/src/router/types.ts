// ════════════════════════════════════════
// Router Types
// ════════════════════════════════════════

export interface DimensionScore {
  dimension: string;
  raw: number;       // -1.0 to 1.0
  weight: number;    // from DB
  weighted: number;  // raw * weight
}

export interface ScoringResult {
  scores: DimensionScore[];
  rawScore: number;
  tier: 'heavy' | 'standard' | 'light';
  confidence: number;
  latencyMs: number;
}

export interface TierConfig {
  id: string;
  displayName: string;
  description: string | null;
  scoreMin: number | null;
  scoreMax: number | null;
  models: Array<{
    modelId: string;
    priority: number;
  }>;
}

export interface RouterConfig {
  tiers: TierConfig[];
  dimensions: Array<{
    id: string;
    displayName: string;
    weight: number;
    isEnabled: boolean;
  }>;
}

export interface RouterLogEntry {
  id: string;
  agentId: string;
  inputPreview: string | null;
  dimensionScores: string;
  rawScore: number;
  tierId: string;
  selectedModelId: string;
  fallbackUsed: boolean;
  latencyMs: number | null;
  createdAt: string;
}
