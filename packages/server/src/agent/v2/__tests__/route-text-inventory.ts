// ════════════════════════════════════════════════════════════════════════════════════════
// THE ROUTE-TEXT INVENTORY (3.5, "who am I sending to", Task 6)
//
// Every engine-written text in the conversation engine that names the person being spoken to,
// or a reply route ("the dashboard chat", "in this conversation", "the owner's channel"), is
// one of three things:
//   * the address renderer itself and the fallbacks of address-aware texts   -> ALLOW
//   * a text that is correct as it is (describes a tool, the owner as the ACTOR, a PM)   -> ALLOW
//   * a text that still says "the user" / names a route as a literal   -> SWEEP (to be reworded)
//
// SWEEP entries are mechanical: `old` is the exact trimmed source line, `new` is the exact
// replacement line, `how` says where the address comes from and what to import. When a line has
// been swept its `old` is gone from the file; the matching `it.fails` case then starts to fail,
// which is the signal to delete that entry from SWEEP. The census test in
// `engine-texts-never-name-a-route-on-their-own.test.ts` fails on any NEW unlisted site.
//
// Generated from the sources at the time of writing; lines are matched by text, not by number,
// so unrelated edits above a site do not disturb it.
// ════════════════════════════════════════════════════════════════════════════════════════

export interface SweepEntry { readonly id: string; readonly file: string; readonly line: number; readonly old: string; readonly new: string; readonly how: string }
export interface AllowEntry { readonly file: string; readonly line: string; readonly reason: string }

