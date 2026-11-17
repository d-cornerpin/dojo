/**
 * "How the dojo works": a navigable text tour shown from the final
 * setup step. Two panes: a chapter list on the left, the selected chapter's
 * text on the right. Closeable via the X, a backdrop
 * tap, the final "Got it", or Escape.
 *
 * Rendered through a portal into .dojo3-stage so it escapes the setup card's
 * backdrop-filter (which would otherwise trap position:fixed) while still
 * inheriting the dojo's tokens + .btn styling.
 */
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Chapter {
  id: string;
  nav: string;
  title: string;
  body: string[];
}

const CHAPTERS: Chapter[] = [
  {
    id: 'orb',
    nav: 'The orb',
    title: 'The orb is your dojo',
    body: [
      'Everything centers on the orb. Type or talk to your primary agent right here, it is the one you will work with most.',
      'Click the orb any time to open the ring of controls: Agents, Vault, Techniques, Tracker, Ledger, Vitals, and Settings.',
    ],
  },
  {
    id: 'agents',
    nav: 'Your agents',
    title: 'A team, not just one agent',
    body: [
      'Your primary agent does not work alone. It spins up sub-agents to handle tasks in parallel, a project manager keeps long work on track, a trainer turns repeated work into reusable techniques, and a dreamer reviews the day while you sleep.',
      'Open Agents from the orb to meet everyone, recruit new agents, or give each its own model and personality.',
    ],
  },
  {
    id: 'memory',
    nav: 'Memory',
    title: 'The dojo remembers',
    body: [
      'As you talk, the dojo saves what matters (facts, preferences, decisions, people) into a long-term memory vault. You never have to repeat yourself, and your agents pick up where you left off, even weeks later.',
      'Browse, search, and edit everything from the Vault.',
    ],
  },
  {
    id: 'providers',
    nav: 'Providers',
    title: 'Add an AI provider',
    body: [
      'Providers are the services that power your models. Open Settings → Providers and click Add Provider.',
      'Pick your service (Anthropic, OpenAI, OpenRouter, DeepSeek, or a local Ollama), paste your API key, and the dojo validates it on the spot. Add as many as you like; "Sync Models & Pricing" pulls in each provider’s latest catalog.',
    ],
  },
  {
    id: 'models',
    nav: 'Models',
    title: 'Enable the models you’ll use',
    body: [
      'Settings → Models lists every model from your providers. Toggle on the ones you want your agents to use. For aggregators like OpenRouter, search the catalog and add specific models.',
      'Scroll down to the capability cards to choose the model for each job: looking at images when an agent’s own model cannot, making images, video, speech and music, and transcription.',
    ],
  },
  {
    id: 'router',
    nav: 'The router',
    title: 'Let the dojo pick the model',
    body: [
      'You do not have to choose a model for every task. Sort your models into tiers: a cheap Light tier for simple work, a powerful Heavy tier for hard problems, and the router automatically picks the cheapest capable model for each request.',
      'It decides on your own machine with no paid model call: a small local model reads each request, and when that model is not running a keyword score takes over, whose weights you can set right on this page.',
    ],
  },
  {
    id: 'techniques',
    nav: 'Techniques',
    title: 'Reusable playbooks',
    body: [
      'Techniques are step-by-step playbooks your agents can load on demand. When you teach the dojo to do something well, the trainer can turn it into a technique so every agent does it the same way next time.',
      'Browse, edit, publish, or share them from the Techniques page (open it from the orb).',
    ],
  },
  {
    id: 'channels',
    nav: 'Email & messaging',
    title: 'Connect accounts & channels',
    body: [
      'Settings → Channels is where your agents reach the outside world. Under Agent’s Google Account, click Connect and sign in to grant Gmail, Calendar, Drive, Docs, and Sheets. The Microsoft Account section does the same for Outlook and OneDrive, toggle individual services on or off any time.',
      'The same page approves iMessage senders so you can text your dojo from your phone, or connects a Twilio number for SMS.',
    ],
  },
  {
    id: 'voice',
    nav: 'Voice',
    title: 'Talk to your agents',
    body: [
      'Settings → Voice lets you pick a voice, run it locally (Kokoro) or in the cloud (Hume), and tune turn-taking, how patient the dojo is before it responds.',
      'Everything runs on your machine unless you choose a cloud voice.',
    ],
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
