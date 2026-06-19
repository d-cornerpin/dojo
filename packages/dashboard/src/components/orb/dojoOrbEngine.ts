/* ============================================================
   DOJO ORB engine (ported verbatim from the v3 HTML prototype)

   This is a structural port only: the rendering, shader source,
   and state tables are copied exactly from the prototype. The
   single behavioral change is that every former module global now
   lives inside the createOrbEngine() closure, so multiple orbs can
   coexist and a single orb can be torn down cleanly (React
   StrictMode double mount/unmount, route changes, context loss).

   Source ranges in dojo-orb-v3.html:
     - makeBackdrop IIFE          2786-2831 (adapted to a function)
     - VERT / FRAG shader source  2852-3460 (verbatim)
     - WebGL setup / compile/init 3462-3672 (adapted to closure)
     - layout                     3674-3703 (adapted: stage vars)
     - STATES / EMOTIONS / SYSTEM 3710-4000 (verbatim)
     - state machine + API        4002-4047 (adapted: no window)
     - envelope                   4049-4060 (verbatim)
     - pointer listeners          4062-4080 (adapted: tracked)
     - main loop scaffolding      4082-4091 (adapted)
     - Task / ProgressLine        4099-4222 (adapted: stageEl)
     - frame()                    4224-4410 (verbatim math)
   ============================================================ */

export type OrbStateName = 'idle' | 'listening' | 'thinking' | 'speaking';
export type OrbEmotionName =
  | 'startled'
  | 'joyous'
  | 'working'
  | 'mad'
  | 'calm'
  | 'sleepy'
  | 'confused'
  | 'success'
  | 'sheepish'
  | 'curious'
  | 'sympathetic'
  | 'excited'
  | 'waiting'
  | 'alert';
export type OrbSystemName = 'muted' | 'offline' | 'asleep';
export type OrbTaskName =
  | 'image'
  | 'audio'
  | 'song'
  | 'video'
  | 'compaction'
  | 'dreamer'
  | 'healer';

export interface OrbTaskOpts {
  progress?: number;
}

export type OrbEngine = {
  setState: (name: OrbStateName) => void;
  setEmotion: (name: OrbEmotionName | null | 'none') => void;
  setSystem: (name: OrbSystemName | null | 'none' | 'wake') => void;
  pulse: () => void;
  startTask: (name: OrbTaskName, opts?: OrbTaskOpts) => void;
  updateTask: (progress: number) => void;
  endTask: (name?: OrbTaskName) => void;
  resize: () => void;
  /** Tint the orb toward an agent's hue (degrees, 0..360). null/0 = the
   *  signature champagne. The shift animates smoothly. */
  setHue: (deg: number | null) => void;
  /** Drive the orb's pulse from a live audio level (0..1) during a voice
   *  session; pass null to return to the simulated envelope. */
  setEnv: (level: number | null) => void;
  /** Hold an alert tint over the orb: 0 none, 0.5 warning (amber), 1 error
   *  (red). Fades in/out; stays until changed. */
  setAlert: (level: number) => void;
  /** Show a static glyph inside the glass for a notification ('alert' | 'check'
   *  | a task name), or null to clear. Overrides the spinning task glyph. */
  setNoteGlyph: (name: string | null) => void;
  destroy: () => void;
};

export function createOrbEngine(opts: {
  canvas: HTMLCanvasElement;
  bgImg: HTMLImageElement; // the <img> the shader refracts (its .src is set by the painted backdrop)
  stageEl: HTMLElement; // the element the ProgressLine DOM node is appended into
}): OrbEngine {
  const canvas = opts.canvas;
  const img = opts.bgImg;
  const stageEl = opts.stageEl;

  /* ---------- backdrop: paints the offscreen image the shader refracts ----------
     Ported verbatim from the makeBackdrop IIFE (2786-2831); the only change is
     that it writes bgImg.src instead of document.getElementById("bg").src. */
  function makeBackdrop(): void {
    /* Paint at the viewport's aspect ratio (capped) rather than a fixed
       1600x1000. Both the visible `.dojo3-orb-bg` img and the shader's bg()
       cover-scale this texture; a fixed landscape image cover-scaled onto a
       tall phone ballooned the cast glow into a screen-filling white wash. By
       matching the viewport aspect AND sizing the glow off the SHORTER side, the
       orb's cast light stays a contained halo on any shape. */
    const vw = Math.max(1, typeof innerWidth === 'number' ? innerWidth : 1600);
    const vh = Math.max(1, typeof innerHeight === 'number' ? innerHeight : 1000);
    const aspect = vw / vh;
    const CAP = 1600;
    let W: number, H: number;
    if (aspect >= 1) { W = CAP; H = Math.max(1, Math.round(CAP / aspect)); }
    else { H = CAP; W = Math.max(1, Math.round(CAP * aspect)); }
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    if (!x) return;

    /* parchment wash */
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#f3ead8');
    g.addColorStop(0.45, '#efe5d0');
    g.addColorStop(1, '#e7dabf');
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);

    /* glow the orb appears to cast on the room. Centered near the top where the
       orb sits; radius bounded by the SHORTER side so a portrait phone gets a
       tight halo instead of a blown-out wash. */
    const glowR = Math.min(W * 0.62, H * 0.46);
    const gy = H * (aspect >= 1 ? 0.16 : 0.12);
    const r = x.createRadialGradient(W / 2, gy, 16, W / 2, gy, glowR);
    r.addColorStop(0, 'rgba(255,250,238,0.92)');
    r.addColorStop(0.25, 'rgba(252,240,216,0.42)');
    r.addColorStop(0.6, 'rgba(248,232,200,0.11)');
    r.addColorStop(1, 'rgba(248,232,200,0)');
    x.fillStyle = r;
    x.fillRect(0, 0, W, H);

    /* (horizon hairline removed: it read as an unwanted bar across the top
       of the page; the glow + grain give the lens enough to refract) */

    /* corner vignette */
    const v = x.createRadialGradient(W / 2, H * 0.45, H * 0.3, W / 2, H * 0.45, H * 1.05);
    v.addColorStop(0, 'rgba(110,88,60,0)');
    v.addColorStop(1, 'rgba(110,88,60,0.15)');
    x.fillStyle = v;
    x.fillRect(0, 0, W, H);

    /* fine grain so the gradients never band */
    const n = document.createElement('canvas');
    n.width = 320;
    n.height = 200;
    const nx = n.getContext('2d');
    if (nx) {
      const id = nx.createImageData(320, 200);
      for (let i = 0; i < id.data.length; i += 4) {
        const k = 110 + ((Math.random() * 30) | 0);
        id.data[i] = id.data[i + 1] = id.data[i + 2] = k;
        id.data[i + 3] = 12;
      }
      nx.putImageData(id, 0, 0);
      for (let yy = 0; yy < H; yy += 200)
        for (let xx = 0; xx < W; xx += 320) x.drawImage(n, xx, yy);
    }

    img.src = c.toDataURL('image/png');
  }

  /* ============================================================
     DOJO ORB v2 runtime shaders (copied verbatim)
     ============================================================ */

  const VERT = `
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

  const FRAG = `
precision highp float;

uniform sampler2D u_tex;
uniform vec2  u_imgRes;      /* screenshot pixels */
uniform vec2  u_viewport;    /* css px */
uniform vec2  u_canvasPos;   /* canvas top-left in viewport css px */
uniform vec2  u_canvasSize;  /* css px */
uniform float u_dpr;
uniform float u_time;
uniform vec2  u_center;      /* bubble center in canvas css px */
uniform float u_radius;      /* base radius css px */
uniform vec2  u_mouse;       /* viewport css px */
uniform float u_mouseIn;     /* 0..1 pointer is on the page */
uniform vec2  u_vel;         /* bubble velocity, css px/s, smoothed */

/* state-driven params, eased on the JS side */
uniform float u_wobble;      /* silhouette noise amplitude */
uniform float u_wobSpeed;
uniform float u_swirl;       /* internal caustic motion */
uniform float u_squish;      /* anisotropic squash amount */
uniform float u_warmth;      /* 0 cool pearl .. 1 warm amber */
uniform float u_hueShift;    /* radians — rotates the whole orb toward the active agent's hue (0 = signature champagne) */
uniform float u_alert;       /* 0 none .. 0.5 warning(amber) .. 1 error(red): a held alert tint over the whole orb, independent of hue */
uniform float u_ring;        /* rim ring brightness */
uniform float u_streak;      /* equator streak brightness */
uniform float u_env;         /* live voice/think envelope 0..1 */
uniform float u_refr;        /* refraction strength */
uniform float u_disp;        /* chromatic dispersion strength */
uniform float u_lens;        /* rim lensing mix */
uniform vec3  u_ripple;      /* x: age s, y: angle, z: amp */
uniform float u_haze;        /* atmosphere strength multiplier */
uniform float u_atmos;       /* outside cast-light (halo/flare/bloom) scale — dimmed on small screens so the orb doesn't wash out the chat */
uniform float u_vsquash;     /* vertical stretch(+)/squash(-), volume kept */
uniform float u_flash;       /* momentary light pulse 0..~1 */
uniform float u_anger;       /* 0..1 hot red shift */
uniform float u_breath;      /* breathing depth multiplier */
uniform float u_heartbeat;   /* healer pulse: radius swell 0..1 per beat */
uniform float u_shapeDroop;  /* + sag bottom-heavy, - buoyant top-full */
uniform float u_shapeAlert;  /* peak rising from the crown */
uniform float u_shapeSpike;  /* angry bristle around the silhouette */
uniform vec2  u_lean;        /* mass bulges toward this direction */
uniform float u_desat;       /* 0..1 drains color and life (offline) */
uniform float u_seal;        /* 0..1 frosted, closed-eye muted look */
uniform float u_centerClear; /* TEST: 0 solid .. 1 fully see-through center */
uniform float u_clearFade;   /* TEST: where the clear zone fades to solid (q) */
uniform sampler2D u_icons;   /* task glyph atlas */
uniform float u_atlasCols;   /* columns in the atlas grid */
uniform float u_atlasRows;   /* rows in the atlas grid */
uniform float u_taskIcon;    /* active glyph index, -1 = none */
uniform float u_taskAmt;     /* 0..1 fade of the glyph in the glass */
uniform float u_taskSpin;    /* radians, current spin angle */

/* ---------- noise ---------- */
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.,0.)), f.x),
             mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<3;i++){ v += a*noise(p); p = p*2.13 + 17.7; a *= 0.5; }
  return v;
}

float G(float x){ return exp(-x*x); }

/* ---------- anamorphic lens flare ----------
   One light source shared by the glass, the page, and the
   reflection, so every layer agrees. Horizontal streak, a hot
   point where it crosses the rim, pink-white core, gold falloff. */
vec4 flareF(vec2 u, float t, float env, float amp){
  float y0 = -0.05 + 0.02*sin(t*0.21);
  float dy = u.y - y0;
  float ax = abs(u.x);
  float reach = exp(-ax/2.4);
  float core = G(dy*22.0);
  float glow = G(dy*7.0);
  float bloom= G(dy*2.6);
  float B = (core*0.9 + glow*0.35 + bloom*0.10) * reach;
  /* hot point riding the left rim, a faint twin inside */
  float hx = -1.0 + 0.05*sin(t*0.17 + 1.0);
  vec2 hp = u - vec2(hx, y0);
  float hot = exp(-dot(hp,hp)*60.0)*1.3
            + exp(-abs(hp.y)*30.0)*exp(-abs(hp.x)*6.0)*0.45;
  vec2 hp2 = u - vec2(0.55, y0);
  float hot2 = exp(-dot(hp2,hp2)*140.0)*0.5;
  float shimmer = 0.85 + 0.15*fbm(vec2(u.x*1.5 - t*0.6, 2.0));
  float I = (B + hot + hot2) * amp * (0.5 + 0.5*env) * shimmer;
  vec3 c = vec3(1.0,0.93,0.86)*I
         + vec3(1.0,0.76,0.78)*core*reach*amp*0.30   /* pink core */
         + vec3(1.0,0.83,0.55)*glow*reach*amp*0.18;  /* gold haze */
  return vec4(c, I);
}

/* ---------- caustic bands ----------
   Broad, slow ribbons of light the orb casts across the page,
   one sweeping up to the right, a fainter one down to the left,
   with a whisper of prism across their width. */
vec4 bandsF(vec2 u, float t, float env, float amp){
  float ax = abs(u.x);
  float y1 = 0.10 - 0.16*u.x + 0.08*sin(u.x*0.7 + t*0.11);
  float w1 = 0.26 + 0.13*ax;
  float s1 = (u.y - y1)/w1;
  float g1 = exp(-s1*s1) * exp(-max(ax-0.9, 0.0)/2.2);
  float y2 = -0.28 + 0.10*u.x + 0.10*sin(u.x*0.5 - t*0.09 + 2.0);
  float w2 = 0.34 + 0.15*ax;
  float s2 = (u.y - y2)/w2;
  float g2 = exp(-s2*s2) * exp(-max(ax-1.0, 0.0)/2.6) * 0.6;
  float gate = smoothstep(0.7, 1.2, ax);   /* page only, not the glass */
  float I = (g1 + g2) * gate * amp * (0.5 + 0.5*env);
  vec3 prism = vec3(0.05*s1, 0.0, -0.06*s1);          /* rainbow drift */
  vec3 c = (vec3(1.0,0.95,0.86) + prism) * I;
  return vec4(c, I);
}

