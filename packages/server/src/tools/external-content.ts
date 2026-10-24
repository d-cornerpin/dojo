// ════════════════════════════════════════════════════════════════════════════
// OTHER PEOPLE'S TEXT IS INFORMATION, NOT INSTRUCTIONS (v3.5 K33) — the server's door to the fence.
//
// The fence's one definition lives in `@dojo/shared` (`external-content.ts`): `fenceExternal` is
// the only producer of its markers, and `unfenceExternal` gives the text back as it arrived for
// every place that shows it to a person, relays it, or compares it (the fence is model-facing
// only). This module re-exports them for the server's render sites, so a site imports one name
// from one place.
//
// Who calls it: the inbound channel producers at ingest (iMessage, SMS, calls, Teams, voicemail,
// the mail watchers, another agent's report to the main agent, the Dreamer's archives), and the
// ONE tool door for every read whose result carries outside text (`agent/tools/outside-content.ts`,
// a registry: registering a tool there is what fences it). Censuses:
// `tools/__tests__/every-external-render-is-fenced.test.ts`.
// ════════════════════════════════════════════════════════════════════════════

export { fenceExternal, unfenceExternal, defangExternalMarkers, EXTERNAL_KINDS, type ExternalKind } from '@dojo/shared';
