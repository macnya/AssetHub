import { useState, useRef, useEffect } from 'react';
import { askAssistant } from '../api';

// A question box over the register. It answers within whatever the signed-in
// user's own role and branch already permit — the endpoint reuses the same
// scoping as every other page, so this cannot show anyone more than the panel
// would.

const SUGGESTIONS = [
  'How many assets at Head Office?',
  'What is the total value of the register?',
  'How many days annual leave do I get?',
  'What do I do with company assets when I leave?',
];

export default function Assistant({ scopedTo }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  // Scroll the newest message into view. Without this the answer arrives below
  // the fold and looks like nothing happened.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text) => {
    const q = (text ?? question).trim();
    if (!q || busy) return;

    setMessages((m) => [...m, { role: 'user', text: q }]);
    setQuestion('');
    setBusy(true);

    try {
      const res = await askAssistant(q);
      setMessages((m) => [...m, { role: 'bot', text: res.answer, sources: res.sources }]);
    } catch (err) {
      setMessages((m) => [...m, {
        role: 'bot',
        error: true,
        text: err.response?.data?.error || 'I could not answer that. Please try again.',
      }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="assistant-fab" onClick={() => setOpen(true)} aria-label="Ask about the register">
        Ask the register
      </button>
    );
  }

  return (
    <div className="assistant">
      <div className="assistant-head">
        <div>
          <div className="assistant-title">Ask the register</div>
          {/* A scoped user should never be in doubt that answers cover part of
              the register rather than all of it. */}
          <div className="assistant-sub">
            {scopedTo ? `Answers cover ${scopedTo} only` : 'Assets, custody and policy'}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close">✕</button>
      </div>

      <div className="assistant-body">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <p>Ask about assets, who holds what, or HR and ICT policy.</p>
            <div className="assistant-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="assistant-chip" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`assistant-msg is-${m.role}${m.error ? ' is-error' : ''}`}>
            {m.text}
            {m.sources?.length > 0 && (
              <div className="assistant-sources">from {m.sources.slice(0, 3).join(', ')}</div>
            )}
          </div>
        ))}

        {busy && <div className="assistant-msg is-bot is-thinking">Looking that up…</div>}
        <div ref={endRef} />
      </div>

      <form
        className="assistant-input"
        onSubmit={(e) => { e.preventDefault(); send(); }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
          maxLength={500}
          disabled={busy}
        />
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !question.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}