/* ---------- focused caustics ----------
   The sphere concentrates light into bright patches that land on
   the page a couple of radii away. By then dispersion has spread
   the colors, so each patch is a white-hot core fringed with a
   true spectrum: red outermost, violet innermost. */
vec3 spectrum(float x){
  return clamp(vec3(0.5) + 0.5*cos(6.2831*(x + vec3(0.0, -0.33, -0.67))), 0.0, 1.0);
}

vec4 causticArc(vec2 us, float t, float phi, float rho, float w,
                float sig, float amp, float goldMix, inout float fog){
  float rr = length(us);
  float th = atan(us.y, us.x);
  float dA = atan(sin(th - phi), cos(th - phi));
  float s = (rr - rho)/w;                 /* signed position across the band */
  float angI  = exp(-pow(dA/sig, 2.0));   /* falloff along the arc */
  float coreI = exp(-s*s*2.2);            /* white-hot center */
  float specI = exp(-s*s*0.7);            /* wider spectral fringe */
  float shimmer = 0.8 + 0.2*fbm(vec2(th*2.0 + t*0.18, rr*1.5 - t*0.1));
  vec3 spec = spectrum(clamp(s*0.45 + 0.40, 0.0, 0.75));
  spec = clamp(spec*spec*2.0, 0.0, 1.0);            /* deepen saturation */
  spec = mix(spec, vec3(1.0,0.88,0.62), goldMix);   /* some arcs lean gold */
  float I = angI * amp * shimmer;
  fog += exp(-s*s*0.30) * angI * amp;   /* footprint, used to burn fog */
  /* strictly additive light: a white-hot core plus positive spectral
     fringes. Every channel rises; this can never darken the page. */
  float bloomI = exp(-s*s*0.25);
  vec3 light = vec3(1.0,0.99,0.95) * (coreI*0.55 + bloomI*0.10) * I
             + spec * specI * 0.85 * I;
  float mask = clamp((coreI*0.7 + specI*0.7) * I * 1.6, 0.0, 1.0);
  return vec4(light, mask);
}

vec4 causticsF(vec2 u, float t, float env, out float fog){
  vec2 us = u * vec2(1.0, 1.45);   /* squashed: light lying on the page */
  float e = 0.5 + 0.5*env;
  fog = 0.0;
  vec4 c = vec4(0.0);
  /* three patches, drifting almost imperceptibly:
     bright arc upper right, medium lower left, faint gold right */
  c += causticArc(us, t, -0.38 + 0.05*sin(t*0.050),       2.25 + 0.06*sin(t*0.07), 0.34, 0.62, 0.42*e, 0.15, fog);
  c += causticArc(us, t,  2.70 + 0.06*sin(t*0.045 + 2.0), 2.15 + 0.05*sin(t*0.06), 0.40, 0.50, 0.30*e, 0.25, fog);
  c += causticArc(us, t,  0.28 + 0.05*sin(t*0.060 + 4.0), 2.85,                    0.50, 0.50, 0.24*e, 0.55, fog);
  return c;
}

/* ---------- floor reflection ----------
   A soft mirrored ghost of the orb on the page below it: bright
   floor arc, rim ring, and the flare, all flipped and fading. */
vec4 reflectF(vec2 u, float t, float env, float flAmp){
  float yF = 1.16;                      /* mirror plane, in radii */
  if (u.y < yF) return vec4(0.0);
  vec2 um = vec2(u.x, 2.0*yF - u.y);
  float qm = length(um);
  float fade = exp(-(u.y - yF)*1.5) * 0.26;
  float ring = smoothstep(0.09, 0.0, abs(qm - 0.96)) * 0.45;
  float fill = exp(-qm*qm*1.6) * 0.28;
  vec2 fg = um - vec2(0.0, 0.85);
  float floorG = exp(-dot(fg,fg)*3.0) * 0.55;
  vec4 fl = flareF(um, t, env, flAmp*0.5);
  float I = (ring + fill + floorG) * fade;
  vec3 c = vec3(1.0, 0.96, 0.90) * I + fl.rgb * fade * 1.2;
  float a = I + fl.a * fade;
  float lim = smoothstep(1.5, 1.0, qm);  /* keep it orb-sized */
  return vec4(c, a) * lim;
}

/* ---------- background sampling (object-fit: cover, top center) ---------- */
vec3 bg(vec2 screenPx){
  float s = max(u_viewport.x/u_imgRes.x, u_viewport.y/u_imgRes.y);
  vec2 disp = u_imgRes * s;
  vec2 off  = vec2((u_viewport.x - disp.x)*0.5, 0.0);
  vec2 uv   = (screenPx - off) / disp;
  uv = clamp(uv, vec2(0.001), vec2(0.999));
  return texture2D(u_tex, uv).rgb;
}

/* ---------- organic radius: the living silhouette ---------- */
float surface(float ang, float t){
  /* layered slow sines with irrational ratios, plus fbm shimmer */
  float w = 0.0;
  w += 0.55*sin(ang*3.0 + t*0.61);
  w += 0.30*sin(ang*5.0 - t*0.83 + 1.7);
  w += 0.18*sin(ang*8.0 + t*1.31 + 4.2);
  w += 0.55*(fbm(vec2(ang*0.95, t*0.22)) - 0.5);
  return w;
}

