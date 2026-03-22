// ════════════════════════════════════════
// Vault Extraction: Knowledge extraction from archived conversations
// Called during the dreaming cycle
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { callModel } from '../agent/model.js';
import { createEntry, type VaultEntry } from './store.js';

const logger = createLogger('vault-extraction');

// ── Types ──

interface ExtractedMemory {
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  is_permanent?: boolean;
}

interface TechniqueCandidate {
  name: string;
  display_name: string;
  description: string;
  instructions: string;
  tags: string[];
}

export interface ExtractionResult {
  memories: ExtractedMemory[];
  techniqueCandidates: TechniqueCandidate[];
  summary: string;
}

// ── Extraction Prompt ──

const EXTRACTION_PROMPT = `You are the dreaming engine for an AI agent dojo. You are processing a day's conversations to form long-term memories and identify reusable skills.

Given the following conversation, do TWO things:

1. EXTRACT MEMORIES: Pull out every piece of distinct knowledge worth remembering permanently.
2. IDENTIFY TECHNIQUES: If the conversation contains a reusable procedure, workflow, or skill that agents might need again, flag it as a technique candidate.

For each MEMORY, output:
{
  "type": "fact" | "preference" | "decision" | "procedure" | "relationship" | "event" | "note",
  "content": "The knowledge, written as a standalone statement (max 500 tokens)",
  "tags": ["relevant", "tags"],
  "confidence": 0.0-1.0 (1.0 = explicitly stated, 0.8 = strongly implied, 0.5 = inferred),
  "is_permanent": true/false (true for definitionally stable facts like names, relationships, birth dates)
}

For each TECHNIQUE CANDIDATE, output:
{
  "name": "short-slug-name",
  "display_name": "Human Readable Name",
  "description": "What this technique does",
  "instructions": "Step-by-step instructions another agent could follow to execute this technique",
  "tags": ["relevant", "tags"]
}

MEMORY rules:
- Extract EVERY specific fact, preference, decision, and event
- Write each entry as a standalone statement (someone reading it with no context should understand it)
- Include WHO said/decided/prefers things
- For decisions, include WHY the decision was made
- For events, include WHEN they happened
- For procedures that are SHORT (a few steps), save as a memory
- For procedures that are LONG or COMPLEX, flag as a technique candidate instead
- Do NOT extract routine tool call mechanics (e.g., "ran grep on file X")
- Do NOT extract transient debugging state ("I'm trying X next..." unless it led to a decision)
- Do NOT extract small talk with no informational value
- DO extract corrections the user made -- these are high-value preferences
- DO extract anything the user explicitly asked to remember
- Mark definitionally stable facts as is_permanent: true (family members, business names, birth dates, locations)

TECHNIQUE rules:
- Only flag something as a technique if it's a REUSABLE multi-step process
- The agent figured out how to do something non-obvious that other agents would benefit from knowing
- Simple one-off commands are NOT techniques -- those are memories
- The instructions should be detailed enough for another agent to follow without additional context

Output ONLY valid JSON in this format:
{
  "memories": [ ...array of memory objects... ],
  "technique_candidates": [ ...array of technique objects, can be empty... ],
  "summary": "Brief 2-3 sentence summary of what this conversation was about"
}`;

const LIGHT_EXTRACTION_PROMPT = `You are a knowledge extraction engine for an AI agent's long-term memory.
Given the following conversation, extract every piece of distinct knowledge worth remembering permanently.

For each piece of knowledge, output a JSON object:
{
  "type": "fact" | "preference" | "decision" | "procedure" | "relationship" | "event" | "note",
  "content": "The actual knowledge, written as a standalone statement that makes sense without context (max 500 tokens)",
  "tags": ["relevant", "tags"],
  "confidence": 0.0-1.0 (1.0 = explicitly stated, 0.8 = strongly implied, 0.5 = inferred),
  "is_permanent": true/false (true for definitionally stable facts like names, relationships, birth dates)
}

Rules:
- Extract EVERY specific fact, preference, decision, and event
- Write each entry as a standalone statement
- Include WHO said/decided/prefers things
- For decisions, include WHY the decision was made
- For events, include WHEN they happened
- Do NOT extract routine tool call mechanics
- Do NOT extract transient debugging state
- Do NOT extract small talk with no informational value
- DO extract corrections the user made
- DO extract anything the user explicitly asked to remember
- Mark definitionally stable facts as is_permanent: true

Output ONLY valid JSON:
{
  "memories": [ ...array of memory objects... ],
  "technique_candidates": [],
  "summary": "Brief 2-3 sentence summary"
}`;

// ── Extract from Conversation ──

export async function extractFromConversation(
  conversationMessages: string,
  modelId: string,
  dreamMode: 'full' | 'light',
): Promise<ExtractionResult> {
  const prompt = dreamMode === 'full' ? EXTRACTION_PROMPT : LIGHT_EXTRACTION_PROMPT;

  const result = await callModel({
    agentId: 'system',
    modelId,
    messages: [{ role: 'user', content: conversationMessages }],
    systemPrompt: prompt,
    tools: false,
  });

  // Parse the JSON response
  const parsed = parseExtractionResponse(result.content);
  return parsed;
}

function parseExtractionResponse(content: string): ExtractionResult {
  // Try to find JSON in the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('No JSON found in extraction response');
    return { memories: [], techniqueCandidates: [], summary: '' };
  }

  try {
    const data = JSON.parse(jsonMatch[0]);
    const validTypes = ['fact', 'preference', 'decision', 'procedure', 'relationship', 'event', 'note'];

    const memories: ExtractedMemory[] = (data.memories ?? [])
      .filter((m: ExtractedMemory) => m.content && validTypes.includes(m.type))
      .map((m: ExtractedMemory) => ({
        type: m.type,
        content: String(m.content),
        tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
        confidence: typeof m.confidence === 'number' ? Math.max(0, Math.min(1, m.confidence)) : 1.0,
        is_permanent: m.is_permanent === true,
      }));

    const techniqueCandidates: TechniqueCandidate[] = (data.technique_candidates ?? [])
      .filter((t: TechniqueCandidate) => t.name && t.instructions)
      .map((t: TechniqueCandidate) => ({
        name: String(t.name),
        display_name: String(t.display_name ?? t.name),
        description: String(t.description ?? ''),
        instructions: String(t.instructions),
        tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
      }));

    return {
      memories,
      techniqueCandidates,
      summary: String(data.summary ?? ''),
    };
  } catch (err) {
    logger.error('Failed to parse extraction response', {
      error: err instanceof Error ? err.message : String(err),
      responsePreview: content.slice(0, 500),
    });
    return { memories: [], techniqueCandidates: [], summary: '' };
  }
}

// ── Store Extracted Memories ──

export async function storeExtractedMemories(
  memories: ExtractedMemory[],
  agentId: string,
  agentName: string | null,
  sourceConversationId: string,
): Promise<number> {
  let stored = 0;

  for (const memory of memories) {
    try {
      await createEntry({
        agentId,
        agentName: agentName ?? undefined,
        type: memory.type,
        content: memory.content,
        confidence: memory.confidence,
        isPermanent: memory.is_permanent,
        tags: memory.tags,
        sourceConversationId,
        source: 'extraction',
      });
      stored++;
    } catch (err) {
      logger.warn('Failed to store extracted memory', {
        error: err instanceof Error ? err.message : String(err),
        content: memory.content.slice(0, 100),
      });
    }
  }

  return stored;
}