export const SWEEP: readonly SweepEntry[] = [
 {
  "id": "S001",
  "file": "agent/a2a-transport.ts",
  "line": 863,
  "old": "threadInfo = `\\n\\n[Thread ${threadShort} | Closed, this is a ${verb} report on work you initiated. Do whatever the workflow requires next (forward to another agent, notify the user, update tracker, decide a next step). If nothing further is needed, just end your turn. To restart a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;",
  "new": "threadInfo = `\\n\\n[Thread ${threadShort} | Closed, this is a ${verb} report on work you initiated. Do whatever the workflow requires next (forward to another agent, notify the owner, update tracker, decide a next step). If nothing further is needed, just end your turn. To restart a new conversation with the sender, omit thread_id and pick QUESTION/ASSIGN/BLOCK.]`;",
  "how": "static: these A2A ambient-thread notes reach an agent with no human on the other end; the person who matters is the owner"
 },
 {
  "id": "S002",
  "file": "agent/a2a-transport.ts",
  "line": 870,
  "old": "threadInfo = `\\n\\n[Thread ${threadShort} | No reply expected on this thread. Ambient context, the sender used a no-wake intent (${effectiveIntent}). If the content is something the user should know about, take action next time you wake (e.g. iMessage them).]`;",
  "new": "threadInfo = `\\n\\n[Thread ${threadShort} | No reply expected on this thread. Ambient context, the sender used a no-wake intent (${effectiveIntent}). If the content is something the owner should know about, take action next time you wake (e.g. iMessage them).]`;",
  "how": "static: these A2A ambient-thread notes reach an agent with no human on the other end; the person who matters is the owner"
 },
 {
  "id": "S003",
  "file": "agent/a2a-transport.ts",
  "line": 1779,
  "old": "`${JOIN_STEER_LABEL} A piece of work you delegated never came back: ${what} The platform has told the `",
  "new": "`${JOIN_STEER_LABEL} A piece of work you delegated never came back: ${what} The platform has told `",
  "how": "drop the trailing word `the ` so the next line's ${askerWords} reads `told the owner` / `told Pat Example` (askerWords already carries its own `the`)"
 },
 {
  "id": "S004",
  "file": "agent/a2a-transport.ts",
  "line": 1781,
  "old": "+ `user that plainly, in its own voice, so they are not left waiting. If the user should `",
  "new": "+ `${askerWords} that plainly, in its own voice, so they are not left waiting. If ${askerWords} should `",
  "how": "in tellAgentTheJoinFailed(join, what), first line: const askerWords = compileAskerFromMeta(askRowForJoin(join)?.inbound_meta ?? null, (ch, handle) => resolveRecipientDisplay(ch as ChannelKind, handle), (ch) => deliveryLabel(ch as ReplyDestination))?.name ?? 'the owner'; (the line above this one, `told the`, stays). The previous line ends `The platform has told the ` so the sentence reads `told the <askerWords>`: drop the word `the` there only when askerWords is a name, i.e. build the phrase as: askerWords === 'the owner' ? 'the owner' : askerWords and write `told ${askerWords}` (drop the hard `the `)"
 },
 {
  "id": "S005",
  "file": "agent/a2a-transport.ts",
  "line": 1783,
  "old": "+ `your own words on your next turn, directly in the conversation.`,",
  "new": "+ `your own words on your next turn, as your written reply if that turn is talking to them, otherwise in an explicit send that names them.`,",
  "how": "same function; no address needed (the next turn's own block names who it is talking to)"
 },
 {
  "id": "S006",
  "file": "agent/a2a-transport.ts",
  "line": 2452,
  "old": "+ `came back. TELL THE OWNER NOW, in your own words, directly in this conversation: what you asked for, `",
  "new": "+ `came back. TELL ${askerWords.toUpperCase()} NOW, in your own words, as your written reply: what you asked for, `",
  "how": "in steerAgentToTellOwnerStuck(join, rung): add as first statement const askerWords = (same expression as above); also change the line above `+ `The owner is still waiting on the request you delegated, ...` so `The owner` becomes `${askerWords}` (capitalised first letter if it is a sentence start: use askerWords === 'the owner' ? 'The owner' : askerWords)"
 },
 {
  "id": "S007",
  "file": "agent/runtime.ts",
  "line": 151,
  "old": "'Describe this image in detail for an assistant who cannot see it but will use your description to discuss it with the user. ' +",
  "new": "`Describe this image in detail for an assistant who cannot see it but will use your description to discuss it with ${userWords(currentAddress(agentId))}. ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S008",
  "file": "agent/runtime.ts",
  "line": 297,
  "old": "`[System: Your current model can't see images directly, but the user sent ${imagesCaptioned} image${imagesCaptioned === 1 ? '' : 's'} and the platform's fallback vision model (` +",
  "new": "`[System: Your current model can't see images directly, but ${userWords(currentAddress(agentId))} sent ${imagesCaptioned} image${imagesCaptioned === 1 ? '' : 's'} and the platform's fallback vision model (` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S009",
  "file": "agent/runtime.ts",
  "line": 301,
  "old": "`If the user asks something the description doesn't cover, say so and offer to ask the fallback for a more specific look (re-uploading helps).]`",
  "new": "`If ${userWords(currentAddress(agentId))} asks something the description doesn't cover, say so and offer to ask the fallback for a more specific look (re-uploading helps).]`",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S010",
  "file": "agent/runtime.ts",
  "line": 306,
  "old": "`[System: Your current model can't see images directly. The platform's fallback vision model (${fallback?.apiModelId}) described ${imagesCaptioned} of the user's image${imagesCaptioned === 1 ? '' : 's'} (you can see those descriptions in the messages above), but ${imagesStripped} other image${imagesStripped === 1 ? '' : 's'} could not be captioned (network or model error). ` +",
  "new": "`[System: Your current model can't see images directly. The platform's fallback vision model (${fallback?.apiModelId}) described ${imagesCaptioned} of ${userWords(currentAddress(agentId))}'s image${imagesCaptioned === 1 ? '' : 's'} (you can see those descriptions in the messages above), but ${imagesStripped} other image${imagesStripped === 1 ? '' : 's'} could not be captioned (network or model error). ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S011",
  "file": "agent/runtime.ts",
  "line": 307,
  "old": "`Respond based on the descriptions you DO have. For the missing one${imagesStripped === 1 ? '' : 's'}, tell the user you couldn't read ${imagesStripped === 1 ? 'it' : 'them'} and suggest they re-upload.]`",
  "new": "`Respond based on the descriptions you DO have. For the missing one${imagesStripped === 1 ? '' : 's'}, tell ${userWords(currentAddress(agentId))} you couldn't read ${imagesStripped === 1 ? 'it' : 'them'} and suggest they re-upload.]`",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S012",
  "file": "agent/runtime.ts",
  "line": 312,
  "old": "`[System: The user just sent ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} but your current model does NOT support vision input. ` +",
  "new": "`[System: ${userWords(currentAddress(agentId), true)} just sent ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} but your current model does NOT support vision input. ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S013",
  "file": "agent/runtime.ts",
  "line": 317,
  "old": "`Reply briefly telling the user you couldn't read the image${imagesStripped === 1 ? '' : 's'} this turn. ` +",
  "new": "`Reply briefly telling ${userWords(currentAddress(agentId))} you couldn't read the image${imagesStripped === 1 ? '' : 's'} this turn. ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S014",
  "file": "agent/tools/cat/comms.ts",
  "line": 405,
  "old": "`Tell the user they need to open Settings → Channels and toggle \"Allow sending email\" ON for ${acctLabel}, then retry. ` +",
  "new": "`Tell ${userWords(currentAddress(agentId))} that the owner needs to open Settings → Channels and toggle \"Allow sending email\" ON for ${acctLabel}, then retry. ` +",
  "how": "A=currentAddress(agentId); the ACTOR is the owner, the person told is the addressee"
 },
 {
  "id": "S015",
  "file": "agent/tools/cat/comms.ts",
  "line": 444,
  "old": "content = 'No iMessage safe senders are configured on this server. Tell the user to add contacts in Settings → Channels (iMessage card) if they want you to text someone.';",
  "new": "content = `No iMessage safe senders are configured on this server. Tell ${userWords(currentAddress(agentId))} that the owner can add contacts in Settings → Channels (iMessage card) if they want you to text someone.`;",
  "how": "A=currentAddress(agentId); the ACTOR is the owner, the person told is the addressee"
 },
 {
  "id": "S016",
  "file": "agent/tools/cat/comms.ts",
  "line": 506,
  "old": "`If you need to text someone new, the user has to add them in Settings → Channels (iMessage card) first.`;",
  "new": "`If you need to text someone new, the owner has to add them in Settings → Channels (iMessage card) first.`;",
  "how": "static: the actor is the owner; no address needed"
 },
 {
  "id": "S017",
  "file": "agent/tools/cat/media.ts",
  "line": 140,
  "old": "`Tell the user image generation is unavailable until this is configured, do not retry.`;",
  "new": "`Tell ${userWords(currentAddress(agentId))} image generation is unavailable until this is configured, do not retry.`;",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S018",
  "file": "agent/tools/cat/media.ts",
  "line": 541,
  "old": "`\\n\\nNote: your current model does NOT support image input. The image will be delivered to the user as an attachment and the user will see it; you will NOT see it. ` +",
  "new": "`\\n\\nNote: your current model does NOT support image input. The image will be delivered to ${userWords(currentAddress(agentId))} as an attachment and ${userWords(currentAddress(agentId))} will see it; you will NOT see it. ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S019",
  "file": "agent/tools/cat/media.ts",
  "line": 585,
  "old": "? `No music-generation model is configured. Go to Settings → Models → Music Generation Model and pick a music-capable model (e.g. Google Lyria). Tell the user music generation is unavailable until this is configured, do not retry.`",
  "new": "? `No music-generation model is configured. Go to Settings → Models → Music Generation Model and pick a music-capable model (e.g. Google Lyria). Tell ${userWords(currentAddress(agentId))} music generation is unavailable until this is configured, do not retry.`",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S020",
  "file": "agent/tools/cat/media.ts",
  "line": 586,
  "old": ": `No audio-generation model is configured. Go to Settings → Models → Audio Generation Model and pick an audio-capable model. Tell the user audio generation is unavailable until this is configured, do not retry.`;",
  "new": ": `No audio-generation model is configured. Go to Settings → Models → Audio Generation Model and pick an audio-capable model. Tell ${userWords(currentAddress(agentId))} audio generation is unavailable until this is configured, do not retry.`;",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S021",
  "file": "agent/tools/cat/media.ts",
  "line": 644,
  "old": "`Tell the user video generation is unavailable until this is configured, do not retry.`;",
  "new": "`Tell ${userWords(currentAddress(agentId))} video generation is unavailable until this is configured, do not retry.`;",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S022",
  "file": "agent/tools/cat/media.ts",
  "line": 707,
  "old": "`Tell the user briefly that the video couldn't be started. Do not retry automatically.`;",
  "new": "`Tell ${userWords(currentAddress(agentId))} briefly that the video couldn't be started. Do not retry automatically.`;",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S023",
  "file": "agent/tools/cat/media.ts",
  "line": 901,
  "old": "`If you paste the transcript to the user, paste it verbatim INSIDE a fenced \\`\\`\\`source/transcript ... \\`\\`\\` block. Do not paraphrase the words unless the user asks for a summary.\\n\\n` +",
  "new": "`If you paste the transcript to ${userWords(currentAddress(agentId))}, paste it verbatim INSIDE a fenced \\`\\`\\`source/transcript ... \\`\\`\\` block. Do not paraphrase the words unless ${userWords(currentAddress(agentId))} asks for a summary.\\n\\n` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S024",
  "file": "agent/tools/surface.ts",
  "line": 360,
  "old": ": 'use send_to_agent to ask an agent with broader permissions, or tell the user you are blocked';",
  "new": ": 'use send_to_agent to ask an agent with broader permissions, or tell the person you are talking to you are blocked';",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S025",
  "file": "agent/tools/util.ts",
  "line": 227,
  "old": "steps.push('Or tell the user you are blocked so they can act');",
  "new": "steps.push(`Or tell ${userWords(currentAddress(agentId))} you are blocked so they can act`);",
  "how": "A=currentAddress(agentId); convert the quoted literal to a template string"
 },
 {
  "id": "S026",
  "file": "agent/v2/claimed-delivery.ts",
  "line": 205,
  "old": "`correct tool, or tell the user plainly that it has not gone through yet. Do not leave a claim ` +",
  "new": "`correct tool, or tell the person you are talking to plainly that it has not gone through yet. Do not leave a claim ` +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S027",
  "file": "agent/v2/claimed-delivery.ts",
  "line": 216,
  "old": "`agent, imessage_send / the email-send tool for a person) before telling the user it is done.]`",
  "new": "`agent, imessage_send / the email-send tool for a person) before telling the person you are talking to it is done.]`",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S028",
  "file": "agent/v2/classifiers/context-gap.ts",
  "line": 51,
  "old": "`If you can't tell what the user wants done with it from context (an active task, a matching technique, or the recent conversation), ask them one specific question instead of guessing.]`",
  "new": "`If you can't tell what the person you are talking to wants done with it from context (an active task, a matching technique, or the recent conversation), ask them one specific question instead of guessing.]`",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S029",
  "file": "agent/v2/classifiers/loop.ts",
  "line": 212,
  "old": "`The user does not need more verification. The previous result is the answer; trust it. ` +",
  "new": "`The person you are talking to does not need more verification. The previous result is the answer; trust it. ` +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S030",
  "file": "agent/v2/classifiers/loop.ts",
  "line": 213,
  "old": "`Respond to the user with TEXT now, do NOT call this tool again, and do NOT call related verification tools (file_read, exec, ls, etc.) on the same artifact. ` +",
  "new": "`Respond to the person you are talking to with TEXT now, do NOT call this tool again, and do NOT call related verification tools (file_read, exec, ls, etc.) on the same artifact. ` +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S031",
  "file": "agent/v2/classifiers/loop.ts",
  "line": 214,
  "old": "`If you genuinely need different information, ask the user a direct question instead.`,",
  "new": "`If you genuinely need different information, ask the person you are talking to a direct question instead.`,",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S032",
  "file": "agent/v2/classifiers/provider.ts",
  "line": 107,
  "old": "'Tell the user the image exceeded the model size limit and ask for a smaller one.',",
  "new": "'Tell the person you are talking to the image exceeded the model size limit and ask for a smaller one.',",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S033",
  "file": "agent/v2/classifiers/provider.ts",
  "line": 120,
  "old": "guidance: 'Mention to the user that not all images were processed.',",
  "new": "guidance: 'Mention to the person you are talking to that not all images were processed.',",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S034",
  "file": "agent/v2/classifiers/provider.ts",
  "line": 170,
  "old": "guidance: 'Rephrase or tell the user you cannot help with this.',",
  "new": "guidance: 'Rephrase or tell the person you are talking to you cannot help with this.',",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S035",
  "file": "agent/v2/classifiers/provider.ts",
  "line": 182,
  "old": "guidance: 'Apologize to the user and ask them to try again.',",
  "new": "guidance: 'Apologize to the person you are talking to and ask them to try again.',",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S036",
  "file": "agent/v2/classifiers/provider.ts",
  "line": 204,
  "old": "\"Continue without trying to look at images. If the user asked you to analyze an image and you have a path to it, describe what you can infer from the filename, surrounding text, or metadata — or tell the user this model can't see images and they may want to switch.\",",
  "new": "\"Continue without trying to look at images. If the person you are talking to asked you to analyze an image and you have a path to it, describe what you can infer from the filename, surrounding text, or metadata — or tell the person you are talking to this model can't see images and they may want to switch.\",",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S037",
  "file": "agent/v2/error-format.ts",
  "line": 69,
  "old": "? `An attached image (${ctx.filename}) was too large for the model even after compression and was dropped. Tell the user the image exceeded the model's size limit.`",
  "new": "? `An attached image (${ctx.filename}) was too large for the model even after compression and was dropped. Tell the person you are talking to the image exceeded the model's size limit.`",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S038",
  "file": "agent/v2/error-format.ts",
  "line": 70,
  "old": ": `One attached image was too large for the model even after compression and was dropped. Tell the user the image exceeded the model's size limit.`;",
  "new": ": `One attached image was too large for the model even after compression and was dropped. Tell the person you are talking to the image exceeded the model's size limit.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S039",
  "file": "agent/v2/error-format.ts",
  "line": 73,
  "old": "return `Only the first ${ctx.imageCount ?? 'N'} of ${ctx.imageTotal ?? 'M'} images were sent — the model has a per-request limit. Mention this to the user.`;",
  "new": "return `Only the first ${ctx.imageCount ?? 'N'} of ${ctx.imageTotal ?? 'M'} images were sent — the model has a per-request limit. Mention this to the person you are talking to.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S040",
  "file": "agent/v2/error-format.ts",
  "line": 76,
  "old": "return `This model can't see images. Describe what you can from the filename and surrounding context, or suggest the user switch to a vision-capable model in Settings.`;",
  "new": "return `This model can't see images. Describe what you can from the filename and surrounding context, or suggest the person you are talking to switch to a vision-capable model in Settings.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S041",
  "file": "agent/v2/error-format.ts",
  "line": 96,
  "old": "return `Your last response was rejected because it exceeded the output token limit. Be more concise — produce a shorter response, or break the task into smaller pieces. If a tool result is too large to summarize in one turn, update the user with what you've done so far and continue next turn.`;",
  "new": "return `Your last response was rejected because it exceeded the output token limit. Be more concise — produce a shorter response, or break the task into smaller pieces. If a tool result is too large to summarize in one turn, update the person you are talking to with what you've done so far and continue next turn.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S042",
  "file": "agent/v2/error-format.ts",
  "line": 99,
  "old": "return `Two empty responses in a row. Apologize to the user and end your turn.`;",
  "new": "return `Two empty responses in a row. Apologize to the person you are talking to and end your turn.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S043",
  "file": "agent/v2/error-format.ts",
  "line": 102,
  "old": "return `The model refused your last request. Rephrase or tell the user you can't help with this.`;",
  "new": "return `The model refused your last request. Rephrase or tell the person you are talking to you can't help with this.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S044",
  "file": "agent/v2/error-format.ts",
  "line": 106,
  "old": "? `${ctx.providerName} is rate-limited right now and retries haven't cleared. Tell the user you'll try again in a few minutes, or end this thread cleanly.`",
  "new": "? `${ctx.providerName} is rate-limited right now and retries haven't cleared. Tell the person you are talking to you'll try again in a few minutes, or end this thread cleanly.`",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S045",
  "file": "agent/v2/error-format.ts",
  "line": 107,
  "old": ": `The provider is rate-limited right now and retries haven't cleared. Tell the user you'll try again in a few minutes, or end this thread cleanly.`;",
  "new": ": `The provider is rate-limited right now and retries haven't cleared. Tell the person you are talking to you'll try again in a few minutes, or end this thread cleanly.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S046",
  "file": "agent/v2/error-format.ts",
  "line": 119,
  "old": "return `The provider sent a malformed response. Apologize to the user and ask them to try again.`;",
  "new": "return `The provider sent a malformed response. Apologize to the person you are talking to and ask them to try again.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S047",
  "file": "agent/v2/error-format.ts",
  "line": 132,
  "old": "return `A platform-level error occurred. The user is being notified directly. End this turn.`;",
  "new": "return `A platform-level error occurred. The person you are talking to is being notified directly. End this turn.`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S048",
  "file": "agent/v2/loop.ts",
  "line": 112,
  "old": "'If you believe this block is a mistake and it is stopping something the user genuinely needs, ' +",
  "new": "'If you believe this block is a mistake and it is stopping something the person you are talking to genuinely needs, ' +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S049",
  "file": "agent/v2/loop.ts",
  "line": 113,
  "old": "'do NOT silently give up, tell the user what you were trying to do and that the engine blocked it, ' +",
  "new": "'do NOT silently give up, tell the person you are talking to what you were trying to do and that the engine blocked it, ' +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S050",
  "file": "agent/v2/recorded-commitment.ts",
  "line": 208,
  "old": "`[System: your reply tells the user the commitment is recorded (\"${d.claim}\"), and the work ledger ` +",
  "new": "`[System: your reply tells the person you are talking to the commitment is recorded (\"${d.claim}\"), and the work ledger ` +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S051",
  "file": "agent/v2/recorded-commitment.ts",
  "line": 211,
  "old": "`that is the only call that puts it on the ledger. If you would rather not track it, tell the user ` +",
  "new": "`that is the only call that puts it on the ledger. If you would rather not track it, tell the person you are talking to ` +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S052",
  "file": "agent/v2/recovery.ts",
  "line": 56,
  "old": "`automatically. Give it a moment, and tell the user there is a short delay if they are waiting.]`;",
  "new": "`automatically. Give it a moment, and tell the person you are talking to there is a short delay if they are waiting.]`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S053",
  "file": "agent/v2/recovery.ts",
  "line": 543,
  "old": "`If a tool result is too large to summarize in one turn, call complete_task or update the user with what you've done so far and continue next turn.]`;",
  "new": "`If a tool result is too large to summarize in one turn, call complete_task or update the person you are talking to with what you've done so far and continue next turn.]`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S054",
  "file": "agent/v2/recovery.ts",
  "line": 602,
  "old": "`If the user is waiting, apologize and tell them you ran into a problem you cannot work around right now.]`;",
  "new": "`If ${userWords(currentAddress(agentId))} is waiting, apologize and tell them you ran into a problem you cannot work around right now.]`;",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S055",
  "file": "agent/v2/recovery.ts",
  "line": 821,
  "old": "`Apologize to the user, end your turn cleanly, and the Healer will look into it.]`,",
  "new": "`Apologize to ${userWords(currentAddress(agentId))}, end your turn cleanly, and the Healer will look into it.]`,",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S056",
  "file": "agent/v2/refused-delivery.ts",
  "line": 108,
  "old": "return '[System: You told the user that went out, and the only tool this turn that could have sent it '",
  "new": "return '[System: You told the person you are talking to that went out, and the only tool this turn that could have sent it '",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S057",
  "file": "agent/v2/steps/assemble/delegation-and-attachments.ts",
  "line": 91,
  "old": "'the user explicitly asked for this to be delegated to one of your agents. ' +",
  "new": "'the person you are talking to explicitly asked for this to be delegated to one of your agents. ' +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S058",
  "file": "agent/v2/steps/assemble/delegation-and-attachments.ts",
  "line": 93,
  "old": "'an existing one) and synthesize the result back to the user, or, if doing it ' +",
  "new": "'an existing one) and synthesize the result back to the person you are talking to, or, if doing it ' +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S059",
  "file": "agent/v2/steps/assemble/delegation-and-attachments.ts",
  "line": 94,
  "old": "'yourself is clearly better here, briefly tell the user you are handling it ' +",
  "new": "'yourself is clearly better here, briefly tell the person you are talking to you are handling it ' +",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S060",
  "file": "agent/v2/steps/execute/delegation-exit.ts",
  "line": 163,
  "old": "'[Engine hint: you delegated work on the user\\'s request and are about to end your turn without telling them anything. WRITE ONE short line to them first, directly in this conversation: if you already have their answer, give it now; otherwise say you have handed the pieces off and will report back when they return. Do NOT call imessage_send or any send tool (the engine routes your reply), and do not message any agent again this turn.]';",
  "new": "`[Engine hint: you delegated work on ${userWords(ctx.turnCtx.address)}'s request and are about to end your turn without telling them anything. WRITE ONE short line to them first, as your reply (it goes to ${userWords(ctx.turnCtx.address)} by ${replyChannelWords(ctx.turnCtx.address)}): if you already have their answer, give it now; otherwise say you have handed the pieces off and will report back when they return. Do NOT call imessage_send or any send tool (the engine routes your reply), and do not message any agent again this turn.]`;",
  "how": "A=ctx.turnCtx.address; import { userWords, replyChannelWords } from '../../turn-address.js'. Keep the rest of the literal exactly as it is today."
 },
 {
  "id": "S061",
  "file": "agent/v2/steps/execute/refusal-gates.ts",
  "line": 146,
  "old": "`  (c) Send the user a direct question if you need clarification.\\n` +",
  "new": "`  (c) Send ${userWords(turnCtx.address)} a direct question if you need clarification.\\n` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S062",
  "file": "agent/v2/steps/execute/refusal-gates.ts",
  "line": 278,
  "old": "`Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.\\n\\n` +",
  "new": "`Results already delivered to ${userWords(turnCtx.address)} must NOT be repeated; after your tracker call, reply [no-reply] unless ${userWords(turnCtx.address)} asked something new.\\n\\n` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S063",
  "file": "agent/v2/steps/execute/result-notes.ts",
  "line": 28,
  "old": "const VISIBILITY_HINT = `\\n\\n[VISIBILITY: tool results are shown only to you, not to the user. The user sees only your reply text and any files you attach via show_to_user. If you want them to have a URL or detail from this result, include it inline in your reply, they cannot \"see above\". If there's nothing here worth surfacing, no action needed.]`;",
  "new": "const VISIBILITY_HINT = `\\n\\n[VISIBILITY: tool results are shown only to you, not to the person you are talking to. The person you are talking to sees only your reply text and any files you attach via show_to_user. If you want them to have a URL or detail from this result, include it inline in your reply, they cannot \"see above\". If there's nothing here worth surfacing, no action needed.]`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S064",
  "file": "agent/v2/steps/execute/result-notes.ts",
  "line": 68,
  "old": "const BOOKKEEPING_NUDGE = `\\n\\n[Engine note: this was internal bookkeeping. If the user just asked you to do exactly this (e.g. \"save my key\", \"remember that\", \"delete X\"), reply with ONE short line confirming it is done (e.g. \"Saved.\", \"Got it, stored your OpenWeather key.\") so they get acknowledgment. If instead this was incidental to other work, something you did on your own initiative, or the user already has what they needed, end the turn with literal \\`[no-reply]\\` rather than a generic \"Done.\" / \"All set.\" / \"Got it.\" closeout.]`;",
  "new": "const BOOKKEEPING_NUDGE = `\\n\\n[Engine note: this was internal bookkeeping. If the person you are talking to just asked you to do exactly this (e.g. \"save my key\", \"remember that\", \"delete X\"), reply with ONE short line confirming it is done (e.g. \"Saved.\", \"Got it, stored your OpenWeather key.\") so they get acknowledgment. If instead this was incidental to other work, something you did on your own initiative, or the person you are talking to already has what they needed, end the turn with literal \\`[no-reply]\\` rather than a generic \"Done.\" / \"All set.\" / \"Got it.\" closeout.]`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S065",
  "file": "agent/v2/steps/execute/result-notes.ts",
  "line": 78,
  "old": "const BOOKKEEPING_NUDGE_USER_REQUESTED = `\\n\\n[Engine note: the user asked you to do this, so it is not incidental bookkeeping. Reply to them now with the outcome in one short line, and if your tool results above produced a link or file for them (a \"Link:\", \"Open:\", or \"Share link:\" line), include that link in your reply so they can open it. Do NOT end this turn with [no-reply].]`;",
  "new": "const BOOKKEEPING_NUDGE_USER_REQUESTED = `\\n\\n[Engine note: the person you are talking to asked you to do this, so it is not incidental bookkeeping. Reply to them now with the outcome in one short line, and if your tool results above produced a link or file for them (a \"Link:\", \"Open:\", or \"Share link:\" line), include that link in your reply so they can open it. Do NOT end this turn with [no-reply].]`;",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S066",
  "file": "agent/v2/steps/post-call-classify/empty-response.ts",
  "line": 236,
  "old": "content: \"[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]\",",
  "new": "content: `[System: You returned an empty response. Please respond to ${userWords(ctx.turnCtx.address)}'s last message or call a tool to continue your task. If you are finished, say so clearly.]`,",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S067",
  "file": "agent/v2/steps/post-call-classify/going-idle.ts",
  "line": 80,
  "old": "`update the task status to \"blocked\" or \"paused\" with a clear reason, OR write one sentence in your reply telling the user what you are waiting for. ` +",
  "new": "`update the task status to \"blocked\" or \"paused\" with a clear reason, OR write one sentence in your reply telling ${userWords(turnCtx.address)} what you are waiting for. ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S068",
  "file": "agent/v2/steps/post-call-classify/going-idle.ts",
  "line": 81,
  "old": "`Silently going idle after a work_note leaves the user with no idea what is happening.]`",
  "new": "`Silently going idle after a work_note leaves ${userWords(turnCtx.address)} with no idea what is happening.]`",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S069",
  "file": "agent/v2/steps/post-call-classify/no-reply.ts",
  "line": 221,
  "old": "' ENGINE RECORD: the user HAS heard one line from you this turn — while you were '",
  "new": "` ENGINE RECORD: ${userWords(turnCtx.address)} HAS heard one line from you this turn — while you were `",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S070",
  "file": "agent/v2/steps/post-call-classify/no-reply.ts",
  "line": 230,
  "old": "'[Engine hint: you ended with [no-reply], but this message is a direct request from the user. ' +",
  "new": "`[Engine hint: you ended with [no-reply], but this message is a direct request from ${userWords(turnCtx.address)}. ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S071",
  "file": "agent/v2/steps/post-call-classify/no-reply.ts",
  "line": 232,
  "old": "'reply with ONE brief line pointing to the existing answer or delivery. Otherwise, do the work now, including creating the tracker task first if the user asked for one.' +",
  "new": "`reply with ONE brief line pointing to the existing answer or delivery. Otherwise, do the work now, including creating the tracker task first if ${userWords(turnCtx.address)} asked for one.` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S072",
  "file": "agent/v2/steps/post-call-classify/no-reply.ts",
  "line": 261,
  "old": "`[Engine record: you again ended with [no-reply] on the user's direct ask, but you already answered this in this conversation. Your recorded answer: \"${excerpt}\". Reply now with one brief line in your own words pointing back to that. Do not re-do the work and do not stay silent.]`;",
  "new": "`[Engine record: you again ended with [no-reply] on ${userWords(turnCtx.address)}'s direct ask, but you already answered this in this conversation. Your recorded answer: \"${excerpt}\". Reply now with one brief line in your own words pointing back to that. Do not re-do the work and do not stay silent.]`;",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S073",
  "file": "agent/v2/steps/post-call-classify/owed-interrupt.ts",
  "line": 176,
  "old": "`[System] While you were working, the user also sent: ${quoted}. ` +",
  "new": "`[System] While you were working, ${userWords(turnCtx.address)} also sent: ${quoted}. ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S074",
  "file": "agent/v2/steps/post-call-classify/owed-interrupt.ts",
  "line": 178,
  "old": "`and a second answer from you now would reach the user as a duplicate.${laterTurnRelease} ` +",
  "new": "`and a second answer from you now would reach ${userWords(turnCtx.address)} as a duplicate.${laterTurnRelease} ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S075",
  "file": "agent/v2/steps/post-call-classify/owed-interrupt.ts",
  "line": 180,
  "old": "`Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; the user already has it. ` +",
  "new": "`Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; ${userWords(turnCtx.address)} already has it. ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S076",
  "file": "agent/v2/steps/post-call-classify/owed-interrupt.ts",
  "line": 202,
  "old": "`[System] While you are working, the user also sent: ${quoted}. ` +",
  "new": "`[System] While you are working, ${userWords(turnCtx.address)} also sent: ${quoted}. ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S077",
  "file": "agent/v2/steps/post-call-classify/owed-interrupt.ts",
  "line": 207,
  "old": "`, note=\"<the user's own words>\"). ` +",
  "new": "`, note=\"<${userWords(turnCtx.address)}'s own words>\"). ` +",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S078",
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": 240,
  "old": "`[System] Your reply told the user what is currently scheduled or owed ('${quoted}'), ` +",
  "new": "`[System] Your reply told ${userWords(ctx.turnCtx.address)} what is currently scheduled or owed ('${quoted}'), ` +",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S079",
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": 243,
  "old": "`calendar_agenda if you named a calendar event. The user already has your reply, so do ` +",
  "new": "`calendar_agenda if you named a calendar event. ${userWords(ctx.turnCtx.address, true)} already has your reply, so do ` +",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S080",
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": 245,
  "old": "`with [no-reply]; if a line is wrong, tell the user only that correction, in a line or ` +",
  "new": "`with [no-reply]; if a line is wrong, tell ${userWords(ctx.turnCtx.address)} only that correction, in a line or ` +",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S081",
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": 252,
  "old": "`[System] Your reply made a STANDING promise to the user ('${quoted}') — a commitment ` +",
  "new": "`[System] Your reply made a STANDING promise to ${userWords(ctx.turnCtx.address)} ('${quoted}') — a commitment ` +",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S082",
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": 257,
  "old": "`for a tracked task or a scheduled reminder), or tell the user honestly what you can ` +",
  "new": "`for a tracked task or a scheduled reminder), or tell ${userWords(ctx.turnCtx.address)} honestly what you can ` +",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S083",
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": 260,
  "old": "`[System] Your reply to the user was a promise to start ('${quoted}') but the turn ` +",
  "new": "`[System] Your reply to ${userWords(ctx.turnCtx.address)} was a promise to start ('${quoted}') but the turn ` +",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S084",
  "file": "agent/v2/steps/post-call-classify/reply-floors.ts",
  "line": 202,
  "old": "`[System: You told the user you saved that, but all ${rejected} vault_remember call${rejected === 1 ? '' : 's'} this turn `",
  "new": "`[System: You told ${userWords(ctx.turnCtx.address)} you saved that, but all ${rejected} vault_remember call${rejected === 1 ? '' : 's'} this turn `",
  "how": "A=ctx.turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S085",
  "file": "agent/v2/steps/post-call-classify/silent-closeout.ts",
  "line": 118,
  "old": "? `The engine recorded this delivery: ${receipts.slice(0, 220)}. The user has not heard anything about it. `",
  "new": "? `The engine recorded this delivery: ${receipts.slice(0, 220)}. ${userWords(turnCtx.address, true)} has not heard anything about it. `",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S086",
  "file": "agent/v2/steps/post-call-classify/silent-closeout.ts",
  "line": 122,
  "old": "? 'tell the user it is done and include the deliverable or link. '",
  "new": "? `tell ${userWords(turnCtx.address)} it is done and include the deliverable or link. `",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S087",
  "file": "agent/v2/steps/post-call-classify/silent-closeout.ts",
  "line": 123,
  "old": ": 'if the work truly reached the user, say where; if it did NOT, say honestly what remains instead of claiming it is done. ') +",
  "new": ": `if the work truly reached ${userWords(turnCtx.address)}, say where; if it did NOT, say honestly what remains instead of claiming it is done. `) +",
  "how": "A=turnCtx.address; convert the literal to a template string (the line before it, 'tell the user it is done and include the deliverable or link. ', is its own entry)"
 },
 {
  "id": "S088",
  "file": "agent/v2/steps/post-execution/index.ts",
  "line": 153,
  "old": "'Try responding based on what you already know, or ask the user for clarification.]',",
  "new": "`Try responding based on what you already know, or ask ${userWords(currentAddress(agentId))} for clarification.]`,",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S089",
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": 99,
  "old": "`work_update(action=\"status\") (or work_note), then continue. If you are stuck, tell the user ` +",
  "new": "`work_update(action=\"status\") (or work_note), then continue. If you are stuck, tell ${userWords(currentAddress(agentId))} ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S090",
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": 228,
  "old": "`re-state the goal and resume (work_update(action=\"status\")), or tell the user it is blocked and why. ` +",
  "new": "`re-state the goal and resume (work_update(action=\"status\")), or tell ${userWords(currentAddress(agentId))} it is blocked and why. ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S091",
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": 229,
  "old": "`If the user should know this — and if they were waiting on this work, they should — WRITE it to them ` +",
  "new": "`If ${userWords(currentAddress(agentId))} should know this — and if they were waiting on this work, they should — WRITE it to them ` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S092",
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": 231,
  "old": "`If this block looks wrong and is stopping something the user needs, tell them what you were attempting so they can decide.`,",
  "new": "`If this block looks wrong and is stopping something ${userWords(currentAddress(agentId))} needs, tell them what you were attempting so they can decide.`,",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S093",
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": 354,
  "old": "`  (b) Reply to the user with the answer you can give using the data you already have, if that is what they asked for.\\n` +",
  "new": "`  (b) Reply to ${userWords(currentAddress(agentId))} with the answer you can give using the data you already have, if that is what they asked for.\\n` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S094",
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": 356,
  "old": "`  (d) Send the user a specific question if you need clarification.\\n` +",
  "new": "`  (d) Send ${userWords(currentAddress(agentId))} a specific question if you need clarification.\\n` +",
  "how": "A=currentAddress(agentId); import { userWords, currentAddress } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S095",
  "file": "agent/v2/steps/preflight/closeout-gate.ts",
  "line": 194,
  "old": "`Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.]`",
  "new": "`Results already delivered to ${userWords(turnCtx.address)} must NOT be repeated; after your tracker call, reply [no-reply] unless ${userWords(turnCtx.address)} asked something new.]`",
  "how": "A=turnCtx.address; import { userWords } from the turn-address module (agent/v2/turn-address.js, relative path); text keeps 'the user' when there is no person (no code branch needed)"
 },
 {
  "id": "S096",
  "file": "services/image-generation.ts",
  "line": 432,
  "old": "`output and ignores ratio hints. Tell the user, or retry with a model that accepts a size parameter.`,",
  "new": "`output and ignores ratio hints. Tell the person you are talking to, or retry with a model that accepts a size parameter.`,",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S097",
  "file": "tools/name-help.ts",
  "line": 331,
  "old": "? 'Ask the user to update this agent\\'s permissions, or call complete_task(status=\"blocked\").'",
  "new": "? 'Ask the person you are talking to to update this agent\\'s permissions, or call complete_task(status=\"blocked\").'",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S098",
  "file": "tools/name-help.ts",
  "line": 332,
  "old": ": 'Ask the user to update this agent\\'s permissions, use send_to_agent to reach an agent with broader permissions, or tell the user you are blocked.';",
  "new": ": 'Ask the person you are talking to to update this agent\\'s permissions, use send_to_agent to reach an agent with broader permissions, or tell the person you are talking to you are blocked.';",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S099",
  "file": "tools/name-help.ts",
  "line": 350,
  "old": "'Retry the call once; if it fails again the same way, report the tool name to the user rather than guessing at a workaround.',",
  "new": "'Retry the call once; if it fails again the same way, report the tool name to the person you are talking to rather than guessing at a workaround.',",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 },
 {
  "id": "S100",
  "file": "tracker/tools.ts",
  "line": 689,
  "old": "+ `Nobody has been told but you. If the user should know — and if they asked for this `",
  "new": "+ `Nobody has been told but you. If the person you are talking to should know — and if they asked for this `",
  "how": "static wording, no plumbing: names the role and points the agent at the [Turn context] block, which names the person"
 }
];

