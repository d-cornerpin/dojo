/**
 * "How the dojo works" — a navigable, screenshot-led tour shown from the final
 * setup step. Two panes: a chapter list on the left, the selected chapter's
 * content (with a screenshot) on the right. Closeable via the X, a backdrop
 * tap, the final "Got it", or Escape.
 *
 * Rendered through a portal into .dojo3-stage so it escapes the setup card's
 * backdrop-filter (which would otherwise trap position:fixed) while still
 * inheriting the dojo's tokens + .btn styling.
 *
 * Screenshots live in /public/tutorial/*.png. NOTE: those are captured from a
 * live dojo — review/curate them (the vault especially) before shipping.
 */
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Chapter {
  id: string;
  nav: string;
  title: string;
  body: string[];
  img: string;
  alt: string;
}

const CHAPTERS: Chapter[] = [
  {
    id: 'orb',
    nav: 'The orb',
    title: 'The orb is your dojo',
    body: [
      'Everything centers on the orb. Type or talk to your primary agent right here — it is the one you will work with most.',
      'Click the orb any time to open the ring of controls: Agents, Vault, Techniques, Tracker, Ledger, Vitals, and Settings.',
    ],
    img: '/tutorial/orb.png',
    alt: 'The dojo orb with its ring of controls open',
  },
  {
    id: 'agents',
    nav: 'Your agents',
    title: 'A team, not just one agent',
    body: [
      'Your primary agent does not work alone. It spins up sub-agents to handle tasks in parallel, a project manager keeps long work on track, a trainer turns repeated work into reusable techniques, and a dreamer reviews the day while you sleep.',
      'Open Agents from the orb to meet everyone, recruit new agents, or give each its own model and personality.',
    ],
    img: '/tutorial/agents.png',
    alt: 'The agents grid showing the primary agent and its team',
  },
  {
    id: 'memory',
    nav: 'Memory',
    title: 'The dojo remembers',
    body: [
      'As you talk, the dojo saves what matters — facts, preferences, decisions, people — into a long-term memory vault. You never have to repeat yourself, and your agents pick up where you left off, even weeks later.',
      'Browse, search, and edit everything from the Vault.',
    ],
    img: '/tutorial/vault.png',
    alt: 'The memory vault listing saved facts and preferences',
  },
  {
    id: 'providers',
    nav: 'Providers',
    title: 'Add an AI provider',
    body: [
      'Providers are the services that power your models. Open Settings → Providers and click Add Provider.',
      'Pick your service — Anthropic, OpenAI, OpenRouter, DeepSeek, or a local Ollama — paste your API key, and the dojo validates it on the spot. Add as many as you like; "Sync Models & Pricing" pulls in each provider’s latest catalog.',
    ],
    img: '/tutorial/providers.png',
    alt: 'Settings → Providers showing the configured providers',
  },
  {
    id: 'models',
    nav: 'Models',
    title: 'Enable the models you’ll use',
    body: [
      'Settings → Models lists every model from your providers. Toggle on the ones you want your agents to use. For aggregators like OpenRouter, search the catalog and add specific models.',
      'Scroll down to the capability cards to choose which model handles images, video, music, transcription, and the system / voice-opener roles.',
    ],
    img: '/tutorial/models.png',
    alt: 'Settings → Models showing model toggles and capability cards',
  },
  {
    id: 'router',
    nav: 'The router',
    title: 'Let the dojo pick the model',
    body: [
      'You do not have to choose a model for every task. Sort your models into tiers — a cheap Light tier for simple work, a powerful Heavy tier for hard problems — and the router automatically picks the cheapest capable model for each request.',
      'It scores locally in under 2 ms with no extra LLM call, using signals like length, code, and reasoning markers — which you can weight right on this page.',
    ],
    img: '/tutorial/router.png',
    alt: 'Settings → Router showing tiers and dimension weights',
  },
  {
    id: 'techniques',
    nav: 'Techniques',
    title: 'Reusable playbooks',
    body: [
      'Techniques are step-by-step playbooks your agents can load on demand. When you teach the dojo to do something well, the trainer can turn it into a technique so every agent does it the same way next time.',
      'Browse, edit, publish, or share them from the Techniques page (open it from the orb).',
    ],
    img: '/tutorial/techniques.png',
    alt: 'The Techniques page showing a grid of techniques',
  },
  {
    id: 'channels',
    nav: 'Email & messaging',
    title: 'Connect accounts & channels',
    body: [
      'Settings → Channels is where your agents reach the outside world. Under Agent’s Google Account, click Connect and sign in to grant Gmail, Calendar, Drive, Docs, and Sheets. The Microsoft Account section does the same for Outlook and OneDrive — toggle individual services on or off any time.',
      'The same page approves iMessage senders so you can text your dojo from your phone, or connects a Twilio number for SMS.',
    ],
    img: '/tutorial/channels.png',
    alt: 'Settings → Channels showing Google account and messaging options',
  },
  {
    id: 'voice',
    nav: 'Voice',
    title: 'Talk to your agents',
    body: [
      'Settings → Voice lets you pick a voice, run it locally (Kokoro) or in the cloud (Hume), and tune turn-taking — how patient the dojo is before it responds.',
      'Everything runs on your machine unless you choose a cloud voice.',
    ],
    img: '/tutorial/voice.png',
    alt: 'Settings → Voice showing voice and turn-taking options',
  },
];

export const DojoTutorial = ({ onClose }: { onClose: () => void }) => {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setActive((i) => Math.min(i + 1, CHAPTERS.length - 1));
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setActive((i) => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const host = (typeof document !== 'undefined' && document.querySelector('.dojo3-stage')) || (typeof document !== 'undefined' ? document.body : null);
  if (!host) return null;

  const chapter = CHAPTERS[active];
  const atEnd = active === CHAPTERS.length - 1;

  return createPortal(
    <div className="dojo3-tut-backdrop" onPointerDown={onClose}>
      <div
        className="dojo3-tut dojo3-tut--wide"
        role="dialog"
        aria-modal="true"
        aria-label="How the dojo works"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="dojo3-tut__head">
          <h2 className="dojo3-tut__title">How the dojo works</h2>
          <button type="button" className="dojo3-tut__close" onClick={onClose} aria-label="Close tour">×</button>
        </header>

        <div className="dojo3-tut__main">
          <nav className="dojo3-tut__nav" aria-label="Tour chapters">
            {CHAPTERS.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`dojo3-tut__navbtn ${i === active ? 'is-active' : ''}`}
                aria-current={i === active ? 'true' : undefined}
                onClick={() => setActive(i)}
              >
                {c.nav}
              </button>
            ))}
          </nav>

          <div className="dojo3-tut__content" key={chapter.id}>
            <h3 className="dojo3-tut__sec-title">{chapter.title}</h3>
            {chapter.body.map((p, i) => (
              <p key={i} className="dojo3-tut__sec-body">{p}</p>
            ))}
            <img className="dojo3-tut__img" src={chapter.img} alt={chapter.alt} loading="lazy" />
          </div>
        </div>

        <footer className="dojo3-tut__foot">
          <button
            type="button"
            className="btn dojo3-tut__back"
            onClick={() => setActive((i) => Math.max(i - 1, 0))}
            disabled={active === 0}
          >
            Back
          </button>
          <span className="dojo3-tut__count">{active + 1} / {CHAPTERS.length}</span>
          {atEnd ? (
            <button type="button" className="btn btn--primary" onClick={onClose}>Got it</button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => setActive((i) => Math.min(i + 1, CHAPTERS.length - 1))}>Next</button>
          )}
        </footer>
      </div>
    </div>,
    host,
  );
};
