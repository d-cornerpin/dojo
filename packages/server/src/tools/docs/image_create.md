# image_create

Generate an image from a text description. **The engine owns the whole delivery flow. You write nothing around this call.** Call the tool, end your turn — the finished image arrives in the chat on its own, 10-60 seconds later, in its own message with its own caption.

## Parameters

- **description** (string, required): A detailed plain-English description of what the image should show — subject, setting, composition, mood, style, lighting, colors, specific details. See "How to write a good description" below. Plain English only: no image-model flags (`--ar 16:9`, `--v 6`, `--style raw`).
- **title** (string, optional): 2 to 6 plain words summarizing the subject — `coffee shop sunset`, `golden retriever puppy`, `fantasy castle at dusk`. It becomes the file name the user sees when they download the image, so pass it on every call. Omit it and the file falls back to a generic id, which is what the user then has to live with. Plain words only: no file extension, no quotes, no punctuation (anything else is stripped, and the name is cut at 50 characters).
- **aspect_ratio** (string, optional): one of `1:1` (square), `16:9` (landscape), `9:16` (portrait / vertical), `4:3` (standard), `3:4` (portrait standard). Defaults to `1:1`.
- **style_hint** (string, optional): a style override such as `photorealistic`, `illustration`, `watercolor`, `3D render`, `pixel art`, `line drawing`. It is appended to your description as an explicit style instruction. Omit it and the style comes from the description itself.

## THE ONE-ACK LAW: the engine speaks, you stay silent

Exactly one acknowledgement reaches the user per image, and it is not yours.

1. **The waiting ack is the engine's.** When someone is waiting on the other end, the engine posts the short "On it." itself. You do not write it.
2. **The delivery is the engine's.** When the image is ready the engine posts it directly into the chat as its own message — the image, with a short caption ("Here you go."). No model turn is involved.
3. **You get no second turn.** This is a fire-and-forget generator: the engine ends your tool phase the moment you call it. There is no later round in which you could present the image, and you do not need one.

So: **no preamble before the call, no follow-up after it.** Do not write "I'm generating that now", do not write "here's your image", do not describe the image. Anything you write is a second message about an event the user has already been told about twice — it reads as the Dojo repeating itself, and it is the single most common failure on this tool. The tool result you get back says `End your turn now.` It means it.

Never name the image model or any internal system to the user. As far as they are concerned, the Dojo made the image.

## What the tool result tells you

The call returns immediately — this is a receipt, not the image. It carries:

- a `request_id` for the generation (the same id appears in the file name and the logs),
- where the finished image will land. On a dashboard turn it goes to the chat. On a turn that came in over iMessage the engine also texts the finished file to the person who asked, so never tell an iMessage requester to "check the dashboard" — they cannot see it and they are about to receive the image itself.
- a warning if your own model has no vision capability. You will never see the pixels. Do not describe what is "in" the image; anything you say about its visual contents is a hallucination.

## How to write a good description

You are commissioning an artist. The more specific and vivid the description, the better the result. Think about:

- **Subject:** What is the main focus? Who or what is in the image?
- **Setting:** Where is it? Indoor/outdoor, time of day, location details.
- **Composition:** Close-up, wide shot, angle, what is in the foreground vs. the background.
- **Mood / atmosphere:** Cheerful, moody, dramatic, peaceful, tense.
- **Style:** Photorealistic, illustrated, painted, 3D rendered, pixel art, line drawing. (Or leave it to `style_hint`.)
- **Lighting:** Warm golden hour, cool moonlight, harsh studio, soft natural, neon, high contrast.
- **Colors:** Warm vs. cool, monochromatic vs. saturated, muted vs. vivid.
- **Specific details:** Any must-have elements — objects, clothing, textures, text or typography (sparingly; image models struggle with text).

## Good vs. bad descriptions

**Bad:** `"A cat"`

**Good:** `"A photorealistic close-up of a ginger tabby cat asleep on a sunlit windowsill, warm afternoon light streaming through sheer white curtains, shallow depth of field with the background softly blurred, cozy home atmosphere"`

**Bad:** `"Cool logo for my company"`

**Good:** `"A minimalist logo for a dojo-themed agent platform. Stylized torii gate with subtle circuit board patterns integrated into the wood. Black and red on white background. Flat design, vector style, clean lines, no text."`

## What not to do

- **Don't write the prompt in image-model syntax.** No `--v 6 --ar 16:9 --style raw` flags. Describe what you want in plain English and use `aspect_ratio` / `style_hint` for the rest; the engine translates for whichever model is configured.
- **Don't request copyrighted characters, branded IP, or real named people**, and don't request unsafe content. The image model refuses, and the refusal comes back as a failure message in the chat.
- **Don't send a vague description and expect a clarifying question.** The call is one-way — nothing will come back to ask you what you meant. Decide the details yourself, or ask the USER before you call.
- **Don't pretend you have the image.** Until the engine posts it, it does not exist; after the engine posts it, the user already has it.
- **Don't re-call for the same request.** One call, one image. A second call on the same ask generates (and charges for) a second image.

## Example call

```
image_create(
  description: "A minimalist logo for a dojo-themed agent platform. Stylized torii gate with subtle circuit board patterns integrated into the wood. Black and red on white background. Flat design, vector style, clean lines.",
  title: "dojo torii logo",
  aspect_ratio: "1:1"
)
```

Then end your turn. Nothing else.

## Error cases

- **No image model configured:** the call returns an error immediately and nothing is generated. This is the one case that IS yours to speak: tell the user image generation is unavailable until a model is picked in Settings → Dojo → Image Generation Model, and do not retry.
- **Generation failed** (model error, content policy, provider outage): the engine writes the failure into the chat itself, as "I wasn't able to generate that image: …". You do not need to relay it. Do not fire the same description again on a whim; change the description or wait, and only if the user asks.
- **The user pressed stop:** the generation is cancelled, no image is made, and nothing is said to anyone. Don't announce a cancellation the user just performed.
- **Delivery failed** (rare): the engine writes a note into the chat carrying the file path of the image it could not attach. If you see one, you may tell the user the image was generated and where it is.
