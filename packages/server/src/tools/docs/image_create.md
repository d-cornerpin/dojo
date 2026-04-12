# image_create

Generate an image from a text description. The image appears automatically in the chat when ready — you don't need to do anything after calling this tool except tell the user it's on its way.

## Parameters

- **description** (string, required): A detailed plain-English description of what you want the image to show.
- **aspect_ratio** (string, optional): `1:1`, `16:9`, `9:16`, `4:3`, or `3:4`. Defaults to `1:1`.
- **style_hint** (string, optional): Override like `photorealistic`, `illustration`, `watercolor`, `3D render`, `pixel art`, `line drawing`.

## CRITICAL: This tool returns IMMEDIATELY, NOT the finished image

Image generation takes **a few seconds to a minute** depending on the model. The tool returns as soon as generation has started. When you call this tool, you MUST:

1. **Tell the user something like** "I'm generating that image now — should be ready in a moment." Do NOT mention "Imaginer" or any internal system name. As far as the user knows, YOU are creating the image.
2. **End your turn.** The finished image will appear automatically in the chat as a new message with a thumbnail — you don't need to do anything else.
3. **Do NOT pretend to have the image yet** in your response. You don't — it's still being generated.

## How to Write Good Descriptions

You are commissioning an artist. The more specific and vivid your description, the better the result. Think about:

- **Subject:** What's the main focus? Who/what is in the image?
- **Setting:** Where is it? Indoor/outdoor, time of day, location details.
- **Composition:** Close-up, wide shot, angle, what's in the foreground vs. background.
- **Mood / atmosphere:** Cheerful, moody, dramatic, peaceful, tense.
- **Style:** Photorealistic, illustrated, painted, 3D rendered, pixel art, line drawing. (Or leave it to Imaginer via `style_hint`.)
- **Lighting:** Warm golden hour, cool moonlight, harsh studio, soft natural, neon, high contrast.
- **Colors:** Warm vs. cool, monochromatic vs. saturated, muted vs. vivid.
- **Specific details:** Any must-have elements — specific objects, clothing, textures, text or typography (sparingly — image models struggle with text).

## Good vs. Bad Descriptions

**Bad:** `"A cat"`

**Good:** `"A photorealistic close-up of a ginger tabby cat asleep on a sunlit windowsill, warm afternoon light streaming through sheer white curtains, shallow depth of field with the background softly blurred, cozy home atmosphere"`

**Bad:** `"Cool logo for my company"`

**Good:** `"A minimalist logo for a dojo-themed agent platform. Stylized torii gate with subtle circuit board patterns integrated into the wood. Black and red on white background. Flat design, vector style, clean lines, no text."`

## What Not to Do

- **Don't write prompts in image-model syntax.** No `--v 6 --ar 16:9 --style raw` flags. Just describe what you want in plain English — Imaginer handles translation to whatever the underlying image model expects.
- **Don't request copyrighted characters, branded IP, or real named people.** Imaginer will refuse and tell you why.
- **Don't request unsafe content** — violence, sexual content, etc. Imaginer will refuse.
- **Don't ask Imaginer clarifying questions** through the tool. The tool is fire-and-forget; if your description is vague, Imaginer will fill in sensible defaults and note them in the delivery message.
- **Don't pretend you have the image already** in your response to the user. You don't — you have an acknowledgement. The image is on its way.

## Example Call

```
image_create(
  description: "A minimalist logo for a dojo-themed agent platform. Stylized torii gate with subtle circuit board patterns integrated into the wood. Black and red on white background. Flat design, vector style, clean lines.",
  aspect_ratio: "1:1"
)
```

## What You'll Hear Back

Imaginer sends you **two messages** via `send_to_agent`:

1. **An immediate ack** (within a couple of seconds): "Got your image request (request_id: img_abc123). Working on it now. Description: '...'. Expected wait: 10–60 seconds."
2. **A delivery message** (10–60 seconds later): includes the original description echoed back, the file path, a caption, any interpretation notes, AND the image as an actual attachment in the `attach_paths`. When you see this message, the image is already a thumbnail in the user's chat view — you just need to acknowledge it and share the caption.

Multiple in-flight requests are fine; match `request_id`s to your mental model of the conversation.

## Error Cases

- **No image model configured:** Tool returns an error with the reason. Tell the user image generation is unavailable until a model is configured in Settings → Dojo → Imaginer. Don't retry.
- **Imaginer disabled / terminated:** Same — return the error to the user, don't retry.
- **Imaginer refuses the request** (copyright, safety): Imaginer will send you a `send_to_agent` message explaining what it can't do and suggesting an alternative. Relay to the user.
