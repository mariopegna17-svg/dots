'use client';
import { useCallback, useEffect, useState } from 'react';
import { FiClock, FiPlus, FiTrash2, FiPlay, FiPause, FiBookOpen } from 'react-icons/fi';
import { agentState } from '../lib/api';

const input = 'w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm focus:outline-none focus:border-violet-400';
const button = 'inline-flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-sm text-white hover:bg-violet-400 disabled:opacity-50';
const labels = { queued: 'Programada', running: 'Trabajando', paused: 'En pausa', completed: 'Completada', failed: 'Error' };

export default function AgentStatePanel({ bot, mode }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [interval, setRepeatInterval] = useState('');
  const [loading, setLoading] = useState(true);
  const memory = mode === 'memory';
  const refresh = useCallback(async () => {
    if (!bot?.id) return;
    try {
      const data = await agentState(memory ? `memory/${encodeURIComponent(bot.id)}` : `routines?bot_id=${encodeURIComponent(bot.id)}`);
      setItems(data);
      setLoading(false);
    } catch (e) { setError(e.message); setLoading(false); }
  }, [bot?.id, memory]);
  useEffect(() => {
    setItems([]); setError(''); setLoading(true); setText('');
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const submit = async (event) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (memory) await agentState(`memory/${encodeURIComponent(bot.id)}`, 'POST', { text });
      else await agentState('routines', 'POST', {
        bot_id: bot.id, name, prompt: text,
        run_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        interval_seconds: interval ? Number(interval) : null,
      });
      setText(''); setName(''); setDate(''); await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const change = async (item, action) => {
    setError(''); setBusy(true);
    try {
      const path = memory ? `memory/${encodeURIComponent(bot.id)}/${item.id}` : `routines/${item.id}${action === 'delete' ? '' : '/' + action}`;
      await agentState(path, action === 'delete' ? 'DELETE' : 'POST');
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className="h-full overflow-y-auto p-6 md:p-10">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-center gap-4">
        <div className="rounded-2xl bg-violet-500/10 p-4 text-violet-300">{memory ? <FiBookOpen size={24} /> : <FiClock size={24} />}</div>
        <div><h1 className="text-2xl font-semibold">{memory ? 'Memoria' : 'Rutinas'}</h1><p className="mt-1 text-sm text-zinc-400">{bot?.name} · {memory ? 'Preferencias que tu agente recordará' : 'Trabajo en segundo plano'}</p></div>
      </header>
      <p className="text-sm leading-relaxed text-zinc-400">{memory
        ? 'Guarda contexto, objetivos y preferencias. Puedes leer y borrar cada recuerdo. No guardes contraseñas ni claves API.'
        : 'Delega una tarea ahora o prográmala. Los resultados llegan al chat. Las rutinas siguen mientras el servidor esté encendido y las recurrentes se pausan si falla una ejecución.'}</p>
      {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</p>}
      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        {!memory && <label className="block space-y-2 text-sm"><span>Nombre</span><input className={input} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Resumen diario" /></label>}
        <label className="block space-y-2 text-sm"><span>{memory ? 'Nuevo recuerdo' : '¿Qué quieres que haga?'}</span><textarea className={input} rows={3} required maxLength={memory ? 4000 : 12000} value={text} onChange={(e) => setText(e.target.value)} placeholder={memory ? 'Prefiero respuestas breves en español…' : 'Prepara una agenda para mis objetivos de esta semana…'} /></label>
        {!memory && <div className="grid gap-4 md:grid-cols-2">
          <label className="block space-y-2 text-sm"><span>Primera ejecución · hora local</span><input aria-label="Primera ejecución" className={input} type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /><span className="text-xs text-zinc-500">Vacío: ejecutar ahora.</span></label>
          <label className="block space-y-2 text-sm"><span>Repetición</span><select className={input} value={interval} onChange={(e) => setRepeatInterval(e.target.value)}><option value="">Una vez</option><option value="3600">Cada hora</option><option value="86400">Cada 24 horas</option><option value="604800">Cada 7 días</option></select><span className="text-xs text-zinc-500">Se calcula desde el final de la última ejecución.</span></label>
        </div>}
        <button className={button} disabled={busy || !bot || loading}><FiPlus />{busy ? 'Guardando…' : memory ? 'Guardar recuerdo' : 'Crear rutina'}</button>
      </form>
      {loading ? <p role="status" className="text-zinc-500">Cargando…</p> : items.length === 0 ? <p className="py-8 text-center text-sm text-zinc-500">{memory ? 'Aún no hay recuerdos guardados.' : 'Aún no hay rutinas. Dale a tu agente su primera tarea.'}</p> : items.map((item) => <article key={item.id} className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>{memory ? <p className="whitespace-pre-wrap text-sm">{item.text}</p> : <><h2 className="font-medium">{item.name}</h2><p className="mt-2 whitespace-pre-wrap text-sm text-zinc-400">{item.prompt}</p><div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-500"><span className={item.status === 'failed' ? 'text-red-400' : item.status === 'running' ? 'text-violet-300' : 'text-emerald-400'}>{labels[item.status]}</span><span>{new Date(item.run_at).toLocaleString('es-ES')}</span></div></>}</div>
          <div className="flex gap-1">
            {!memory && <><button title="Ejecutar ahora" disabled={busy || item.status === 'running'} onClick={() => change(item, 'run')} className="p-2 text-violet-300 disabled:opacity-30"><FiPlay /></button>{['queued', 'paused'].includes(item.status) && <button title={item.status === 'paused' ? 'Reanudar' : 'Pausar'} disabled={busy} onClick={() => change(item, item.status === 'paused' ? 'resume' : 'pause')} className="p-2 text-zinc-400"><FiPause /></button>}</>}
            <button title={memory ? 'Borrar recuerdo' : 'Eliminar rutina'} disabled={busy || item.status === 'running'} onClick={() => change(item, 'delete')} className="p-2 text-zinc-500 hover:text-red-400 disabled:opacity-30"><FiTrash2 /></button>
          </div>
        </div>
        {!memory && item.last_result && <details className="text-sm text-zinc-400"><summary className="cursor-pointer text-violet-300">Último resultado</summary><p className="mt-3 whitespace-pre-wrap">{item.last_result}</p></details>}
      </article>)}
    </div>
  </section>;
}