void main(){
  /* canvas-space css px, y down */
  vec2 p = vec2(gl_FragCoord.x/u_dpr, u_canvasSize.y - gl_FragCoord.y/u_dpr);
  vec2 screenPx = u_canvasPos + p;
  float t = u_time;

  /* ----- soft-body silhouette ----- */
  vec2 rel = p - u_center;

  /* emotion squash & stretch, volume preserving: stretching taller
     narrows the body and vice versa (Disney rule one) */
  rel.y /= max(1.0 + u_vsquash, 0.4);
  rel.x /= max(1.0 - u_vsquash*0.55, 0.5);

  /* slow anisotropic squish: rotate, scale, rotate back */
  float phi = t*0.21;
  float sq = u_squish * (0.6 + 0.4*sin(t*0.53));
  vec2 cs = vec2(cos(phi), sin(phi));
  vec2 rl = vec2(rel.x*cs.x + rel.y*cs.y, -rel.x*cs.y + rel.y*cs.x);
  rl *= vec2(1.0 - sq, 1.0 + sq);
  rel = vec2(rl.x*cs.x - rl.y*cs.y, rl.x*cs.y + rl.y*cs.x);

  float ang  = atan(rel.y, rel.x);
  float dist = length(rel);

  /* motion: how fast the bubble is traveling right now */
  float speed = length(u_vel);
  vec2 vdir = u_vel / max(speed, 0.001);
  float vAng = atan(vdir.y, vdir.x);
  float moveGate = smoothstep(4.0, 55.0, speed);

  float r = u_radius;
  /* breathing */
  r *= 1.0 + 0.012*u_breath*sin(t*0.84) + 0.02*u_env;
  /* healer heartbeat: a firm swell on each beat (driven from JS as a
     lub-dub envelope), volume conserved so it reads as a pulse */
  r *= 1.0 + u_heartbeat * 0.085;
  /* organic wobble */
  r *= 1.0 + u_wobble * surface(ang, t*u_wobSpeed);
  /* momentum: stretches along its direction of travel */
  float cosd = cos(ang - vAng);
  r *= 1.0 + moveGate * 0.05 * (cosd*cosd*2.0 - 1.0);

  /* ----- emotion shape language (y is down: sin(ang)>0 = bottom) ----- */
  float sa = sin(ang);
  /* droop: teardrop sag (+) or buoyant lift (-) */
  r *= 1.0 + u_shapeDroop * (0.24*pow(max(sa, 0.0), 1.5)
                           - 0.12*pow(max(-sa, 0.0), 2.0));
  /* alert: a peak shooting straight up from the crown */
  float aTop = atan(sin(ang + 1.5708), cos(ang + 1.5708));
  r *= 1.0 + u_shapeAlert * 0.62 * exp(-aTop*aTop*14.0);
  /* bristle: sharp animated spikes all around */
  float sp = pow(abs(sin(ang*9.0 + t*6.0)), 0.45)*0.6
           + pow(abs(sin(ang*13.0 - t*8.0)), 0.45)*0.4;
  r *= 1.0 + u_shapeSpike * 0.15 * (sp - 0.5)*2.0;
  /* lean: mass bulges toward a direction, flattens opposite */
  r *= 1.0 + dot(vec2(cos(ang), sa), u_lean) * 0.22;

  /* cursor dent: the bubble yields where you push it */
  vec2 mRel = u_mouse - (u_canvasPos + u_center);
  float mDist = length(mRel);
  float mAng  = atan(mRel.y, mRel.x);
  float prox  = u_mouseIn * smoothstep(u_radius*2.4, u_radius*0.85, mDist);
  float dAng  = ang - mAng;
  dAng = atan(sin(dAng), cos(dAng)); /* wrap */
  float dent  = prox * exp(-dAng*dAng*3.2) * 0.18;
  r *= 1.0 - dent;
  /* and bulges slightly on the far side, like volume conserving */
  r *= 1.0 + prox * exp(-(3.14159-abs(dAng))*(3.14159-abs(dAng))*3.2) * 0.07;

  /* click ripple: a decaying wave running around the surface */
  float rAge = u_ripple.x;
  float rEnv = exp(-rAge*2.6) * u_ripple.z;
  r *= 1.0 + rEnv * 0.05 * sin(10.0*atan(sin(ang-u_ripple.y), cos(ang-u_ripple.y)) - rAge*14.0);

  float q = dist / r;            /* 0 center .. 1 rim */
  float aa = 1.5 / r;            /* anti-alias width in q units */

  /* ----- palette ----- */
  vec3 warmHi = mix(vec3(0.99,0.985,0.97), vec3(1.0,0.94,0.82), u_warmth);
  vec3 warmMid= mix(vec3(0.96,0.94,0.92), vec3(0.97,0.86,0.66), u_warmth);
  vec3 amber  = vec3(0.93,0.62,0.30);
  /* anger runs the palette hot */
  warmHi  = mix(warmHi,  vec3(1.0,0.66,0.48),  u_anger*0.6);
  warmMid = mix(warmMid, vec3(0.99,0.56,0.40), u_anger*0.7);
  amber   = mix(amber,   vec3(0.96,0.36,0.22), u_anger*0.8);

  vec3 col = vec3(0.0);
  float alpha = 0.0;

  if (q < 1.0 + aa) {
    /* ================= inside the bubble ================= */
    float qc = min(q, 1.0);
    float h  = sqrt(max(1.0 - qc*qc, 0.0));      /* pseudo sphere height */
    vec2 nrm = (dist > 0.001) ? rel/dist : vec2(0.0);
    vec2 centerScreen = u_canvasPos + u_center;

    /* meniscus lens profile, three zones in one monotonic curve:
       calm magnified center (convex-lens look), gently bowing
       midfield, and an aggressive outer ~20% where pow(q,4)
       compression takes over so content visibly wraps the rim.
       Both halves equal 1 at q=1: no seam with the outside world. */
    float shape = pow(max(1.0 - qc*qc, 0.0), 0.85);
    float wrapW = smoothstep(0.55, 1.0, qc) * 0.85;  /* rim takeover */
    float fWrap = pow(qc, 4.0);
    float dsp = u_disp;
    float fR = mix(qc*(1.0 - u_refr*shape),             fWrap, wrapW);
    float fG = mix(qc*(1.0 - u_refr*(1.0+dsp)*shape),   fWrap, wrapW);
    float fB = mix(qc*(1.0 - u_refr*(1.0+2.0*dsp)*shape), fWrap, wrapW);
    /* chromatic separation grows with grazing angle: strongest at
       the rim, whisper-subtle at the center */
    float rimD = pow(qc, 5.0) * dsp;
    float dR = r * fR;
    float dG = r * fG * (1.0 - 0.6*rimD);
    float dB = r * fB * (1.0 - 1.2*rimD);

    /* the refraction field slowly churns */
    float sw = u_swirl * (fbm(vec2(ang*1.4 + t*0.5, qc*3.0 - t*0.35)) - 0.5);
    vec2 tang = vec2(-nrm.y, nrm.x);
    vec2 swirlOff = tang * sw * r * 0.18;

    vec3 refracted;
    refracted.r = bg(centerScreen + nrm*dR + swirlOff).r;
    refracted.g = bg(centerScreen + nrm*dG + swirlOff).g;
    refracted.b = bg(centerScreen + nrm*dB + swirlOff).b;

    /* a thin wrapped sliver at the very edge, where a real droplet
       shows the world inverted for a hair's breadth */
    float lensBand = smoothstep(0.92, 0.985, qc) * u_lens;
    if (lensBand > 0.002) {
      float mirrorDist = r * (2.0 - qc);
      vec2 lensPx = centerScreen + nrm * mirrorDist;
      vec3 lensCol;
      lensCol.r = bg(lensPx).r;
      lensCol.g = bg(lensPx + nrm * r * 0.012).g;
      lensCol.b = bg(lensPx + nrm * r * 0.024).b;
      refracted = mix(refracted, lensCol, lensBand*0.55);
    }

    col = refracted;
    /* glass transmission: slightly darker, saturated, warm */
    float luma = dot(col, vec3(0.299,0.587,0.114));
    col = mix(vec3(luma), col, 1.18) * mix(vec3(0.90,0.885,0.87), vec3(0.92,0.88,0.83), u_warmth);

    /* internal volume: smoky core and a darker upper hemisphere,
       falling to a luminous floor, like the reference comps */
    vec2 unit = rel / r;
    float core = exp(-dot(unit - vec2(0.0,-0.30), unit - vec2(0.0,-0.30)) * 1.5);
    col = mix(col, col*mix(vec3(0.42,0.40,0.38), vec3(0.52,0.29,0.24), u_anger), core*0.66);
    float topShade = smoothstep(0.15, -0.85, unit.y);
    col = mix(col, col*vec3(0.60,0.58,0.56), topShade*0.40);
    float floorGlow = exp(-dot(unit - vec2(0.0,0.80), unit - vec2(0.0,0.80)) * 3.4);
    col += warmHi * floorGlow * 0.26;

    /* caustic shimmer inside the glass */
    float ca = fbm(vec2(ang*2.2 + t*0.4*u_wobSpeed, qc*4.0 + t*0.3));
    col += warmMid * smoothstep(0.62, 0.95, ca) * 0.07 * (0.5 + u_swirl);

    /* fresnel rim: grazing angles catch more light, so the whole
       refracted image lifts toward the edge and the rim glows */
    float fres = pow(qc, 5.0);
    col *= 1.0 + fres*0.22;
    col += warmHi * fres * (0.30 + 0.35*u_ring*(0.6 + 0.4*u_env));
    col += warmHi * u_flash * (0.22 + fres*0.55);   /* emotion pulse */

    /* motion: the leading edge compresses light and brightens */
    float lead = pow(max(dot(unit, vdir), 0.0), 3.0) * moveGate;
    col += warmHi * lead * fres * 0.55;

    /* thin bright ring just inside the silhouette; biased to the
       top arc, the Einstein-ring nod */
    float ringLine = smoothstep(0.035, 0.0, abs(qc - 0.965));
    float topArc = 1.0 + 0.9*smoothstep(0.2, -0.7, unit.y);
    float botArc = 0.6*smoothstep(0.25, 0.9, unit.y);
    col += warmHi * ringLine * topArc * (0.34 + 0.6*u_ring*u_env);
    col += warmMid * ringLine * botArc * 0.5;

    /* speculars: two soft window reflections that drift */
    vec2 s1 = vec2(-0.36 + 0.04*sin(t*0.32), -0.46 + 0.03*cos(t*0.27));
    float spec1 = exp(-dot(unit-s1, unit-s1)*14.0);
    vec2 s2 = vec2(0.32, 0.40);
    float spec2 = exp(-dot(unit-s2, unit-s2)*42.0);
    col += vec3(1.0) * (spec1*0.30 + spec2*0.34);

    /* the lens flare crossing through the glass, ripples with speech */
    vec2 uFl = unit;
    uFl.y += fbm(vec2(unit.x*2.4 - t*1.8, t*0.7))*0.08*u_env;  /* speech ripple */
    vec4 flIn = flareF(uFl, t, u_env, u_streak);
    col += flIn.rgb * 0.78;

    /* sealed (muted): milky frost and a closed-eye lid line, so an
       off mic is unmistakable at a glance */
    float lidY = 0.05 + 0.08*unit.x*unit.x;
    float lid = exp(-pow((unit.y - lidY)*7.0, 2.0));
    col = mix(col, vec3(0.93,0.92,0.90), u_seal*0.30);
    col = mix(col, col*vec3(0.52,0.49,0.47), u_seal*lid*0.85);

    /* offline/dormant: drain the color and dim the life */
    float gLum = dot(col, vec3(0.299,0.587,0.114));
    col = mix(col, vec3(gLum)*vec3(0.97,0.965,0.955), u_desat*0.85);
    col *= 1.0 - u_desat*0.16;

    alpha = smoothstep(1.0 + aa, 1.0 - aa, q);

    /* dense darker edge so the silhouette reads as thick glass */
    col = mix(col, col*vec3(0.55,0.50,0.46), smoothstep(0.94, 1.0, qc)*0.85);
  }

  if (q >= 1.0 - aa) {
    /* ================= outside: atmosphere ================= */
    float d = max(q - 1.0, 0.0);
    vec2 u2 = rel / r;

    /* fade everything near the canvas border so nothing clips hard */
    vec2 pc = p / u_canvasSize;
    float edgeFade = smoothstep(0.0, 0.10, pc.x) * smoothstep(1.0, 0.90, pc.x)
                   * smoothstep(0.0, 0.10, pc.y) * smoothstep(1.0, 0.90, pc.y);

    /* muted/offline kill the cast light: a sealed or dead orb
       must not paint the page */
    float lightDim = 1.0 - max(u_desat*0.85, u_seal*0.55);

    /* focused rainbow caustics landing on the page (computed first:
       their fog pools feed the haze field below) */
    float ccFog;
    vec4 cc = causticsF(u2, t, u_env, ccFog);

    /* atmospheric haze, shaped by the light: a tight pocket hugging
       the rim plus a slim horizontal corridor that carries the flare
       wings. Gone within ~1 radius vertically; never a page dim. */
    float ax2 = abs(u2.x);
    float rimPocket = 0.26 * exp(-d*d*2.2)
                    * (1.0 + 0.25*clamp(-u2.y*0.7, 0.0, 1.0)); /* denser sky above */
    float corridor  = 0.16 * exp(-pow(u2.y*1.6, 2.0)) * exp(-ax2*ax2*0.10);
    float hazeF = (rimPocket + corridor) * u_haze;
    hazeF *= 0.85 + 0.15*fbm(vec2(ang*1.3, t*0.12));
    hazeF *= edgeFade;

    float so = r*0.05;
    vec3 hb = ( bg(screenPx + vec2( so, 0.0)) + bg(screenPx + vec2(-so, 0.0))
              + bg(screenPx + vec2(0.0,  so)) + bg(screenPx + vec2(0.0, -so)) ) * 0.25;
    float lumaH = dot(hb, vec3(0.299,0.587,0.114));
    vec3 hazePage = mix(hb, vec3(lumaH), 0.30) * vec3(0.74,0.71,0.675)
                  + vec3(0.040,0.036,0.030);

    vec3 smokeCol = vec3(0.36,0.31,0.27);   /* contact-shadow tint */

    /* warm halo hugging the rim, lifted a touch to pierce the fog */
    float halo = (exp(-d*11.0) * (0.5 + 0.5*u_env) * 0.75
               + exp(-d*8.0) * u_flash * 0.5) * lightDim;
    /* outer ring continuation of the lens flare */
    float oRing = exp(-d*d*900.0) * (0.35 + 0.65*u_ring);

    /* the flare continuing past the glass onto the page */
    vec4 flOut = flareF(u2, t, u_env, u_streak) * lightDim;
    /* broad caustic ribbons cast across the page */
    vec4 bd = bandsF(u2, t, u_env, 0.14) * lightDim;
    /* mirrored ghost of the orb on the surface below */
    vec4 rf = reflectF(u2, t, u_env, u_streak) * lightDim;

    /* contact shadow under the bubble */
    float shadow = exp(-d*9.0) * smoothstep(0.0, 0.9, rel.y/r) * 0.22;

    /* ----- motion wake: soft ribbons of refracted light shed off
       the trailing edge while the bubble moves. Broad, smooth,
       slow-curving; they displace the page like heat haze with a
       whisper of soap-film color. Gone when still. ----- */
    float wispGlint = 0.0;
    float hazeA = 0.0;
    vec3 hazeCol = vec3(0.0);
    float along = dot(rel, -vdir)/r - 1.0;   /* 0 at trailing rim */
    if (moveGate > 0.003 && along > 0.0) {
      vec2 perp = vec2(-vdir.y, vdir.x);
      float side = dot(rel, perp)/r;
      float spread = 0.34 + 0.50*along;
      float wob1 = (fbm(vec2(along*0.8 - t*1.2, 3.7)) - 0.5)*0.5*along;
      float wob2 = (fbm(vec2(along*1.1 + t*0.9, 9.1)) - 0.5)*0.6*along;
      float fil1 = exp(-pow((side - wob1)/spread, 2.0)*1.6);
      float fil2 = exp(-pow((side - wob2)/(spread*0.8), 2.0)*1.6);
      float fade = exp(-along*1.0) * moveGate;
      float field = (fil1 + fil2*0.7) * fade;

      if (field > 0.01) {
        /* heat-haze: gently bend the page inside the wake */
        float bendN = (fbm(vec2(along*1.6 - t*1.6, side*2.0)) - 0.5);
        vec2 hOff = perp * bendN * r * 0.10 * field
                  - vdir * r * 0.04 * field;
        hazeCol.r = bg(screenPx + hOff).r;
        hazeCol.g = bg(screenPx + hOff + perp * r * 0.010 * field).g;
        hazeCol.b = bg(screenPx + hOff + perp * r * 0.020 * field).b;

        /* soft light folds, visible over featureless background */
        hazeCol *= 1.0 + 0.16 * bendN * field + 0.08 * field;

        /* thin-film iridescence: faint soap-bubble color */
        float ph = along*0.9 + side*1.4 + t*0.5;
        vec3 irid = 0.5 + 0.5*cos(6.2831*ph + vec3(0.0, 2.094, 4.188));
        hazeCol = mix(hazeCol, hazeCol*0.92 + irid*0.16, field*0.6);

        hazeA = clamp(field*0.9, 0.0, 0.7);
        /* a gentle sheen on the ribbon cores, no sparks */
        wispGlint = fil2*fil2 * fade * 0.30;
      }
    }

    /* the bright cast light (halo, lens-flare wings, bloom) — scaled by
       u_atmos so it doesn't blow out the chat on a narrow screen */
    vec3 add = (warmHi*(halo + oRing)
             + (flOut.rgb + bd.rgb + rf.rgb) * edgeFade
             + vec3(1.0,0.93,0.80)*wispGlint) * u_atmos;
    float dark = shadow;

    /* caustics carry the page with them: their pixels become
       page + light, so they can only brighten what they touch.
       Strong light also burns away the fog beneath it. */
    float ccM = min(cc.a, 0.95) * edgeFade * lightDim;
    vec3 ccPage = bg(screenPx) + cc.rgb * lightDim;
    hazeF *= 1.0 - 0.8*ccM;

    /* composite: haze first (it replaces the page), light on top. The bright
       cast-light terms are scaled by u_atmos to match add, so on small
       screens the glow becomes more transparent and the chat reads through. */
    float lightA = (halo + oRing + wispGlint + (flOut.a + bd.a + rf.a) * edgeFade) * u_atmos;
    float aOut = clamp(hazeA + hazeF + lightA + dark + ccM, 0.0, 1.0);
    vec3 cOut = (hazeCol*hazeA + hazePage*hazeF + ccPage*ccM + add + smokeCol*dark)
              / max(aOut, 0.0001);
    cOut = max(cOut, 0.0);

    float outsideMix = smoothstep(1.0 - aa, 1.0 + aa, q);
    col = mix(col, cOut, outsideMix);
    alpha = mix(alpha, aOut, outsideMix);
  }

  /* open the belly of the orb into glass, not a hole. q is 0 at
     center, 1 at rim. We drop most of the interior alpha so content
     shows through, but leave a thin glass film: a faint warm tint, a
     soft domed lift toward the clear-zone edge, and a floating
     catchlight near the top-left, the cues that say "a surface is
     here" rather than "there is a gap here". The rim stays solid. */
  if (u_centerClear > 0.0 && q < 1.0) {
    float fadeEnd = clamp(u_clearFade, 0.1, 0.98);
    float clearZone = 1.0 - smoothstep(0.0, fadeEnd, q);   /* 1 center -> 0 by fadeEnd */
    float clearAmt = u_centerClear * clearZone;                /* how cleared this pixel is */

    vec2 unitC = (r > 0.0) ? rel / r : vec2(0.0);

    /* 1) faint warm tint: the glass has a slight body color */
    vec3 glassTint = mix(vec3(1.0,0.985,0.96), vec3(1.0,0.93,0.80), u_warmth);

    /* 2) domed sheen: a gentle brightness lift that grows toward the
       edge of the clear zone, so the film reads as a curved surface
       rather than a flat wash */
    float dome = smoothstep(0.0, fadeEnd, q) * (1.0 - smoothstep(fadeEnd*0.85, fadeEnd, q));
    float sheen = pow(dome, 1.5) * 0.16;

    /* 3) catchlight: the same top-left reflection the solid orb wears,
       floating on the glass so the surface visibly catches the light */
    vec2 sg = vec2(-0.34, -0.44);
    float cl = exp(-dot(unitC - sg, unitC - sg) * 9.0) * 0.40;
    /* a smaller, tighter sparkle lower-right for a second glint */
    vec2 sg2 = vec2(0.30, 0.36);
    float cl2 = exp(-dot(unitC - sg2, unitC - sg2) * 30.0) * 0.22;

    /* the film's own color and the opacity it keeps where cleared */
    vec3 film = glassTint + vec3(sheen) + vec3(cl + cl2);
    float filmA = clearAmt * (0.10 + sheen*0.9 + cl*0.85 + cl2*0.9);  /* mostly see-through */

    /* blend: drop the solid orb color out by clearAmt, lay the film in */
    col = mix(col, film, clearAmt);
    alpha = mix(alpha, filmA, clearAmt);
  }

  /* a task glyph living inside the glass: sampled from the atlas with
     rotated coords so it spins, scaled to sit in the bead's middle,
     lit warm and given a soft bloom so it reads as suspended in the
     refracting medium rather than pasted on. */
  if (u_taskIcon >= 0.0 && u_taskAmt > 0.0 && q < 1.0) {
    vec2 gp = (r > 0.0) ? rel / r : vec2(0.0);   /* -1..1 within bubble */
    float glyphScale = 1.7;                      /* glyph fills ~60% of bead */
    vec2 sp = gp * glyphScale;
    float ca = cos(u_taskSpin), sa2 = sin(u_taskSpin);
    sp = mat2(ca, -sa2, sa2, ca) * sp;           /* spin */
    /* slight lens magnification toward center so it feels embedded */
    float gm = 1.0 - 0.12 * (1.0 - dot(gp, gp));
    sp *= gm;
    vec2 cell = sp * 0.5 + 0.5;                  /* 0..1 within one cell */
    if (cell.x > 0.0 && cell.x < 1.0 && cell.y > 0.0 && cell.y < 1.0) {
      float col_ = mod(u_taskIcon, u_atlasCols);
      float row_ = floor(u_taskIcon / u_atlasCols);
      vec2 uvI = (vec2(col_, row_) + cell) / vec2(u_atlasCols, u_atlasRows);
      float glyph = texture2D(u_icons, uvI).a;
      vec3 warmGlyph = mix(vec3(0.99,0.985,0.97), vec3(1.0,0.94,0.82), u_warmth);
      /* soft inner edge so the white line picks up the glass warmth */
      vec3 glyphCol = mix(vec3(1.0), warmGlyph, 0.35);
      float gA = glyph * u_taskAmt * (0.55 + 0.45 * (1.0 - dot(gp, gp)));
      col = mix(col, glyphCol, gA);
      alpha = max(alpha, gA * 0.9);
      /* a faint bloom around the glyph so it glows within the bead */
      col += warmGlyph * glyph * u_taskAmt * 0.18;
    }
  }

  /* Per-agent hue: rotate the whole orb (body, glow, refraction) around the
     luma axis toward the active agent's color. u_hueShift = 0 keeps the
     signature champagne. Rotation preserves brightness, so the carefully-tuned
     shading/refraction structure survives — only the chroma turns. */
  if (abs(u_hueShift) > 0.001) {
    const vec3 kAxis = vec3(0.57735026919);
    float ch = cos(u_hueShift), sh = sin(u_hueShift);
    col = col * ch + cross(kAxis, col) * sh + kAxis * dot(kAxis, col) * (1.0 - ch);
    col = max(col, vec3(0.0));
  }

  /* Alert tint: a held warning(amber)->error(red) wash over the whole orb,
     applied AFTER the hue so it overrides the agent colour. Preserves the
     orb's luminance/structure (mix toward the alert hue, keep brightness). */
  if (u_alert > 0.001) {
    vec3 alertCol = mix(vec3(1.0, 0.62, 0.16), vec3(1.0, 0.24, 0.18), smoothstep(0.45, 1.0, u_alert));
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    vec3 tinted = alertCol * (0.55 + 0.85 * luma);
    col = mix(col, tinted, clamp(u_alert, 0.0, 1.0) * 0.9);
  }

  /* premultiplied output: rgb carries alpha so the browser composites the
     transparent canvas over the page correctly on every engine (incl. iOS). */
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

  /* ---------------- WebGL setup ---------------- */
  const gl = canvas.getContext('webgl', {
    alpha: true,
    // Premultiplied output (the fragment shader multiplies col by alpha at the
    // end). iOS/WebKit effectively ignores `premultipliedAlpha:false` and
    // composites the canvas as premultiplied anyway, which turned every
    // low-alpha-but-bright pixel (the orb's glow/atmosphere) into a blown-out
    // white wash over the page. Premultiplied is well-supported everywhere and
    // is mathematically identical to the old straight-alpha path on desktop.
    premultipliedAlpha: true,
  }) as WebGLRenderingContext | null;
  if (!gl) throw new Error('WebGL unavailable');
  const glc: WebGLRenderingContext = gl;

  function compile(type: number, src: string): WebGLShader {
    const sh = glc.createShader(type)!;
    glc.shaderSource(sh, src);
    glc.compileShader(sh);
    if (!glc.getShaderParameter(sh, glc.COMPILE_STATUS))
      throw new Error(glc.getShaderInfoLog(sh) || 'shader compile failed');
    return sh;
  }

  let U: Record<string, WebGLUniformLocation | null> = {};
  let prog: WebGLProgram | null = null;
  let buf: WebGLBuffer | null = null;
  let tex: WebGLTexture | null = null;
  let iconTex: WebGLTexture | null = null;

  /* ---------------- task glyph atlas ----------------
     Seven line-art glyphs in a grid, white on transparent, drawn
     crisply at a generous cell size. The shader reads one cell as the
     "inside the glass" spinner. Order fixes each task's atlas index. */
  const TASK_ORDER = ['image', 'audio', 'song', 'video', 'compaction', 'dreamer', 'healer'];
  /* The atlas also holds notification glyphs (exclamation / check) shown inside
     the glass for warnings/errors and info — same mechanism as the task icons,
     but driven statically (no spin) by setNoteGlyph(). */
  const GLYPH_ORDER = [...TASK_ORDER, 'alert', 'check'];
  const ATLAS_COLS = 4; /* 4-wide grid */
  const ATLAS_CELL = 128;
  const ATLAS_ROWS = Math.ceil(GLYPH_ORDER.length / ATLAS_COLS);
  function buildIconAtlas(): HTMLCanvasElement {
    const cols = ATLAS_COLS,
      rows = ATLAS_ROWS;
    const c = document.createElement('canvas');
    c.width = cols * ATLAS_CELL;
    c.height = rows * ATLAS_CELL;
    const x = c.getContext('2d')!;
    x.strokeStyle = '#ffffff';
    x.fillStyle = '#ffffff';
    x.lineWidth = 7;
    x.lineJoin = 'round';
    x.lineCap = 'round';

    GLYPH_ORDER.forEach((name, i) => {
      const cx = (i % cols) * ATLAS_CELL,
        cy = ((i / cols) | 0) * ATLAS_CELL;
      x.save();
      x.translate(cx + ATLAS_CELL / 2, cy + ATLAS_CELL / 2); /* glyph centered at 0,0 */
      const S = 38; /* glyph half-extent */
      x.beginPath();
      if (name === 'image') {
        /* framed photo: frame + mountain + sun */
        x.strokeRect(-S, -S * 0.78, S * 2, S * 1.56);
        x.beginPath();
        x.moveTo(-S + 6, S * 0.6);
        x.lineTo(-S * 0.1, -S * 0.1);
        x.lineTo(S * 0.3, S * 0.2);
        x.lineTo(S * 0.62, -S * 0.2);
        x.lineTo(S - 6, S * 0.6);
        x.stroke();
        x.beginPath();
        x.arc(-S * 0.42, -S * 0.4, 7, 0, Math.PI * 2);
        x.stroke();
      } else if (name === 'audio') {
        /* waveform: bars of varying height */
        const hs = [0.3, 0.7, 1.0, 0.55, 0.85, 0.4];
        const n = hs.length,
          gap = (S * 2) / (n - 1);
        for (let k = 0; k < n; k++) {
          const px = -S + k * gap,
            h = hs[k] * S;
          x.beginPath();
          x.moveTo(px, -h);
          x.lineTo(px, h);
          x.stroke();
        }
      } else if (name === 'song') {
        /* single eighth note: one stem, one head, one flag */
        const stemX = S * 0.5,
          headY = S * 0.62,
          topY = -S * 0.95;
        x.beginPath();
        x.moveTo(stemX, headY);
        x.lineTo(stemX, topY);
        x.stroke();
        /* flag off the top of the stem */
        x.beginPath();
        x.moveTo(stemX, topY);
        x.quadraticCurveTo(S * 1.15, topY + S * 0.35, stemX + S * 0.18, topY + S * 0.85);
        x.stroke();
        /* note head */
        x.beginPath();
        x.ellipse(stemX - S * 0.34, headY, S * 0.42, S * 0.3, -0.35, 0, Math.PI * 2);
        x.stroke();
      } else if (name === 'video') {
        /* clapperboard, sized to fit the cell (stay within ~1.35*S).
           A board body, a hinged clapper bar across the top with
           diagonal stripes, and a small play triangle. */
        const halfW = S * 1.25; /* board half-width */
        const clapTop = -S * 0.95; /* top of the clapper bar */
        const clapH = S * 0.5; /* clapper bar height */
        const boardTop = clapTop + clapH; /* board starts below the bar */
        const boardBot = S * 1.15;
        /* board body */
        x.strokeRect(-halfW, boardTop, halfW * 2, boardBot - boardTop);
        /* clapper bar across the top (slight upward tilt on the left) */
        x.beginPath();
        x.moveTo(-halfW, boardTop);
        x.lineTo(-halfW + S * 0.12, clapTop);
        x.lineTo(halfW, clapTop - S * 0.16);
        x.lineTo(halfW, boardTop);
        x.closePath();
        x.stroke();
        /* diagonal stripes inside the clapper bar */
        for (let k = 1; k <= 4; k++) {
          const f = k / 5;
          const xb = -halfW + halfW * 2 * f; /* along the bottom edge */
          const xt = -halfW + S * 0.12 + (halfW * 2 - S * 0.12) * f; /* along top edge */
          x.beginPath();
          x.moveTo(xb, boardTop);
          x.lineTo(xt, clapTop - S * 0.16 * f);
          x.stroke();
        }
        /* play triangle centered on the board */
        const py = (boardTop + boardBot) / 2 + S * 0.05,
          ps = S * 0.36;
        x.beginPath();
        x.moveTo(-ps * 0.6, py - ps);
        x.lineTo(ps * 0.8, py);
        x.lineTo(-ps * 0.6, py + ps);
        x.closePath();
        x.stroke();
      } else if (name === 'compaction') {
        /* two arrows squeezing toward a center bar: the clearest read
           of "compaction". Down-arrow above, bar, up-arrow below. */
        const barY = 0,
          barW = S * 1.0,
          head = S * 0.4;
        /* center bar */
        x.beginPath();
        x.moveTo(-barW, barY);
        x.lineTo(barW, barY);
        x.stroke();
        /* top arrow: shaft down + arrowhead pointing at the bar */
        const topTip = -S * 0.28,
          topTail = -S * 1.15;
        x.beginPath();
        x.moveTo(0, topTail);
        x.lineTo(0, topTip);
        x.stroke();
        x.beginPath();
        x.moveTo(-head, topTip - head);
        x.lineTo(0, topTip);
        x.lineTo(head, topTip - head);
        x.stroke();
        /* bottom arrow: shaft up + arrowhead pointing at the bar */
        const botTip = S * 0.28,
          botTail = S * 1.15;
        x.beginPath();
        x.moveTo(0, botTail);
        x.lineTo(0, botTip);
        x.stroke();
        x.beginPath();
        x.moveTo(-head, botTip + head);
        x.lineTo(0, botTip);
        x.lineTo(head, botTip + head);
        x.stroke();
      } else if (name === 'dreamer') {
        /* crescent moon */
        x.beginPath();
        x.arc(0, 0, S, Math.PI * 0.3, Math.PI * 1.55, false);
        x.arc(S * 0.42, -S * 0.18, S * 0.92, Math.PI * 1.35, Math.PI * 0.42, true);
        x.closePath();
        x.stroke();
      } else if (name === 'healer') {
        /* pulse / heartbeat line */
        x.beginPath();
        x.moveTo(-S, 0);
        x.lineTo(-S * 0.4, 0);
        x.lineTo(-S * 0.18, -S * 0.8);
        x.lineTo(S * 0.05, S * 0.85);
        x.lineTo(S * 0.3, -S * 0.25);
        x.lineTo(S * 0.5, 0);
        x.lineTo(S, 0);
        x.stroke();
      } else if (name === 'alert') {
        /* exclamation: a tapered bar + a dot below */
        x.beginPath();
        x.moveTo(0, -S * 0.92);
        x.lineTo(0, S * 0.22);
        x.stroke();
        x.beginPath();
        x.arc(0, S * 0.74, 6.5, 0, Math.PI * 2);
        x.fill();
      } else if (name === 'check') {
        /* checkmark */
        x.beginPath();
        x.moveTo(-S * 0.78, S * 0.02);
        x.lineTo(-S * 0.16, S * 0.62);
        x.lineTo(S * 0.82, -S * 0.6);
        x.stroke();
      }
      x.restore();
    });
    return c;
  }

  let uploadHandler: (() => void) | null = null;

  function init(): void {
    prog = glc.createProgram()!;
    glc.attachShader(prog, compile(glc.VERTEX_SHADER, VERT));
    glc.attachShader(prog, compile(glc.FRAGMENT_SHADER, FRAG));
    glc.linkProgram(prog);
    if (!glc.getProgramParameter(prog, glc.LINK_STATUS))
      throw new Error(glc.getProgramInfoLog(prog) || 'program link failed');
    glc.useProgram(prog);

    buf = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, buf);
    glc.bufferData(glc.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), glc.STATIC_DRAW);
    const loc = glc.getAttribLocation(prog, 'a_pos');
    glc.enableVertexAttribArray(loc);
    glc.vertexAttribPointer(loc, 2, glc.FLOAT, false, 0, 0);

    U = {};
    [
      'u_tex',
      'u_imgRes',
      'u_viewport',
      'u_canvasPos',
      'u_canvasSize',
      'u_dpr',
      'u_time',
      'u_center',
      'u_radius',
      'u_mouse',
      'u_mouseIn',
      'u_vel',
      'u_wobble',
      'u_wobSpeed',
      'u_swirl',
      'u_squish',
      'u_warmth',
      'u_hueShift',
      'u_alert',
      'u_ring',
      'u_streak',
      'u_env',
      'u_atmos',
      'u_refr',
      'u_disp',
      'u_lens',
      'u_ripple',
      'u_haze',
      'u_vsquash',
      'u_flash',
      'u_anger',
      'u_breath',
      'u_heartbeat',
      'u_shapeDroop',
      'u_shapeAlert',
      'u_shapeSpike',
      'u_lean',
      'u_desat',
      'u_seal',
      'u_centerClear',
      'u_clearFade',
      'u_icons',
      'u_atlasCols',
      'u_atlasRows',
      'u_taskIcon',
      'u_taskAmt',
      'u_taskSpin',
    ].forEach((n) => (U[n] = glc.getUniformLocation(prog!, n)));

    /* No GL blending: we draw a single full-screen triangle whose shader
       already composites the orb over the refracted page, then emits
       premultiplied color (col*alpha, alpha). The browser does the final
       page compositing from that premultiplied buffer — correct on every
       engine including iOS/WebKit (which mishandles premultipliedAlpha:false). */
    glc.disable(glc.BLEND);

    tex = glc.createTexture();
    glc.activeTexture(glc.TEXTURE0);
    glc.bindTexture(glc.TEXTURE_2D, tex);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_WRAP_S, glc.CLAMP_TO_EDGE);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_WRAP_T, glc.CLAMP_TO_EDGE);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_MIN_FILTER, glc.LINEAR);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_MAG_FILTER, glc.LINEAR);

    const upload = () => {
      glc.activeTexture(glc.TEXTURE0);
      glc.bindTexture(glc.TEXTURE_2D, tex);
      glc.texImage2D(glc.TEXTURE_2D, 0, glc.RGBA, glc.RGBA, glc.UNSIGNED_BYTE, img);
      glc.uniform1i(U.u_tex, 0);
      glc.uniform2f(U.u_imgRes, img.naturalWidth, img.naturalHeight);
    };
    uploadHandler = upload;
    if (img.complete && img.naturalWidth) upload();
    else img.addEventListener('load', upload);

    /* second texture: an atlas of task glyphs, drawn into the glass as
       a spinning icon while a job runs. White line-art on transparent,
       so the shader can tint and refract it like everything else. */
    iconTex = glc.createTexture();
    glc.activeTexture(glc.TEXTURE1);
    glc.bindTexture(glc.TEXTURE_2D, iconTex);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_WRAP_S, glc.CLAMP_TO_EDGE);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_WRAP_T, glc.CLAMP_TO_EDGE);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_MIN_FILTER, glc.LINEAR);
    glc.texParameteri(glc.TEXTURE_2D, glc.TEXTURE_MAG_FILTER, glc.LINEAR);
    glc.texImage2D(glc.TEXTURE_2D, 0, glc.RGBA, glc.RGBA, glc.UNSIGNED_BYTE, buildIconAtlas());
    glc.uniform1i(U.u_icons, 1);
    glc.uniform1f(U.u_atlasCols, ATLAS_COLS);
    glc.uniform1f(U.u_atlasRows, ATLAS_ROWS);

    layout();
  }

  /* ---------------- stage CSS var helpers ----------------
     The dashboard sets --dojo3-orb-size / --dojo3-orb-top on the
     .dojo3-stage. We read those (falling back to the prototype's
     --orb-* names, then to computed canvas size). --canvas-scale
     falls back to the prototype's hardcoded 3.8. */
  function readStageVar(names: string[]): number {
    const cs = getComputedStyle(stageEl);
    for (const name of names) {
      const v = parseFloat(cs.getPropertyValue(name));
      if (!Number.isNaN(v)) return v;
    }
    return NaN;
  }

  /* ---------------- layout ---------------- */
  let cssSize = 0,
    canvasPos = { x: 0, y: 0 },
    center = { x: 0, y: 0 },
    radius = 0;
  /* outside-glow scale: dimmed on narrow screens so the orb's halo/flare does
     not blow out the chat. Ramps 0.46 (phone) -> 1.0 (>= ~760px). */
  let atmosScale = 1;
  /* external voice envelope: while a voice session is live, the orb pulses with
     the REAL mic level instead of the simulated envelope. <0 = use simulation. */
  let extEnv = -1;
  let envExtSmooth = 0;

  function layout(): void {
    let dia = readStageVar(['--dojo3-orb-size', '--orb-diameter']);
    if (Number.isNaN(dia)) dia = Math.min(Math.max(innerWidth * 0.1, 96), 140);
    let top = readStageVar(['--dojo3-orb-top', '--orb-top']);
    if (Number.isNaN(top)) top = Math.min(Math.max(innerHeight * 0.04, 26), 48);
    let scale = readStageVar(['--canvas-scale']);
    if (Number.isNaN(scale)) scale = 3.8;

    radius = dia / 2;
    cssSize = Math.round(Math.min(dia * scale, innerWidth * 0.88));
    /* narrow viewport -> dim the cast light so it doesn't wash out content */
    atmosScale = 0.5 + 0.5 * Math.max(0, Math.min(1, (innerWidth - 420) / 360));
    const dpr = Math.min(devicePixelRatio || 1, 2);

    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';
    canvas.style.marginLeft = -cssSize / 2 + 'px';
    /* bubble center sits at top + radius; canvas centers on it */
    const centerY = top + radius;
    canvas.style.top = centerY - cssSize / 2 + 'px';

    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    glc.viewport(0, 0, canvas.width, canvas.height);

    center.x = cssSize / 2;
    center.y = cssSize / 2;
    // canvasPos is the canvas top-left in VIEWPORT css px. The canvas is
    // centered in the stage's main column (which narrows when the right dock
    // opens), so it is NOT centered on the window — read its real rect rather
    // than assuming innerWidth/2. syncCanvasPos() keeps it correct every frame
    // (dock open/close transition, drag-resize, window resize).
    syncCanvasPos();
  }

  /* Track the canvas's live viewport offset so pointer math + screen-space
     refraction follow the orb when the main column resizes (e.g. the dock
     slides open). Cheap: one getBoundingClientRect on a single element. */
  function syncCanvasPos(): void {
    const r = canvas.getBoundingClientRect();
    canvasPos.x = r.left;
    canvasPos.y = r.top;
  }

  /* ---------------- state machine ---------------- */
  /* atmosphere strength: 0 = no fog, 1 = reference look, 1.3 = moody */
  const ORB_HAZE = 1.0;

  type ParamTable = Record<string, number>;

  /* params: wobble, wobSpeed, swirl, squish, warmth, ring, streak, refr, disp, lens, drift */
  const STATES: Record<string, ParamTable> = {
    idle: { wobble: 0.030, wobSpeed: 0.55, swirl: 0.25, squish: 0.032, warmth: 0.55, ring: 0.35, streak: 0.50, refr: 0.34, disp: 0.11, lens: 0.85, drift: 2.5, breath: 1, anger: 0, tempo: 1, envFloor: 0, desat: 0, seal: 0, scale: 1, envScale: 1 },
    listening: { wobble: 0.038, wobSpeed: 0.80, swirl: 0.35, squish: 0.040, warmth: 0.25, ring: 0.80, streak: 0.35, refr: 0.36, disp: 0.13, lens: 0.90, drift: 4.0, breath: 1, anger: 0, tempo: 1, envFloor: 0, desat: 0, seal: 0, scale: 1, envScale: 1 },
    thinking: { wobble: 0.072, wobSpeed: 1.55, swirl: 0.95, squish: 0.075, warmth: 0.45, ring: 0.55, streak: 0.45, refr: 0.42, disp: 0.26, lens: 0.95, drift: 14.0, breath: 1, anger: 0, tempo: 1, envFloor: 0, desat: 0, seal: 0, scale: 1, envScale: 1 },
    speaking: { wobble: 0.042, wobSpeed: 0.95, swirl: 0.45, squish: 0.036, warmth: 0.85, ring: 0.70, streak: 1.0, refr: 0.38, disp: 0.16, lens: 0.90, drift: 6.0, breath: 1, anger: 0, tempo: 1, envFloor: 0, desat: 0, seal: 0, scale: 1, envScale: 1 },
  };

  /* ============================================================
     EMOTION LAYER
     The engine owns the base state (what the orb is doing); the
     LLM paints emotion on top (how it feels about it). Each
     emotion = sustained parameter targets, blended over the base,
     plus a choreographed motion track built on the classic
     animation principles: anticipation, squash & stretch with
     volume conservation, follow-through ringing, slow in/out,
     arcs, and secondary action from the light.
     ============================================================ */
  const sm01 = (p: number) => {
    p = Math.max(0, Math.min(1, p));
    return p * p * (3 - 2 * p);
  };
  const arc01 = (p: number) => 4 * p * (1 - p); /* parabolic hop */
  const easeOutBack = (p: number) => {
    const c = 1.70158,
      q = p - 1;
    return 1 + (c + 1) * q * q * q + c * q * q;
  };

  type MotionOut = {
    dy?: number;
    vs?: number;
    flash?: number;
    shake?: number;
    droop?: number;
    alert?: number;
    spike?: number;
    leanX?: number;
    leanY?: number;
  };
  type EmotionDef = {
    hold: number | null;
    attack: number;
    params: ParamTable;
    motion: (tE: number) => MotionOut;
  };

  const EMOTIONS: Record<string, EmotionDef> = {
    /* a jolt: anticipation squash, leap with stretch, then a
       ringing wobble as it settles. Auto-clears. */
    startled: {
      hold: 1.8,
      attack: 22,
      params: { wobble: 0.060, wobSpeed: 2.4, disp: 0.22, ring: 1.0, tempo: 1.5, envFloor: 0.7 },
      motion(tE) {
        /* a jump-in-place: the orb lives at the top of the page, so
           the startle is a crouch DOWN, then a pop with the energy
           going into the stretch and the "!" crown spike, not height */
        let dy = 0,
          vs = 0,
          flash = 0,
          alert = 0,
          droop = 0;
        if (tE < 0.09) {
          /* crouch */
          const p = tE / 0.09;
          vs = -0.24 * p;
          droop = 0.40 * p;
          dy = 6 * p;
        } else if (tE < 0.34) {
          const p = (tE - 0.09) / 0.25;
          dy = 6 - 9 * Math.sin(p * Math.PI); /* small pop */
          vs = 0.20 * (1 - p * 0.7); /* stretch */
          alert = Math.min(0.75, p * 2.4); /* "!" spike */
          flash = 1.1 * (1 - p * 0.6);
        } else {
          const u = tE - 0.34; /* ringing */
          vs = 0.10 * Math.exp(-u * 4.5) * Math.sin(u * 26.0);
          dy = -2 * Math.exp(-u * 3.5) * Math.sin(u * 18.0);
          alert = 0.75 * Math.exp(-u * 1.3) * (1.0 + 0.25 * Math.sin(u * 14.0));
          flash = 0.5 * Math.exp(-u * 4.0);
        }
        return { dy, vs, flash, shake: 0, alert, droop };
      },
    },

    /* three diminishing hops on proper arcs, squash at each
       landing, stretch midair, settling into a happy bob */
    joyous: {
      hold: 3.0,
      attack: 6,
      params: { warmth: 0.85, ring: 0.70, streak: 0.60, wobble: 0.042, wobSpeed: 1.2, swirl: 0.60, tempo: 1.25, envFloor: 0.45, breath: 1.2 },
      motion(tE) {
        const hops = [
          [0.0, 0.52, 20],
          [0.52, 0.95, 12],
          [0.95, 1.28, 6],
        ];
        let dy = 0,
          vs = 0,
          flash = tE < 0.4 ? 0.5 * Math.exp(-tE * 3) : 0;
        let hopping = false;
        for (const [s0, e0, h] of hops) {
          if (tE >= s0 && tE < e0) {
            const p = (tE - s0) / (e0 - s0);
            dy = -h * arc01(p);
            /* stretch midair, squash at the contacts */
            vs = 0.15 * Math.sin(p * Math.PI) - 0.11 * Math.pow(Math.abs(Math.cos(p * Math.PI)), 6.0);
            hopping = true;
            break;
          }
        }
        if (!hopping && tE >= 1.28) {
          const ts = tE - 1.28; /* happy bob */
          dy = -3.0 * Math.abs(Math.sin(ts * 2.4));
          vs = 0.05 * Math.sin(ts * 4.8);
        }
        /* buoyant: mass rides high, even higher midair (vs > 0) */
        const droop = -0.45 - 1.4 * Math.max(vs, 0);
        return { dy, vs, flash, shake: 0, droop };
      },
    },

    /* effort: tight fast wobble, inward focus, rhythmic squeeze
       pulses like strain, a fine tremor */
    working: {
      hold: null,
      attack: 5,
      params: { swirl: 1.35, wobble: 0.050, wobSpeed: 2.3, refr: 0.45, disp: 0.20, ring: 0.40, warmth: 0.50, tempo: 1.15, envFloor: 0.50 },
      motion(tE) {
        const pulse = Math.pow(Math.max(0, Math.sin(tE * 3.2)), 3.0);
        /* hunched: center of mass low, squeezing harder with effort */
        return { dy: pulse * 1.5, vs: -0.09 * pulse, flash: 0.12 * pulse, shake: 0.55, droop: 0.38 + 0.28 * pulse, leanY: 0.30 };
      },
    },

    /* coil, flare up, then simmer: hot palette, trembling with
       rage, periodic temper flashes */
    mad: {
      hold: 2.8,
      attack: 10,
      params: { anger: 1, warmth: 1, ring: 0.90, streak: 0.80, wobble: 0.060, wobSpeed: 2.6, disp: 0.24, tempo: 1.3, envFloor: 0.60 },
      motion(tE) {
        let vs = 0,
          flash = 0,
          spike = 0;
        if (tE < 0.14) {
          vs = -0.16 * (tE / 0.14);
        } /* coil */ else if (tE < 0.40) {
          const p = (tE - 0.14) / 0.26;
          vs = -0.16 + 0.26 * p;
          flash = 0.9 * Math.sin(p * Math.PI); /* flare up */
          spike = p; /* bristles erupt */
        } else {
          vs = -0.05; /* simmer */
          flash = 0.45 * Math.pow(Math.max(0, Math.sin(tE * 1.25 + 1.0)), 8.0);
          spike = 0.65 + 0.5 * flash; /* flare = bristle */
        }
        return { dy: 0, vs, flash, shake: tE > 0.3 ? 1.1 : 0.3, spike, droop: -0.15 };
      },
    },

    /* everything slows and softens: deep slow breath, near-perfect
       sphere, cool pearl, unhurried light */
    calm: {
      hold: 3.2,
      attack: 2.5,
      params: { wobble: 0.014, squish: 0.015, warmth: 0.35, ring: 0.30, streak: 0.35, swirl: 0.15, tempo: 0.45, envFloor: 0.25, breath: 2.0, disp: 0.08 },
      motion() {
        return { dy: 0, vs: 0, flash: 0, shake: 0, droop: -0.12 };
      },
    },

    /* sags into itself, dims, breathes long and deep, and every
       few seconds slowly nods off then catches itself */
    sleepy: {
      hold: null,
      attack: 2.5,
      params: { wobble: 0.012, warmth: 0.45, ring: 0.20, streak: 0.20, swirl: 0.10, tempo: 0.35, envFloor: 0.12, breath: 2.8, refr: 0.32 },
      motion(tE) {
        const settle = sm01(tE / 1.5);
        const sag = 6 * settle;
        let vs = -0.11 * settle;
        const cyc = tE % 7.5;
        let nod = 0;
        if (cyc < 2.4) nod = 9 * sm01(cyc / 2.4);
        /* drooop... */ else if (cyc < 2.85) nod = 9 * (1 - easeOutBack((cyc - 2.4) / 0.45)); /* !catch */
        /* mass pools at the bottom; the droop deepens as it nods off */
        const droop = 0.80 * settle + nod * 0.035;
        return { dy: sag + nod, vs: vs - nod * 0.004, flash: 0, shake: 0, droop };
      },
    },

    /* the head-tilt: sways side to side, and every couple of
       seconds a small question-mark bump rises from the crown */
    confused: {
      hold: 2.6,
      attack: 5,
      params: { wobble: 0.040, wobSpeed: 0.90, swirl: 0.40, warmth: 0.45, ring: 0.50, tempo: 0.85, envFloor: 0.35, disp: 0.15 },
      motion(tE) {
        const leanX = 0.30 * Math.sin(tE * 0.7);
        const alert = 0.35 * Math.pow(Math.max(0, Math.sin(tE * 0.9 - 1.0)), 3.0);
        return { dy: 0, vs: 0.03 * Math.sin(tE * 1.3), flash: 0, shake: 0, leanX, alert, droop: 0.12 };
      },
    },

    /* the ta-da: a quick lift with stretch, a double-beat flash,
       then a satisfied settle. Auto-clears. */
    success: {
      hold: 1.7,
      attack: 20,
      params: { ring: 1.0, streak: 0.90, warmth: 0.80, envFloor: 0.80, tempo: 1.3 },
      motion(tE) {
        let dy = 0,
          vs = 0,
          flash = 0,
          droop = -0.25;
        if (tE < 0.22) {
          const p = tE / 0.22;
          dy = -9 * easeOutBack(p);
          vs = 0.15 * p;
          flash = 1.1 * p;
        } else {
          const u = tE - 0.22;
          dy = -9 * Math.exp(-u * 4.0) * Math.cos(u * 9.0);
          vs = 0.15 * Math.exp(-u * 5.0);
          flash = Math.exp(-u * 2.2) * (0.65 + 0.45 * Math.cos(u * 12.0)); /* two beats */
        }
        return { dy, vs, flash, shake: 0, droop };
      },
    },

    /* owning a mistake: deflates, dims, shrinks away a little,
       one small apologetic bob, then quietly recovers. Auto-clears. */
    sheepish: {
      hold: 2.6,
      attack: 8,
      params: { warmth: 0.40, ring: 0.20, streak: 0.25, wobble: 0.020, tempo: 0.70, envFloor: 0.10, disp: 0.08 },
      motion(tE) {
        const recover = 1 - sm01((tE - 1.8) / 0.8);
        const bob = 2.0 * Math.pow(Math.max(0, Math.sin((tE - 1.0) * 3.0)), 2.0) * (tE > 1.0 && tE < 2.0 ? 1 : 0);
        return { dy: (4 + bob) * recover, vs: -0.14 * recover, flash: 0, shake: 0, droop: 0.50 * recover, leanX: -0.25 * recover };
      },
    },

    /* leaning in: brightened, slightly magnifying (it peers), with
       a gentle inquisitive sway and a perked crown */
    curious: {
      hold: 3.0,
      attack: 5,
      params: { ring: 0.60, warmth: 0.60, swirl: 0.50, wobble: 0.035, wobSpeed: 1.0, tempo: 1.1, envFloor: 0.40, refr: 0.42 },
      motion(tE) {
        return { dy: 3, vs: 0.02, flash: 0, shake: 0, leanY: 0.22, leanX: 0.12 * Math.sin(tE * 0.5), alert: 0.12 };
      },
    },

    /* soft, warm, dim, slow: settles gently toward the user and
       just stays present */
    sympathetic: {
      hold: 3.4,
      attack: 3,
      params: { warmth: 0.50, ring: 0.30, streak: 0.30, wobble: 0.015, tempo: 0.60, envFloor: 0.20, breath: 1.8, disp: 0.07 },
      motion(tE) {
        return { dy: 2, vs: -0.04, flash: 0, shake: 0, droop: 0.25, leanY: 0.12 + 0.03 * Math.sin(tE * 0.6) };
      },
    },

    /* contained pre-reveal energy: rapid tiny hops it can barely
       suppress, with a bigger one slipping out every few seconds */
    excited: {
      hold: 3.0,
      attack: 8,
      params: { warmth: 0.80, ring: 0.75, streak: 0.70, wobble: 0.050, wobSpeed: 1.4, swirl: 0.80, tempo: 1.4, envFloor: 0.55, disp: 0.18 },
      motion(tE) {
        let dy = -2.5 * Math.abs(Math.sin(tE * 5.2));
        let vs = 0.05 * Math.sin(tE * 10.4);
        const cyc = tE % 3.1;
        if (cyc < 0.42) {
          const p = cyc / 0.42;
          dy -= 7 * arc01(p);
          vs += 0.08 * Math.sin(p * Math.PI);
        }
        return { dy, vs, flash: 0, shake: 0, droop: -0.30 };
      },
    },

    /* patience: a slow circling sway like drumming fingers, with a
       soft metronome tick of light */
    waiting: {
      hold: null,
      attack: 4,
      params: { swirl: 0.30, wobble: 0.025, tempo: 0.80, ring: 0.40, warmth: 0.50, envFloor: 0.30 },
      motion(tE) {
        return {
          dy: 0,
          vs: 0.015 * Math.sin(tE * 2.2),
          shake: 0,
          leanX: 0.18 * Math.cos(tE * 1.1),
          leanY: 0.09 * Math.sin(tE * 1.1),
          flash: 0.18 * Math.pow(Math.max(0, Math.sin(tE * 2.2)), 12.0),
        };
      },
    },

    /* has something to say, won't interrupt: a polite periodic
       lift with a small crown perk and ping of light */
    alert: {
      hold: 2.4,
      attack: 12,
      params: { ring: 0.90, warmth: 0.65, envFloor: 0.60, tempo: 1.1, wobble: 0.030 },
      motion(tE) {
        const cyc = tE % 2.2;
        let dy = 0,
          al = 0,
          flash = 0;
        if (cyc < 0.5) {
          const p = cyc / 0.5;
          dy = -6 * arc01(p);
          al = 0.40 * arc01(p);
          flash = 0.5 * arc01(p);
        }
        return { dy, vs: 0, flash, shake: 0, alert: al };
      },
    },
  };

  /* ============================================================
     SYSTEM LAYER (overrides everything: trust must win over mood)
     muted: mic sealed, unmistakably so. offline: drained, not
     alive. asleep: dormant, shrunk, breathing slow. Leaving any
     system state plays the wake stinger.
     ============================================================ */
  type SystemDef = { params: ParamTable; pose: { droop: number; dy: number; vs: number } };
  const SYSTEM: Record<string, SystemDef> = {
    muted: {
      params: { desat: 0.20, seal: 1.0, tempo: 0.50, ring: 0.15, streak: 0.10, envFloor: 0.05, envScale: 0.40, wobble: 0.015, warmth: 0.40, swirl: 0.10, drift: 0.5, scale: 0.97 },
      pose: { droop: 0.10, dy: 2, vs: -0.03 },
    },
    offline: {
      params: { desat: 0.92, seal: 0, tempo: 0.12, ring: 0.05, streak: 0, envFloor: 0, envScale: 0.10, wobble: 0.005, warmth: 0.30, swirl: 0.05, drift: 0, scale: 0.95 },
      pose: { droop: 0.20, dy: 3, vs: -0.05 },
    },
    asleep: {
      params: { desat: 0.30, seal: 0, tempo: 0.30, ring: 0.10, streak: 0.10, envFloor: 0.05, envScale: 0.25, wobble: 0.008, warmth: 0.45, swirl: 0.08, drift: 0.5, scale: 0.82, breath: 3.2 },
      pose: { droop: 0.55, dy: 8, vs: -0.10 },
    },
  };

  let system: { name: string; weight: number; releasing: boolean } | null = null; /* { name, weight, releasing } */
  let wakeFx: { t0: number } | null = null; /* { t0 } wake stinger */
  let pulseFx: { t0: number } | null = null; /* { t0 } small receive pulse */
  function pulse(): void {
    pulseFx = { t0: performance.now() / 1000 };
  }

  function setSystem(name: OrbSystemName | null | 'none' | 'wake'): void {
    if (!name || name === 'none' || name === 'wake' || !SYSTEM[name]) {
      if (system) system.releasing = true;
      wakeFx = { t0: performance.now() / 1000 }; /* inflate back to life */
      return;
    }
    system = {
      name,
      weight: system && !system.releasing ? system.weight : 0,
      releasing: false,
    };
  }

  let emotion: { name: string; t0: number; weight: number; releasing: boolean } | null = null; /* { name, t0, weight, releasing } */

  function setEmotion(name: OrbEmotionName | null | 'none'): void {
    if (name === null || name === 'none' || !EMOTIONS[name]) {
      if (emotion) emotion.releasing = true;
      return;
    }
    emotion = { name, t0: performance.now() / 1000, weight: 0, releasing: false };
  }

  let cur: ParamTable = Object.assign({}, STATES.idle);
  let target: ParamTable = STATES.idle;
  let stateName = 'idle';

  function setState(name: OrbStateName): void {
    if (!STATES[name]) return;
    stateName = name;
    target = STATES[name];
  }

  /* ---------------- per-agent hue ---------------- */
  /* The orb tints toward the active agent's hue. We store the TARGET shift in
     radians and ease the live value toward it each frame so switching agents
     glides rather than snaps. Shift is measured from the orb's signature
     champagne hue (~42°), so an agent hue of 42 = no shift. */
  const CHAMPAGNE_HUE_DEG = 42;
  let hueShiftTarget = 0; // radians
  let hueShift = 0;       // radians (eased)
  /* held alert tint: 0 none, 0.5 warning(amber), 1 error(red). Eased so it
     fades in/out rather than snapping. */
  let alertTarget = 0;
  let alertLevel = 0;
  function setAlert(level: number): void { alertTarget = Math.max(0, Math.min(1, level)); }
  function setHue(deg: number | null): void {
    if (deg == null) { hueShiftTarget = 0; return; }
    // shortest signed delta from champagne to the agent hue, in [-180,180]
    let d = ((deg - CHAMPAGNE_HUE_DEG) % 360 + 540) % 360 - 180;
    hueShiftTarget = (d * Math.PI) / 180;
  }

  /* ---------------- envelope: simulated voice / thought activity ---------------- */
  function envelope(t: number): number {
    if (stateName === 'speaking') {
      /* syllable-ish bursts */
      const a = Math.max(0, Math.sin(t * 7.3)) * (0.5 + 0.5 * Math.sin(t * 1.9));
      const b = Math.max(0, Math.sin(t * 11.7 + 2.0)) * 0.5;
      return Math.min(1, 0.25 + 0.75 * (a * 0.7 + b * 0.5));
    }
    if (stateName === 'listening') return 0.25 + 0.2 * Math.sin(t * 2.1) + 0.1 * Math.sin(t * 5.7);
    if (stateName === 'thinking') return 0.45 + 0.25 * Math.sin(t * 3.1) * Math.sin(t * 0.7);
    return 0.15 + 0.1 * Math.sin(t * 0.8);
  }

  /* ---------------- pointer ---------------- */
  const mouse = { x: -9999, y: -9999, in: 0 };
  const onPointerMove = (e: PointerEvent) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.in = 1;
  };
  const onPointerLeave = () => (mouse.in = 0);
  let ripple = { t0: -99, ang: 0, amp: 0 };
  const onPointerDown = (e: PointerEvent) => {
    const cx = canvasPos.x + center.x + spring.x,
      cy = canvasPos.y + center.y + spring.y;
    const dx = cx - e.clientX,
      dy = cy - e.clientY;
    const md = Math.hypot(dx, dy);
    ripple.t0 = performance.now() / 1000;
    ripple.ang = Math.atan2(e.clientY - cy, e.clientX - cx);
    ripple.amp = 1.0;
    /* poke: a close click kicks the bubble away and it sheds wisps */
    const proxim = Math.max(0, Math.min(1, 1 - (md - radius) / (radius * 2.6)));
    if (proxim > 0 && md > 0.001) {
      spring.vx += (dx / md) * 240 * proxim;
      spring.vy += (dy / md) * 240 * proxim;
    }
  };

  /* ---------------- main loop ---------------- */
  /* prefers-reduced-motion is re-queried live via a matchMedia object
     (the prototype cached it once at load; here we read .matches each
     frame so a runtime change takes effect, and remove the listener on
     destroy). */
  const reduceMotionMq = matchMedia('(prefers-reduced-motion: reduce)');
  const onReduceMotionChange = () => {
    /* nothing to cache: the loop reads reduceMotionMq.matches directly.
       The listener exists only so we can remove it cleanly on destroy. */
  };
  if (reduceMotionMq.addEventListener) reduceMotionMq.addEventListener('change', onReduceMotionChange);

  let last = performance.now() / 1000,
    simT = 0;

  /* motion state: the bubble's center is base position plus ambient
     drift plus a spring that yields away from the cursor. Velocity
     of the composite center drives the wisps and momentum stretch. */
  const spring = { x: 0, y: 0, vx: 0, vy: 0 };
  let prevCx: number | null = null,
    prevCy: number | null = null;
  const velS = { x: 0, y: 0 };

  /* ---------------- task indicator controller ----------------
     Drives the spinning glyph inside the glass and the thin progress
     line pinned under the orb. Image/audio/song/video/compaction are
     "jobs": glyph + line. Dreamer/Healer are ambient agent states:
     glyph + an emotion shift, no line. One task shows at a time; extra
     starts replace the current glyph with a soft crossfade. */
  const Task = {
    icon: -1 as number,
    amt: 0,
    spin: 0,
    heartbeat: 0,
    _active: null as string | null,
    _target: 0,
    _last: 0,
    _progress: -1 /* -1 = indeterminate, 0..1 = determinate */,
    _isAgent: false,
    _beatT: 0,
    _pendingIcon: null as number | null,

    start(name: string, opts?: OrbTaskOpts) {
      opts = opts || {};
      const idx = TASK_ORDER.indexOf(name);
      if (idx < 0) return;
      this._active = name;
      this._pendingIcon = idx;
      this._target = 1;
      this._isAgent = name === 'dreamer' || name === 'healer';
      this._progress = typeof opts.progress === 'number' ? opts.progress : -1;
      /* ambient agents also tug the orb's demeanor */
      if (name === 'dreamer') setEmotion('sleepy');
      if (name === 'healer') setEmotion('calm');
      ProgressLine.show(!this._isAgent, this._progress);
    },
    update(progress: number) {
      if (this._active && !this._isAgent) {
        this._progress = progress;
        ProgressLine.set(progress);
      }
    },
    end(name?: string) {
      if (name && name !== this._active) return; /* ignore stale end */
      this._active = null;
      this._target = 0;
      this._progress = -1;
      ProgressLine.hide();
      if (this._isAgent) setEmotion(null);
      this._isAgent = false;
    },
    tick(now: number) {
      const dt = Math.min(now - (this._last || now), 0.05);
      this._last = now;
      /* fade the glyph in/out */
      const speed = 5.0;
      this.amt += (this._target - this.amt) * Math.min(1, dt * speed);
      /* swap icon at the bottom of a fade so it doesn't pop */
      if (this._pendingIcon != null && (this.amt < 0.06 || this.icon < 0)) {
        this.icon = this._pendingIcon;
        this._pendingIcon = null;
      }
      if (this.amt < 0.01 && this._target === 0) this.icon = -1;
      /* spin: agents drift slower and calmer than jobs */
      const rate = this._isAgent ? 0.7 : 2.1;
      if (this.amt > 0.01) this.spin += dt * rate;

      /* healer heartbeat: a lub-dub envelope on the orb's whole body.
         Runs only while the healer task is active; eases in with the
         glyph fade and decays out when it ends. */
      const healerOn = this._active === 'healer';
      let target = 0;
      if (healerOn || this.heartbeat > 0.001) {
        this._beatT += dt;
        const period = 0.92; /* ~65 bpm */
        const p = (this._beatT % period) / period;
        /* lub: a sharp beat near the start; dub: softer, just after */
        const lub = Math.exp(-Math.pow((p - 0.04) / 0.045, 2.0));
        const dub = Math.exp(-Math.pow((p - 0.22) / 0.055, 2.0)) * 0.6;
        const beat = Math.min(1, lub + dub);
        /* gate by the glyph fade so it grows in and fades out cleanly */
        target = beat * (healerOn ? this.amt : 0);
      } else {
        this._beatT = 0;
      }
      /* quick attack on each beat, smooth release between */
      const k = target > this.heartbeat ? 0.55 : 0.18;
      this.heartbeat += (target - this.heartbeat) * Math.min(1, dt * 60 * k);

      ProgressLine.tick(now);
    },
  };

  /* notification glyph: a STATIC (non-spinning) icon shown inside the glass for
     notifications, driven by setNoteGlyph(). Overrides the task glyph while
     active (an error/warning is more important than a running job). */
  const Note = { icon: -1, amt: 0, target: 0 };
  function setNoteGlyph(name: string | null): void {
    if (name == null) { Note.target = 0; return; }
    const idx = GLYPH_ORDER.indexOf(name);
    if (idx < 0) { Note.target = 0; return; }
    Note.icon = idx;
    Note.target = 1;
  }

  /* the thin progress line pinned under the orb */
  const ProgressLine = {
    el: null as HTMLDivElement | null,
    fill: null as HTMLElement | null,
    _vis: false,
    _det: false,
    _p: 0,
    _shuttle: 0,
    ensure() {
      if (this.el) return;
      const wrap = document.createElement('div');
      wrap.className = 'orb-progress';
      const fill = document.createElement('i');
      wrap.appendChild(fill);
      stageEl.appendChild(wrap);
      this.el = wrap;
      this.fill = fill;
    },
    position() {
      if (!this.el) return;
      let top = readStageVar(['--dojo3-orb-top', '--orb-top']);
      if (Number.isNaN(top)) top = 36;
      let dia = readStageVar(['--dojo3-orb-size', '--orb-diameter']);
      if (Number.isNaN(dia)) dia = 120;
      this.el.style.top = top + dia + 16 + 'px';
      this.el.style.width = Math.round(dia * 1.15) + 'px';
    },
    show(determinate: boolean, p: number) {
      this.ensure();
      this.position();
      this._det = determinate && p >= 0;
      this._p = this._det ? p : 0;
      this._vis = true;
      this.el!.classList.add('is-on');
      this.el!.classList.toggle('is-indeterminate', !this._det);
    },
    set(p: number) {
      this._det = p >= 0;
      this._p = Math.max(0, Math.min(1, p));
      if (this.el) this.el.classList.toggle('is-indeterminate', !this._det);
    },
    hide() {
      this._vis = false;
      if (this.el) this.el.classList.remove('is-on');
    },
    tick(now: number) {
      if (!this.el || !this._vis || !this.fill) return;
      if (this._det) {
        this.fill.style.left = '0%';
        this.fill.style.right = 100 - this._p * 100 + '%';
      } else {
        /* indeterminate shuttle sweep */
        this._shuttle = (now * 0.6) % 1;
        const w = 0.32;
        const x = this._shuttle * (1 + w) - w;
        this.fill.style.left = Math.max(0, x) * 100 + '%';
        this.fill.style.right = Math.max(0, 1 - (x + w)) * 100 + '%';
      }
    },
    remove() {
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = null;
      this.fill = null;
    },
  };

  /* ---------------- lifecycle scaffolding ---------------- */
  let running = false;
  let rafId = 0;

  function frame(): void {
    if (!running) return;
    const reduceMotion = reduceMotionMq.matches;
    const now = performance.now() / 1000;
    let dt = Math.min(now - last, 0.05);
    last = now;

    /* keep the orb's viewport offset current so pointer interaction + screen
       refraction follow the orb as the main column resizes (dock open/close,
       drag, window resize) — not where the orb used to be. */
    syncCanvasPos();

    /* ---- emotion lifecycle ---- */
    let mo: Required<MotionOut> = { dy: 0, vs: 0, flash: 0, shake: 0, droop: 0, alert: 0, spike: 0, leanX: 0, leanY: 0 };
    if (emotion) {
      const E = EMOTIONS[emotion.name];
      const tE = now - emotion.t0;
      if (E.hold !== null && tE > E.hold) emotion.releasing = true;
      const rate = emotion.releasing ? -3.0 : E.attack;
      emotion.weight = Math.max(0, Math.min(1, emotion.weight + rate * dt));
      if (emotion.releasing && emotion.weight <= 0.01) {
        emotion = null;
      } else {
        const m = E.motion(tE);
        const w = emotion.weight;
        /* with reduced motion: keep the static shape language (it
           still conveys the emotion) but drop the physical theatrics */
        const dyn = reduceMotion ? 0 : w;
        mo = {
          dy: (m.dy || 0) * dyn,
          vs: (m.vs || 0) * dyn,
          flash: (m.flash || 0) * dyn,
          shake: (m.shake || 0) * dyn,
          droop: (m.droop || 0) * (reduceMotion ? w * 0.7 : w),
          alert: (m.alert || 0) * (reduceMotion ? w * 0.7 : w),
          spike: (m.spike || 0) * (reduceMotion ? w * 0.7 : w),
          leanX: (m.leanX || 0) * w,
          leanY: (m.leanY || 0) * w,
        };
      }
    }

    /* ---- system lifecycle (overrides everything below) ---- */
    if (system) {
      const rate = system.releasing ? -2.8 : 3.0;
      system.weight = Math.max(0, Math.min(1, system.weight + rate * dt));
      if (system.releasing && system.weight <= 0.01) system = null;
    }

    /* ---- wake stinger: inflate back to life with an overshoot ---- */
    let wakeScale = 1,
      wakeFlash = 0;
    if (pulseFx) {
      const tp = now - pulseFx.t0;
      if (tp > 0.9) pulseFx = null;
      else if (!reduceMotion) wakeFlash += 0.5 * Math.exp(-tp * 4.0);
    }
    if (wakeFx) {
      const tw = now - wakeFx.t0;
      if (tw > 1.3) wakeFx = null;
      else if (!reduceMotion) {
        if (tw < 0.55) wakeScale = 0.55 + 0.50 * easeOutBack(tw / 0.55);
        else wakeScale = 1.0 + 0.05 * Math.exp(-(tw - 0.55) * 6.0) * Math.cos((tw - 0.55) * 18.0);
        wakeFlash = 0.9 * Math.exp(-tw * 3.0);
      }
    }

    /* ---- compose targets: base state, then emotion, then system ---- */
    const baseT = STATES[stateName];
    const effT: ParamTable = {};
    for (const key in baseT) {
      let v = baseT[key];
      if (emotion) {
        const ep = EMOTIONS[emotion.name].params;
        if (key in ep) v = v + (ep[key] - v) * emotion.weight;
      }
      if (system) {
        const sp = SYSTEM[system.name].params;
        if (key in sp) v = v + (sp[key] - v) * system.weight;
      }
      effT[key] = v;
    }

    /* system pose folds into the motion channels */
    if (system) {
      const po = SYSTEM[system.name].pose,
        ws = system.weight;
      mo.droop += po.droop * ws;
      mo.dy += po.dy * ws;
      mo.vs += po.vs * ws;
    }

    /* tempo: emotions change the orb's sense of time */
    simT += dt * (reduceMotion ? 0.06 : cur.tempo);

    /* ease params toward composed target */
    const k = 1 - Math.exp(-dt * 3.2);
    for (const key in effT) {
      if (cur[key] === undefined) cur[key] = effT[key];
      cur[key] += (effT[key] - cur[key]) * k;
    }

    // Live voice: ease toward the real mic level; otherwise the simulation.
    if (extEnv >= 0) envExtSmooth += (extEnv - envExtSmooth) * Math.min(1, dt * 14);
    const baseEnv = extEnv >= 0 ? envExtSmooth : (reduceMotion ? 0.15 : envelope(simT));
    const env = Math.max(baseEnv, cur.envFloor || 0) * (cur.envScale === undefined ? 1 : cur.envScale);

    /* ambient drift: slow wander, larger while thinking */
    const dAmp = reduceMotion ? 0 : cur.drift;
    const driftX = dAmp * (Math.sin(simT * 0.43 + 1.3) + 0.5 * Math.sin(simT * 0.97 + 4.1)) * 0.66;
    const driftY = dAmp * (Math.sin(simT * 0.37 + 2.6) + 0.5 * Math.sin(simT * 1.13 + 0.8)) * 0.5;

    /* cursor-push spring: the bubble shies away from a close pointer */
    const baseCx = canvasPos.x + cssSize / 2;
    const baseCy = canvasPos.y + cssSize / 2;
    let pushX = 0,
      pushY = 0;
    if (!reduceMotion && mouse.in) {
      const dx = baseCx - mouse.x,
        dy = baseCy - mouse.y;
      const md = Math.hypot(dx, dy);
      const proxim = Math.max(0, Math.min(1, 1 - (md - radius) / (radius * 2.2)));
      if (proxim > 0 && md > 0.001) {
        const push = 26 * proxim * proxim;
        pushX = (dx / md) * push;
        pushY = (dy / md) * push;
      }
    }
    const ks = 60,
      cs2 = 9.5;
    spring.vx += ((pushX - spring.x) * ks - spring.vx * cs2) * dt;
    spring.vy += ((pushY - spring.y) * ks - spring.vy * cs2) * dt;
    spring.x += spring.vx * dt;
    spring.y += spring.vy * dt;

    /* fine tremor for working / mad: two incommensurate sines */
    const shakeX = mo.shake * (Math.sin(now * 55.1) + 0.6 * Math.sin(now * 47.3 + 1.0));
    const shakeY = mo.shake * 0.8 * Math.cos(now * 51.7 + 2.0);

    const cx = center.x + driftX + spring.x + shakeX;
    const cy = center.y + driftY + spring.y + mo.dy + shakeY;

    /* velocity of the composite center, smoothed */
    if (prevCx !== null && prevCy !== null && dt > 0) {
      const vx = (cx - prevCx) / dt,
        vy = (cy - prevCy) / dt;
      const kv = Math.min(dt * 14, 1);
      velS.x += (vx - velS.x) * kv;
      velS.y += (vy - velS.y) * kv;
    }
    prevCx = cx;
    prevCy = cy;

    glc.uniform2f(U.u_viewport, innerWidth, innerHeight);
    glc.uniform2f(U.u_canvasPos, canvasPos.x, canvasPos.y);
    glc.uniform2f(U.u_canvasSize, cssSize, cssSize);
    glc.uniform1f(U.u_dpr, Math.min(devicePixelRatio || 1, 2));
    glc.uniform1f(U.u_time, simT);
    glc.uniform2f(U.u_center, cx, cy);
    glc.uniform1f(U.u_radius, radius * (cur.scale === undefined ? 1 : cur.scale) * wakeScale);
    glc.uniform2f(U.u_mouse, mouse.x, mouse.y);
    glc.uniform1f(U.u_mouseIn, reduceMotion ? 0 : mouse.in);
    glc.uniform2f(U.u_vel, velS.x, velS.y);

    glc.uniform1f(U.u_wobble, reduceMotion ? cur.wobble * 0.3 : cur.wobble);
    glc.uniform1f(U.u_wobSpeed, cur.wobSpeed);
    glc.uniform1f(U.u_swirl, cur.swirl);
    glc.uniform1f(U.u_squish, reduceMotion ? 0 : cur.squish);
    glc.uniform1f(U.u_warmth, cur.warmth);
    /* ease the per-agent hue toward its target (~0.5s glide) */
    hueShift += (hueShiftTarget - hueShift) * Math.min(1, dt * 4.5);
    glc.uniform1f(U.u_hueShift, hueShift);
    /* ease the held alert tint */
    alertLevel += (alertTarget - alertLevel) * Math.min(1, dt * 5.5);
    glc.uniform1f(U.u_alert, alertLevel);
    glc.uniform1f(U.u_ring, cur.ring);
    glc.uniform1f(U.u_streak, cur.streak);
    glc.uniform1f(U.u_env, env);
    glc.uniform1f(U.u_refr, cur.refr);
    glc.uniform1f(U.u_disp, cur.disp);
    glc.uniform1f(U.u_lens, cur.lens);
    glc.uniform3f(U.u_ripple, now / 1 - ripple.t0, ripple.ang, ripple.amp);
    glc.uniform1f(U.u_haze, ORB_HAZE);
    glc.uniform1f(U.u_atmos, atmosScale);
    glc.uniform1f(U.u_vsquash, mo.vs);
    glc.uniform1f(U.u_flash, mo.flash + wakeFlash);
    glc.uniform1f(U.u_anger, cur.anger || 0);
    glc.uniform1f(U.u_breath, cur.breath || 1);
    glc.uniform1f(U.u_shapeDroop, mo.droop);
    glc.uniform1f(U.u_shapeAlert, mo.alert);
    glc.uniform1f(U.u_shapeSpike, mo.spike);
    glc.uniform2f(U.u_lean, mo.leanX, mo.leanY);
    glc.uniform1f(U.u_desat, cur.desat || 0);
    glc.uniform1f(U.u_seal, cur.seal || 0);
    /* the orb's belly is open: a glass ring you look straight through,
       while the rim keeps the dispersion edge, lensing, and wobble */
    glc.uniform1f(U.u_centerClear, 1.0);
    glc.uniform1f(U.u_clearFade, 0.95);

    /* task spinner inside the glass */
    Task.tick(now);
    /* ease the notification glyph; while it's up it overrides the task glyph
       and renders static (no spin). */
    Note.amt += (Note.target - Note.amt) * Math.min(1, dt * 5.0);
    if (Note.amt < 0.01 && Note.target === 0) Note.icon = -1;
    const showNote = Note.amt > 0.01 && Note.icon >= 0;
    glc.uniform1f(U.u_taskIcon, showNote ? Note.icon : Task.icon);
    glc.uniform1f(U.u_taskAmt, showNote ? Note.amt : Task.amt);
    glc.uniform1f(U.u_taskSpin, showNote ? 0 : Task.spin);
    glc.uniform1f(U.u_heartbeat, Task.heartbeat);

    glc.clearColor(0, 0, 0, 0);
    glc.clear(glc.COLOR_BUFFER_BIT);
    glc.drawArrays(glc.TRIANGLES, 0, 3);
    rafId = requestAnimationFrame(frame);
  }

  function resize(): void {
    layout();
  }

  /* ---------------- listeners ---------------- */
  /* Repaint the backdrop when the viewport aspect shifts enough to matter
     (orientation change, large window resize) so the cast glow stays correctly
     sized. Debounced + threshold-gated so a drag-resize doesn't thrash the
     toDataURL/texture-upload. */
  let lastBackdropAspect = (typeof innerWidth === 'number' && typeof innerHeight === 'number')
    ? innerWidth / Math.max(1, innerHeight) : 1.6;
  let backdropTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => {
    resize();
    const a = innerWidth / Math.max(1, innerHeight);
    if (Math.abs(a - lastBackdropAspect) / lastBackdropAspect > 0.06) {
      if (backdropTimer) clearTimeout(backdropTimer);
      backdropTimer = setTimeout(() => {
        lastBackdropAspect = innerWidth / Math.max(1, innerHeight);
        makeBackdrop();
      }, 160);
    }
  };

  function start(): void {
    if (running) return;
    running = true;
    last = performance.now() / 1000;
    rafId = requestAnimationFrame(frame);
  }

  /* context loss: pause rendering on loss, re-init and resume on
     restore. Both listeners are removed in destroy(). */
  const onContextLost = (e: Event) => {
    e.preventDefault();
    running = false;
    cancelAnimationFrame(rafId);
  };
  const onContextRestored = () => {
    init();
    start();
  };

  /* ---------------- wiring ---------------- */
  makeBackdrop();

  addEventListener('resize', onResize);
  addEventListener('pointermove', onPointerMove);
  addEventListener('pointerleave', onPointerLeave);
  addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  init();
  start();

  /* ---------------- teardown ---------------- */
  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    running = false;
    cancelAnimationFrame(rafId);

    removeEventListener('resize', onResize);
    removeEventListener('pointermove', onPointerMove);
    removeEventListener('pointerleave', onPointerLeave);
    removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    if (reduceMotionMq.removeEventListener) reduceMotionMq.removeEventListener('change', onReduceMotionChange);
    if (uploadHandler) img.removeEventListener('load', uploadHandler);

    ProgressLine.remove();

    /* delete GL resources. We intentionally do NOT call
       WEBGL_lose_context.loseContext(): the browser hands back the SAME
       context for a given canvas+type, so losing it here would break the
       immediate re-init when React StrictMode (or a normal remount) mounts
       a fresh engine on the same canvas. A real unmount GCs the canvas and
       its context together, so nothing leaks. */
    try {
      if (tex) glc.deleteTexture(tex);
      if (iconTex) glc.deleteTexture(iconTex);
      if (buf) glc.deleteBuffer(buf);
      if (prog) glc.deleteProgram(prog);
    } catch {
      /* tearing down: ignore GL errors during teardown */
    }
    tex = iconTex = buf = prog = null;
  }

  /* mark target as referenced (kept for parity with the prototype's
     state machine; setState reassigns it). */
  void target;

  return {
    setState,
    setEmotion,
    setSystem,
    pulse,
    startTask: (name, o) => Task.start(name, o),
    updateTask: (p) => Task.update(p),
    endTask: (name) => Task.end(name),
    resize,
    setHue,
    setEnv: (level) => { extEnv = level == null ? -1 : Math.max(0, Math.min(1, level)); },
    setAlert,
    setNoteGlyph,
    destroy,
  };
}
