// The answer while the Dojo boots: 503 either way (the watchdog reads it as not up yet); a browser gets a
// page that reloads itself every few seconds, every other caller the JSON error.
const PAGE = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Dojo is starting</title>'
  + '<body style="font-family:system-ui;text-align:center;padding-top:20vh"><h1>Dojo is starting</h1><p>This page reloads by itself.</p>';

export function startingAnswer(request: Request): Response {
  const page = request.headers.get('accept')?.includes('text/html');
  return page
    ? new Response(PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })
    : new Response(JSON.stringify({ ok: false, error: 'Dojo is starting' }), { status: 503, headers: { 'content-type': 'application/json' } });
}