export const ALLOW: readonly AllowEntry[] = [
 {
  "file": "agent/a2a-transport.ts",
  "line": "`Skip the iMessage only if you and ${ownerName} are actively going back and forth in dashboard chat about THIS specific deliverable right now (in which case dashboard is the natural place to surface it).]`;",
  "reason": "describes when the owner is already in the dashboard conversation about the deliverable (a presence fact), or is a tool description in the cached tools prefix, which must stay turn-independent"
 },
 {
  "file": "agent/access/engine-route.ts",
  "line": "return `withheld: this agent holds no ${channel ?? destination} channel grant, so the engine did not auto-route its reply (the reply is in the dashboard chat)`;",
  "reason": "true by construction: the engine withheld the auto-route, so the reply stays in the dashboard"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "content = `Error: \"${filename}\" is a document, not an image, show_to_user is for images (and short audio/video clips) shown inline in the chat. Documents render in the CANVAS: a canvas-renderable file auto-opens the moment you write it (file_write, or creating a Word/Excel/PDF), or call canvas_render({ path: \"${srcPath}\" }) to (re)open it. Using show_to_user here would give the user a useless download chip instead of a readable preview.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "content = `Queued ${attachments.length} file(s) for your next reply (they attach as thumbnails):\\n${fileList}\\nWhen you point the user to a file, give them the shareable link above, never a raw file path. Now write your reply text in your next assistant message. Do NOT call show_to_user again for these same files.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "content = 'Error: `user_request_quote` is required. Quote the user\\'s actual words asking you to start this conversation. If you cannot quote a real user request, do NOT call this tool.';",
  "reason": "the owner is the actor here (settings the owner changes) or the text describes a tool argument, not who is being replied to"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "content = 'Error: `user_request_quote` is too short to be a real user request. Quote the full sentence where the user asked you to start this conversation.';",
  "reason": "the owner is the actor here (settings the owner changes) or the text describes a tool argument, not who is being replied to"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "content = `Error: \\`slot\\` is required for ${channelArg} (must be \"agent\" or \"user\"). The slot identifies which mailbox\\'s list to add to, the agent\\'s own ${channelArg} account or the user\\'s personal ${channelArg} account.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "`Pick the contact that best matches what the user said. To iMessage them, ` +",
  "reason": "the owner is the actor here (settings the owner changes) or the text describes a tool argument, not who is being replied to"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "`If two or more contacts plausibly fit, ask the user which one they meant before sending. ` +",
  "reason": "the owner is the actor here (settings the owner changes) or the text describes a tool argument, not who is being replied to"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "+ (route ? `sms_send instead. Only if that fails too should you tell the user (${route}). ` : 'sms_send instead. Only if that fails too should you tell the user and answer in '",
  "reason": "the dashboard wording chosen only when the turn address says the reply stays in the dashboard"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "+ 'the dashboard chat. ')",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": ": (route ? `Tell the user that iMessage is turned off on this server: ${route}. ` : 'Tell the user that iMessage is turned off on this server and respond to them in the dashboard chat instead. ')) +",
  "reason": "the dashboard wording chosen only when the turn address says the reply stays in the dashboard"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "? 'To re-enable iMessage delivery, the user can start it from Settings → Channels (iMessage card).'",
  "reason": "the owner is the actor here (settings the owner changes) or the text describes a tool argument, not who is being replied to"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": ": 'The user can enable iMessage by adding an approved sender in Settings → Channels (iMessage card).');",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "(routedReplyWords(agentId) ? `Tell the user the message did not go through (${routedReplyWords(agentId)}). ` : 'Tell the user the message did not go through, and respond in the dashboard chat instead. ') +",
  "reason": "the dashboard wording chosen only when the turn address says the reply stays in the dashboard"
 },
 {
  "file": "agent/tools/cat/comms.ts",
  "line": "'The user can check System Settings - Privacy & Security - Automation to grant Messages access if AppleScript is the issue.';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/tools/surface.ts",
  "line": "description: `${t.description}\\n\\nVOICES for the configured model, pass one of these ids in \\`voice\\`, picking the closest when the user asks for a specific sound (e.g. \"a deep male voice\" -> onyx): ${list}. The voice id only sets the base timbre. For character, accent, age, or emotion (gravelly, elderly, excited, pirate, etc.), keep a base voice id AND write the delivery style into the \\`text\\` as natural narration, the id alone cannot produce it. A voice id not in this list is rejected.`,",
  "reason": "describes when the owner is already in the dashboard conversation about the deliverable (a presence fact), or is a tool description in the cached tools prefix, which must stay turn-independent"
 },
 {
  "file": "agent/v2/answered-edge.ts",
  "line": "'RECENTLY ANSWERED in this conversation (engine record; do NOT re-execute this work. If '",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/classifiers/a2a.ts",
  "line": "`The text you just wrote is going to your own chat (only the user sees it), not to ${fromName}. ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/classifiers/a2a.ts",
  "line": "`Other agents CANNOT see your chat — only the user can. ${fromName} got nothing. ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/classifiers/multistep.ts",
  "line": "'You are a classifier. Decide if the user task below is multi-step (more than 2 distinct actions or deliverables) or single-step.\\n' +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/classifiers/progress.ts",
  "line": "`the user can act. If the work is actually done, record it with ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/counterparty.ts",
  "line": "dashboard: 'the dashboard chat',",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "agent/v2/counterparty.ts",
  "line": "`you. Do NOT greet or message the user unless the item genuinely matters to them ` +",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "agent/v2/counterparty.ts",
  "line": "`the user or send them a message unless the event is explicitly meant to be delivered to them ` +",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "agent/v2/counterparty.ts",
  "line": "`(a reminder, a digest, a completion report). If there is nothing to tell the user, just do the ` +",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "agent/v2/counterparty.ts",
  "line": "`Reply with send_to_agent on this thread. This is NOT your user, do not address the user, ` +",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "agent/v2/error-format.ts",
  "line": "return `${agent} hit a problem with its last request. It'll explain in chat when you check.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steer-queue.ts",
  "line": "{ id: 'start-ack',             priority: 25, why: 'the user has been waiting with no word this turn' },",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/assemble/start-ack-door.ts",
  "line": "'[Engine hint: the user has not heard anything from you yet this turn, and their request is being worked as a tracked job. In your next response, open with ONE short line in your own voice letting them know you are on it, then continue the work. Keep it to a single brief sentence; the full answer comes when the work is done.]';",
  "reason": "the no-person fallback of an address-aware text"
 },
 {
  "file": "agent/v2/steps/assemble/start-ack-door.ts",
  "line": "'[Engine hint: reminder, the user has STILL heard nothing from you this turn. Before your next tool call, say one short line to them that you are on it. This is the last reminder.]';",
  "reason": "the no-person fallback of an address-aware text"
 },
 {
  "file": "agent/v2/steps/assemble/start-ack-door.ts",
  "line": "return addr?.kind === 'person' ? START_ACK_REMINDER_TEXT.replace('the user has', `${addr.name} has`) : START_ACK_REMINDER_TEXT;",
  "reason": "the no-person fallback of an address-aware text"
 },
 {
  "file": "agent/v2/steps/assemble/technique-hints.ts",
  "line": "`[DOJO TECHNIQUE, engine-injected. This is technique guidance (precedence: task/technique notes); the user's live message above outranks it wherever they conflict.]`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/assemble/technique-hints.ts",
  "line": "`${header}\\nThis task matches the \"${strongMatch.technique.name}\" technique. The full instructions are too long to inline (${md.length} chars), load it via use_technique('${strongMatch.technique.id}') before doing the work, then follow its steps unless the user said otherwise.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/assemble/technique-hints.ts",
  "line": "`${header}\\nThis task matches the \"${strongMatch.technique.name}\" technique. Follow the procedure below unless the user's message says otherwise.\\n\\n` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/assemble/technique-hints.ts",
  "line": "`Based on the user's message, the DOJO matched these techniques. Load any that fit the task; ignore otherwise.\\n\\n` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/execute/refusal-gates.ts",
  "line": "`You've already called this tool with these exact arguments; the first call's result is in this conversation.\\n\\n` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/execute/tracker-floors.ts",
  "line": "`total untracked in this conversation: ${effectiveUntracked}; floor: ${TRACKER_AUTO_SCAFFOLD_AT}; ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/post-call-classify/handoff-floors.ts",
  "line": "const waiter = who ?? 'the user';",
  "reason": "the no-address fallback of an address-aware text (the person is named when an address exists)"
 },
 {
  "file": "agent/v2/steps/post-call-classify/handoff-floors.ts",
  "line": ": `directly in this conversation (do NOT call imessage_send or any send tool; the engine routes your reply)`;",
  "reason": "the no-address fallback of an address-aware text (the person is named when an address exists)"
 },
 {
  "file": "agent/v2/steps/post-call-classify/handoff-floors.ts",
  "line": "`${waiter} anything. ${who ? `${who} is` : 'The user is'} waiting. WRITE ${waiter} a short reply NOW, ${routeNote}: ` +",
  "reason": "the no-address fallback of an address-aware text (the person is named when an address exists)"
 },
 {
  "file": "agent/v2/steps/post-call-classify/handoff-floors.ts",
  "line": ": `directly in this conversation (do NOT call imessage_send or any send tool; the engine routes your reply)`;",
  "reason": "the no-address fallback of an address-aware text (the person is named when an address exists)"
 },
 {
  "file": "agent/v2/steps/post-call-classify/promise-floor.ts",
  "line": "`will carry it out. A promise that lives only in this conversation does not survive a ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/post-call-classify/silent-closeout.ts",
  "line": "'WRITE one short reply in this conversation now, in your own words: ' +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": "`in your own words, directly in the conversation (the engine routes your reply; do not call a send tool). ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/steps/pre-call-gates/thrash-gate.ts",
  "line": "`with the SAME arguments every time. The first call's result is already in this conversation; ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "agent/v2/turn-address.ts",
  "line": "dashboard: 'the dashboard chat',",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "agent/v2/turn-address.ts",
  "line": "return cap ? 'The user' : 'the user';",
  "reason": "the address renderer itself: channel label table and the engine/notification/agent header variants"
 },
 {
  "file": "tracker/tools.ts",
  "line": "const content = `[SOURCE: TRACKER TASK UPDATE, automated status update, not a message from the user] ${message}`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "lines.push('If this local time is NOT what the user asked for, re-call with the corrected time — either as an ISO 8601 UTC instant, or as local_time=\"YYYY-MM-DDThh:mm\" and let the engine do the timezone conversion.');",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "'ASK_USER: This reminder needs a time. Ask the user when they would like to be ' +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`If you're done, use status=\"complete\". If you're waiting on the user, use ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`with the real reason so the user knows. If you're just done with the task, use \\`status=\"complete\"\\`. ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`If you actually have a user-facing question, ask the user first then re-pause with a concrete \"waiting for X\" reason.`",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`If you are paused waiting for the user to do something, use status=\"paused\" with notes naming the wait condition instead.` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "return 'Error: reject_reason is required when valid=false. One-sentence explanation for the agent (e.g. \"no specific wait condition; you never actually asked the user anything\").';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`Pick one and move: (a) finish the work and mark complete with result + evidence, (b) mark blocked with the real obstacle if you can't proceed, (c) ask the user a specific question and re-pause naming what you're waiting for. Don't re-pause with the same notes, PM will reject again. No reply to the PM is needed.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "return 'Error: directive must be at least 30 characters. Tell the agent concretely what they did wrong and what to do instead (e.g. \"you posted the brief in chat but the task specifies email delivery; please call send_email with the same content to user@example.com\").';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "return `Error: task \"${task.title}\" (${taskId.slice(0, 8)}) has already had its work delivered to the user and is awaiting adjudication. Retasking it would regenerate and overwrite delivered work, producing a divergent second version. If the delivered work genuinely misses the goal and you want the assignee to redo it, re-call work_validate(action=\"retask\") with allow_regenerate=true. Otherwise, if the delivery meets the goal, bless the close with work_validate(action=\"validate\", kind=\"complete\", valid=true); if entirely new work is needed, create a NEW task with work_open(kind=\"task\").`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "return `OK: task \"${title}\" stays paused. The user can resume it from the dashboard, or you can later call work_schedule(action=\"resume\").`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "if (!userQuote) return 'Error: user_quote is required (the user\\'s exact reply, for the audit trail).';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "upholdClaim(taskId, statusToState(task.status), 'owner', 'user', `owner confirmed in chat: ${userQuote.slice(0, 200)}`);",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "reason: 'user confirmed in chat reply',",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`The user will make the final call. While awaiting_user_verdict=1 the PM will leave this task alone, do not retry the rejected transition.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "brief: `I confirmed the block on \"${task.title}\" (${taskId.slice(0, 8)}) is a real obstacle. Please surface it to the user or unblock it manually.`,",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "return 'Error: reject_reason is required when valid=false. One-sentence directive (e.g. \"you have not actually asked the user, do that first\" or \"this is a workaround not a block\").';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "`assigned to me (${agentId}). The user verdict request follows. Show this verbatim to ${getOwnerName()} (as your written reply if that turn is talking to them, otherwise in an explicit send that names them) and ` +",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "return `[OK] user verdict requested on task ${taskId.slice(0, 8)}. The user will reply. While awaiting, do not retry the rejected transition.`;",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "if (!status) return 'Error: status is required (the status the user chose).';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 },
 {
  "file": "tracker/tools.ts",
  "line": "if (!userQuote) return 'Error: user_quote is required (the user\\'s exact reply, for audit).';",
  "reason": "not an instruction about whom to tell: a context phrase (\"earlier in this conversation\"), a tool-argument description, owner-facing platform text, or text addressed to the PM"
 }
];
