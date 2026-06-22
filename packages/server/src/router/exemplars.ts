// ════════════════════════════════════════
// Router Tier Exemplars
// Labeled example prompts per tier for the semantic router. The classifier
// embeds these once (lazily) and routes an incoming query to the tier whose
// exemplar centroid it is closest to. Written for a personal-agent workload
// (messages, calendar, files, web, multi-step tasks). No proper names, no
// personal data — generic phrasing only.
// ════════════════════════════════════════

export type Tier = 'light' | 'standard' | 'heavy';

// light: quick, factual, conversational, or trivially mechanical. A small model
// handles these perfectly.
const LIGHT: string[] = [
  'hey, you around?',
  'good morning',
  'thanks, appreciate it',
  'yes, go ahead',
  'no, cancel that',
  "what's on my calendar today?",
  "what's my next meeting?",
  'what time is it in Tokyo right now?',
  "what's 15 percent of 240?",
  'convert 5 miles to kilometers',
  "how do you spell 'necessary'?",
  "what's the capital of Australia?",
  "what's the weather looking like tomorrow?",
  "translate 'good morning' to Spanish",
  'did that email send?',
  'list my unread messages',
  'remind me what this meeting is about',
  'give me a one word answer: is the store open?',
];

// standard: a single focused task or a moderate question. Needs a competent
// model but not deep reasoning or multi-step orchestration.
const STANDARD: string[] = [
  'draft a polite reply to this email declining the meeting',
  'summarize this article in a few bullet points',
  'write a short thank-you note to a coworker',
  'fix the typos in this paragraph and tidy up the grammar',
  'schedule a 30 minute call with the team next Tuesday afternoon',
  'find me three restaurants nearby with good reviews',
  'rewrite this message to sound more professional',
  'explain what an API is in simple terms',
  'explain how OAuth works at a high level',
  'walk me through what a webhook is in plain language',
  'turn these notes into a clean to-do list',
  'what are the pros and cons of taking the train versus driving?',
  'draft a short agenda for tomorrow morning',
  'look up the return policy for this store and tell me the deadline',
  'compare these two phone plans and tell me which is cheaper',
  'write a caption for this photo',
  'help me reword this message about the broken faucet',
  'give me a quick summary of what I missed in this thread',
];

// heavy: multi-step builds, debugging, architecture, planning with constraints,
// research-and-synthesize. Genuinely needs the strongest model.
const HEAVY: string[] = [
  'build a script that pulls my unread emails, groups them by sender, and drafts replies to the urgent ones',
  'debug why this function returns undefined for an empty array and walk me through the fix',
  'plan a three day trip with a budget, a daily itinerary, and restaurant reservations',
  'design the database schema for a small inventory system with suppliers, products, and orders, and explain the tradeoffs',
  'analyze last quarter spending across these categories, find where I overspent, and propose a budget',
  'refactor this module to remove the duplicated logic and add error handling, then explain what changed',
  'research the best way to migrate this app from REST to GraphQL and lay out a step by step plan',
  'set up a project that watches my inbox, flags anything from these clients, notifies me, and keeps running',
  'write a proposal comparing three vendors against our requirements and recommend one with justification',
  'go through this codebase, find the security issues, and prioritize them by severity with fixes',
  'create a product launch plan with a timeline, channels, budget, and success metrics',
  'implement a rate limiter with a sliding window, handle the edge cases, and add tests',
  'trace why the deployment is failing, check the logs, identify the root cause, and propose a fix',
  'compare these architectural approaches for the new service, weigh the tradeoffs, and recommend one',
  'review this contract, flag the risky clauses, and explain why each one is a concern',
  'build a workflow that scrapes these sources, dedupes the results, and produces a weekly report',
];

export const EXEMPLARS: Record<Tier, string[]> = {
  light: LIGHT,
  standard: STANDARD,
  heavy: HEAVY,
};

export const TIERS: Tier[] = ['light', 'standard', 'heavy'];
