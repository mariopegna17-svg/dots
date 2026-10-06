'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

export default function PublicDemo() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const controller = useRef(null);

  useEffect(() => {
    fetch('/api/v1/public/status').then(r => {
      if (!r.ok) throw new Error();
      return r.json();
    }).then(setStatus).catch(() => setError('No se pudo conectar con la demo.'));
    return () => controller.current?.abort();
  }, []);

  async function send(event) {
    event.preventDefault();
    const content = input.trim();
    if (!content || busy || !status?.enabled) return;
    let history = [...messages, { role: 'user', content }].slice(-9);
    // Keep complete recent exchanges within the server's bounded context.
    while (history.length > 1 && history.reduce((n, m) => n + m.content.length, 0) > 8000) history = history.slice(2);
    history = history.map(m => ({ ...m, content: m.content.slice(0, 2000) }));
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);
    setError('');
    controller.current = new AbortController();
    try {
      const response = await fetch('/api/v1/public/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }), signal: controller.current.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.detail === 'string' ? body.detail : 'No se pudo enviar el mensaje.');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', answer = '', completed = false;
      try {
        while (!completed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const item = JSON.parse(line.slice(5).trim());
              if (item.type === 'content.delta') {
                answer += item.delta;
                setMessages([...history, { role: 'assistant', content: answer }]);
              } else if (item.type === 'turn.completed') {
                if (!item.ok) throw new Error('La respuesta no pudo completarse.');
                completed = true;
              }
            }
          }
        }
        if (!completed) throw new Error('La conexión se interrumpió. Inténtalo de nuevo.');
      } finally { await reader.cancel(); }
    } catch (failure) {
      if (failure.name !== 'AbortError') setError(failure.message);
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col p-6">
      <header className="mb-8 flex items-center justify-between border-b border-white/10 pb-5">
        <div><h1 className="text-2xl font-semibold">Dot · Demo pública</h1><p className="mt-2 text-sm text-zinc-400">Un chat con IA para probar y compartir.</p></div>
        <a href="/app" className="text-sm text-zinc-400 hover:text-white">Acceso del propietario</a>
      </header>
      <p className="mb-6 text-sm text-zinc-400">{status?.enabled ? `La demo dispone de ${status.daily_limit} consultas diarias compartidas. Tus mensajes se conservan únicamente en esta pestaña y se envían al proveedor de IA para responder.` : status ? 'El propietario todavía no ha habilitado esta demo.' : 'Conectando…'}</p>
      <div aria-live="polite" className="flex-1 space-y-5 select-text">
        {!messages.length && <div className="rounded-2xl bg-white/5 p-6"><h2 className="text-lg">¿En qué te ayudo?</h2><p className="mt-2 text-zinc-400">Prueba a pedirme una idea, explicar un concepto o redactar un texto.</p></div>}
        {messages.map((m, i) => <article key={i} className={`rounded-2xl p-5 ${m.role === 'user' ? 'bg-white/10' : 'bg-white/5'}`}><p className="mb-2 text-xs text-zinc-400">{m.role === 'user' ? 'Tú' : 'Dot'}</p><div className="space-y-3 break-words"><ReactMarkdown>{m.content || (busy ? 'Pensando…' : 'Sin respuesta')}</ReactMarkdown></div></article>)}
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
      <form onSubmit={send} className="sticky bottom-0 mt-8 flex gap-3 bg-background py-4">
        <input aria-label="Tu mensaje" value={input} onChange={e => setInput(e.target.value)} maxLength={2000} disabled={busy || !status?.enabled} placeholder="Escribe un mensaje…" className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 outline-none focus:border-cyan-400" />
        <button disabled={busy || !status?.enabled || !input.trim()} className="rounded-xl bg-cyan-400 px-5 py-3 font-medium text-black disabled:opacity-40">{busy ? 'Respondiendo…' : 'Enviar'}</button>
      </form>
    </main>
  );
}
