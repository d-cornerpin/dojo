// ════════════════════════════════════════
// Dimension-Based Query Scorer
// Zero API calls. Must complete in <10ms.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { DimensionScore, ScoringResult } from './types.js';

const logger = createLogger('scorer');

// ── Cached dimension weights ──

interface DimensionWeight {
  id: string;
  weight: number;
  isEnabled: boolean;
}

let dimensionCache: Map<string, DimensionWeight> | null = null;

function loadDimensions(): Map<string, DimensionWeight> {
  if (dimensionCache) return dimensionCache;

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, weight, is_enabled FROM router_dimensions
  `).all() as Array<{ id: string; weight: number; is_enabled: number }>;

  dimensionCache = new Map();
  for (const row of rows) {
    dimensionCache.set(row.id, {
      id: row.id,
      weight: row.weight,
      isEnabled: row.is_enabled === 1,
    });
  }

  logger.info('Loaded dimension weights', { count: dimensionCache.size });
  return dimensionCache;
}

export function clearDimensionCache(): void {
  dimensionCache = null;
}

// ── Text extraction ──
// Focus on the user's LAST message (the actual query) for scoring.
// The system prompt and older messages just add noise.

function extractScoringText(systemPrompt: string, messages: Array<{ role: string; content: string | object[] }>): string {
  // Score based on recent conversation context — not just the user's latest message.
  // Include assistant messages because the user might respond to a complex plan
  // with a simple "go for it". The assistant's plan is the real complexity indicator.
  const recent = messages.slice(-6); // last 3 exchanges
  const parts: string[] = [];
  for (const msg of recent) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          parts.push((block as { text: string }).text);
        }
        // Detect tool_use blocks — their presence means multi-step work
        if (typeof block === 'object' && block !== null && 'type' in block && (block as { type: string }).type === 'tool_use') {
          parts.push('[TOOL_CALL]');
        }
      }
    }
  }
  return parts.join('\n');
}

// Extract all text (for backward compat)
function extractText(messages: Array<{ role: string; content: string | object[] }>): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null && 'text' in block) {
          parts.push((block as { text: string }).text);
        }
      }
    }
  }
  return parts.join('\n');
}

// ── Dimension scoring functions ──
// Each returns a value from -1.0 to 1.0

function scoreTokenCount(text: string): number {
  // Score based on the user's query length ONLY (not system prompt)
  const len = text.length;
  if (len < 50) return -0.8;   // "What is 2+2?"
  if (len < 150) return -0.5;  // Short question
  if (len < 400) return -0.2;  // Medium question
  if (len < 1000) return 0.1;  // Longer request
  if (len < 3000) return 0.4;  // Complex prompt
  return 0.7;                   // Very long prompt
}

function scoreCodePresence(text: string): number {
  const codePatterns = [
    /```[\s\S]*?```/g,          // code blocks
    /function\s+\w+/g,          // function declarations
    /const\s+\w+\s*=/g,         // const assignments
    /import\s+.*from/g,         // imports
    /class\s+\w+/g,             // class declarations
    /\bif\s*\(/g,               // if statements
    /\bfor\s*\(/g,              // for loops
    /=>\s*[{(]/g,               // arrow functions
    /interface\s+\w+/g,         // TS interfaces
    /type\s+\w+\s*=/g,          // type aliases
  ];
  // Also detect code-related REQUESTS (not just code present)
  const codeRequests = /\b(write|implement|code|function|script|program|algorithm|sort|parse|refactor|debug|fix\s+the\s+bug)\b/gi;
  const langMentions = /\b(python|javascript|typescript|java|rust|go|ruby|c\+\+|swift|kotlin|sql|html|css)\b/gi;

  let matches = 0;
  for (const pattern of codePatterns) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }
  const reqMatches = (text.match(codeRequests) || []).length;
  const langMatches = (text.match(langMentions) || []).length;
  matches += reqMatches + langMatches;

  if (matches === 0) return 0.0;  // Neutral, not negative
  if (matches < 3) return 0.3;
  if (matches < 8) return 0.5;
  return 0.8;
}

function scoreReasoningMarkers(text: string): number {
  const markers = [
    /\b(analyze|evaluate|compare|contrast|assess|consider|critique|examine)\b/gi,
    /\b(trade-?off|pros?\s+and\s+cons?|advantages?\s+and\s+disadvantages?)\b/gi,
    /\b(because|therefore|consequently|however|although|whereas)\b/gi,
    /\b(explain\s+why|reason\s+for|justify|argue|debate)\b/gi,
    /\b(step\s+by\s+step|first.*then.*finally)\b/gi,
    /\b(think\s+through|work\s+through|break\s+down)\b/gi,
    /\b(implication|consequence|assumption|hypothesis)\b/gi,
    /\bvs\.?\b|\bversus\b/gi,  // comparison: "X vs Y"
    /\b(when\s+to\s+use|which\s+is\s+better|should\s+I\s+use)\b/gi,  // decision-making
  ];

  let matches = 0;
  for (const pattern of markers) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  // Each match is a strong signal — scale aggressively
  if (matches === 0) return 0.0;
  if (matches === 1) return 0.4;
  if (matches === 2) return 0.6;
  if (matches < 5) return 0.8;
  return 1.0;
}

function scoreTechnicalTerms(text: string): number {
  const terms = [
    /\b(algorithm|recursion|complexity|optimization|concurrency)\b/gi,
    /\b(architecture|microservice|database|middleware|API)\b/gi,
    /\b(kubernetes|docker|terraform|CI\/CD|deployment)\b/gi,
    /\b(encryption|authentication|authorization|JWT|OAuth)\b/gi,
    /\b(machine\s+learning|neural\s+network|gradient|tensor)\b/gi,
    /\b(async|await|promise|callback|event\s+loop)\b/gi,
    /\b(SQL|NoSQL|index|query|migration|schema)\b/gi,
    /\b(TCP|UDP|HTTP|WebSocket|REST|GraphQL)\b/gi,
  ];

  let matches = 0;
  for (const pattern of terms) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches === 0) return 0.0;
  if (matches < 3) return 0.2;
  if (matches < 8) return 0.5;
  return 0.8;
}

function scoreCreativeMarkers(text: string): number {
  const markers = [
    /\b(write|compose|create|draft|craft|design)\b/gi,
    /\b(story|poem|essay|narrative|dialogue|character)\b/gi,
    /\b(creative|imaginative|original|novel|innovative)\b/gi,
    /\b(metaphor|simile|analogy|allegory)\b/gi,
    /\b(tone|voice|style|mood|atmosphere)\b/gi,
    /\b(brainstorm|ideate|imagine|envision)\b/gi,
  ];

  let matches = 0;
  for (const pattern of markers) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches === 0) return 0.0;
  if (matches < 2) return 0.2;
  if (matches < 5) return 0.5;
  return 0.8;
}

function scoreSimpleIndicators(text: string): number {
  const simple = [
    /\b(yes\s+or\s+no|true\s+or\s+false)\b/gi,
    /\b(what\s+is|who\s+is|when\s+did|where\s+is)\b/gi,
    /\b(define|name|list|count|how\s+many)\b/gi,
    /\b(translate|convert|format|capitalize)\b/gi,
    /\b(hi|hello|hey|thanks|thank\s+you|ok|okay)\b/gi,
  ];

  let matches = 0;
  for (const pattern of simple) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  // Simple indicators push NEGATIVE (toward light tier)
  if (matches === 0) return 0.0;
  if (matches < 2) return -0.3;
  if (matches < 4) return -0.6;
  return -0.9;
}

function scoreMultiStep(text: string): number {
  const patterns = [
    /\b(step\s*\d|phase\s*\d|stage\s*\d)\b/gi,
    /\b(first|second|third|then|next|finally|after\s+that)\b/gi,
    /\b(1\.\s|2\.\s|3\.\s|4\.\s|5\.\s)/g,
    /\b(implement|build|create|set\s+up|configure|deploy)\b/gi,
    /\b(and\s+then|once\s+that|after\s+which|subsequently)\b/gi,
    /\b(multi-?step|pipeline|workflow|process)\b/gi,
  ];

  let matches = 0;
  for (const pattern of patterns) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches === 0) return 0.0;
  if (matches < 3) return 0.2;
  if (matches < 6) return 0.5;
  return 0.8;
}

function scoreQuestionComplexity(text: string): number {
  const questions = text.match(/\?/g);
  const questionCount = questions?.length ?? 0;

  // Multi-clause questions with "and", "or", "but"
  const complexQuestions = text.match(/\?[^?]*\b(and|or|but|while|if)\b[^?]*\?/gi);
  const complexCount = complexQuestions?.length ?? 0;

  // Nested/compound question words
  const compoundQWords = text.match(/\b(how\s+would|what\s+if|why\s+would|how\s+can|what\s+are\s+the\s+best)\b/gi);
  const compoundCount = compoundQWords?.length ?? 0;

  const total = questionCount + complexCount * 2 + compoundCount * 2;

  if (total === 0) return 0.0;
  if (total < 2) return 0.1;
  if (total < 5) return 0.3;
  return 0.6;
}

function scoreConstraintCount(text: string): number {
  const constraints = [
    /\b(must|should|shall|need\s+to|have\s+to|require)\b/gi,
    /\b(at\s+least|at\s+most|no\s+more\s+than|exactly|between)\b/gi,
    /\b(constraint|requirement|condition|restriction|limitation)\b/gi,
    /\b(do\s+not|don't|avoid|never|without|except)\b/gi,
    /\b(make\s+sure|ensure|guarantee|verify)\b/gi,
  ];

  let matches = 0;
  for (const pattern of constraints) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches === 0) return 0.0;
  if (matches < 3) return 0.2;
  if (matches < 6) return 0.4;
  return 0.7;
}

function scoreOutputFormat(text: string): number {
  const formats = [
    /\b(JSON|XML|YAML|CSV|Markdown|HTML|table)\b/gi,
    /\b(format\s+as|output\s+as|return\s+as|structured)\b/gi,
    /\b(bullet\s+points|numbered\s+list|headers|sections)\b/gi,
    /\b(template|schema|specification|blueprint)\b/gi,
  ];

  let matches = 0;
  for (const pattern of formats) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches === 0) return 0.0;
  if (matches < 2) return 0.2;
  if (matches < 4) return 0.3;
  return 0.5;
}

function scoreAgenticIndicators(text: string): number {
  const indicators = [
    /\b(spawn|create\s+agent|sub-?agent|delegate|orchestrate)\b/gi,
    /\b(monitor|watch|poll|schedule|automate)\b/gi,
    /\b(project|task|milestone|deadline|progress)\b/gi,
    /\b(coordinate|manage|oversee|supervise)\b/gi,
    /\b(file_read|file_write|exec|tool|command)\b/gi,
    /\b(research|investigate|explore|scan|search)\b/gi,
  ];

  let matches = 0;
  for (const pattern of indicators) {
    const found = text.match(pattern);
    if (found) matches += found.length;
  }

  if (matches === 0) return 0.0;
  if (matches < 3) return 0.2;
  if (matches < 6) return 0.5;
  return 0.8;
}

function scoreToolCallPresence(text: string): number {
  // If recent context includes tool calls, the agent is mid-task — needs a capable model
  const toolCalls = (text.match(/\[TOOL_CALL\]/g) ?? []).length;
  if (toolCalls === 0) return 0.0;
  if (toolCalls < 3) return 0.3;
  if (toolCalls < 6) return 0.6;
  return 0.9; // Heavy tool use — definitely needs a strong model
}

function scoreConversationMomentum(text: string, messages: Array<{ role: string; content: string | object[] }>): number {
  // If the user's latest message is very short but the conversation has been complex,
  // maintain momentum — don't drop tiers on "yes", "do it", "go ahead", etc.
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return 0.0;

  const lastUser = userMessages[userMessages.length - 1];
  const lastContent = typeof lastUser.content === 'string' ? lastUser.content : '';
  const isShortConfirmation = lastContent.length < 30 && /\b(yes|yeah|yep|go|do\s+it|go\s+for\s+it|proceed|ok|okay|sure|approved|confirmed|sounds\s+good|let'?s\s+go|go\s+ahead)\b/i.test(lastContent);

  if (!isShortConfirmation) return 0.0;

  // Short confirmation detected — check if the preceding assistant message was substantial
  const assistantMessages = messages.filter(m => m.role === 'assistant');
  if (assistantMessages.length === 0) return 0.0;

  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const assistantContent = typeof lastAssistant.content === 'string' ? lastAssistant.content : JSON.stringify(lastAssistant.content);

  // If the assistant wrote a long response (plan, code, analysis), boost the score
  if (assistantContent.length > 1000) return 0.6;
  if (assistantContent.length > 400) return 0.3;
  return 0.0;
}

function scoreVisionMultimodal(messages: Array<{ role: string; content: string | object[] }>): number {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null) {
          const blockType = (block as Record<string, unknown>).type;
          if (blockType === 'image' || blockType === 'image_url') {
            return 1.0; // Vision content always pushes to heavy
          }
        }
      }
    }
  }
  return 0.0; // No vision content — neutral, don't penalize
}

// ── Scorer map ──

const DIMENSION_SCORERS: Record<string, (text: string, systemPrompt: string, messages: Array<{ role: string; content: string | object[] }>) => number> = {
  token_count: (text) => scoreTokenCount(text),
  code_presence: (text) => scoreCodePresence(text),
  reasoning_markers: (text) => scoreReasoningMarkers(text),
  technical_terms: (text) => scoreTechnicalTerms(text),
  creative_markers: (text) => scoreCreativeMarkers(text),
  simple_indicators: (text) => scoreSimpleIndicators(text),
  multi_step: (text) => scoreMultiStep(text),
  question_complexity: (text) => scoreQuestionComplexity(text),
  constraint_count: (text) => scoreConstraintCount(text),
  output_format: (text) => scoreOutputFormat(text),
  agentic_indicators: (text) => scoreAgenticIndicators(text),
  tool_call_presence: (text) => scoreToolCallPresence(text),
  conversation_momentum: (text, _sys, messages) => scoreConversationMomentum(text, messages),
  vision_multimodal: (_text, _sys, messages) => scoreVisionMultimodal(messages),
};

// ── Sigmoid ──

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── Main scorer ──

export function scoreQuery(
  systemPrompt: string,
  messages: Array<{ role: string; content: string | object[] }>,
): ScoringResult {
  const start = performance.now();

  const dimensions = loadDimensions();
  // Score based on the user's query, NOT the system prompt or conversation history
  const text = extractScoringText(systemPrompt, messages);
  const combinedText = text; // Don't include system prompt in scoring text

  const scores: DimensionScore[] = [];
  let totalWeighted = 0;

  for (const [dimId, dimConfig] of dimensions) {
    if (!dimConfig.isEnabled) continue;

    const scorer = DIMENSION_SCORERS[dimId];
    if (!scorer) continue;

    const raw = Math.max(-1, Math.min(1, scorer(combinedText, systemPrompt, messages)));
    const weighted = raw * dimConfig.weight;

    scores.push({
      dimension: dimId,
      raw,
      weight: dimConfig.weight,
      weighted,
    });

    totalWeighted += weighted;
  }

  // Use the raw sum — tier thresholds are calibrated for un-normalized scores
  const rawScore = totalWeighted;

  // Determine tier
  let tier: 'heavy' | 'standard' | 'light';
  if (rawScore > 0.35) {
    tier = 'heavy';
  } else if (rawScore > 0.0) {
    tier = 'standard';
  } else {
    tier = 'light';
  }

  // Confidence via sigmoid
  const confidence = sigmoid(rawScore * 3);

  const latencyMs = performance.now() - start;

  if (latencyMs > 10) {
    logger.warn('Scorer exceeded 10ms target', { latencyMs: latencyMs.toFixed(2) });
  }

  return {
    scores,
    rawScore,
    tier,
    confidence,
    latencyMs,
  };
}
