# image_generate_internal

**IMAGINER ONLY.** The low-level tool Imaginer uses to actually invoke the configured image-generation model and save the result to disk. Other agents cannot call this tool — they must use `image_create` instead, which routes through Imaginer.

## Parameters

- **prompt** (string, required): The full crafted prompt text Imaginer wants the image model to render. Should be a polished, detailed prompt in the style the image model expects.
- **aspect_ratio** (string, optional): `1:1`, `16:9`, `9:16`, `4:3`, or `3:4`. Appended to the prompt so the image model honors it. Defaults to `1:1`.

## What It Does

1. Reads the configured image generation model from `imaginer_image_model` in the config table.
2. Calls the model via OpenAI-compatible `/v1/chat/completions` with `modalities: ['image', 'text']`.
3. Decodes the returned base64 data URL.
4. Saves to `~/.dojo/uploads/generated/<uuid>.png`.
5. Returns the absolute file path, filename, MIME type, size, token usage, cost, and any warnings.

## Return Format

On success:

```
Image generated successfully.
file_path: /Users/dan/.dojo/uploads/generated/abc123.png
filename: abc123.png
mime_type: image/png
size_bytes: 245678
model: google/gemini-2.5-flash-image
latency_ms: 12450
cost_usd: 0.038700
```

On error, the tool returns a plain error string with the failure code (MODEL_NOT_FOUND, NO_CREDENTIAL, CAPABILITY_MISSING, HTTP_ERROR, NO_IMAGE_RETURNED, DECODE_ERROR, WRITE_ERROR, UNKNOWN) and a human-readable message. Imaginer should relay this to the requesting agent via `send_to_agent` so they can tell the user what went wrong.

## Flow

This tool is called exactly once per `image_create` request, in the middle of Imaginer's standard four-step flow:

1. Send immediate ack to requesting agent via `send_to_agent`
2. Craft a prompt
3. **Call `image_generate_internal` with the crafted prompt** ← this tool
4. Deliver result to requesting agent via `send_to_agent` with `attach_paths` set to the returned `file_path`

Do NOT call this tool outside of that flow. Do NOT call it twice for the same request. Do NOT skip steps 1 or 4.
