// noVNC ships no TypeScript types. Minimal ambient declaration for the bits we
// use (the RFB client). RFB extends EventTarget, so addEventListener works.
declare module '@novnc/novnc/core/rfb.js' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }
  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string | unknown, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    focus(): void;
    blur(): void;
  }
}
