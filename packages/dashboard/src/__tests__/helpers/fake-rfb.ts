// A stand-in for noVNC's RFB class: keeps its listeners so a test can fire the events a real
// connection would, and records every instance so a test can tell the old connection from the new.
export class FakeRfb {
  static instances: FakeRfb[] = [];
  listeners: Record<string, Array<(ev: Event) => void>> = {};
  sent: Array<{ username?: string; password?: string }> = [];
  disconnected = false;
  viewOnly = true;
  scaleViewport = true;
  background = '';
  constructor(public target: Element, public url: string, public opts: unknown) { FakeRfb.instances.push(this); }
  addEventListener(name: string, fn: (ev: Event) => void) { (this.listeners[name] ||= []).push(fn); }
  removeEventListener() { /* not needed */ }
  sendCredentials(c: { username?: string; password?: string }) { this.sent.push(c); }
  disconnect() { this.disconnected = true; }
  focus() { /* no-op */ }
  fire(name: string, detail?: unknown) {
    for (const fn of this.listeners[name] ?? []) fn(new CustomEvent(name, { detail }));
  }
  static reset() { FakeRfb.instances = []; }
  static get last(): FakeRfb { return FakeRfb.instances[FakeRfb.instances.length - 1]; }
}
