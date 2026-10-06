"""Durable schedules with atomic claims and an app-owned background worker."""
import asyncio
import json
import uuid
from datetime import datetime, timezone, timedelta
from app.services.storage_service import storage_service
from app.services.agent_service import run_agent


def now():
    return datetime.now(timezone.utc)


class RoutineService:
    def __init__(self, storage=storage_service):
        self.storage = storage
        self.worker = None

    def list(self, bot_id=None):
        with self.storage.database.connect() as c:
            rows = c.execute("SELECT payload FROM tasks WHERE owner_id = ? AND id LIKE 'routine-%' ORDER BY rowid DESC", (self.storage.owner_id,)).fetchall()
        tasks = [json.loads(row[0]) for row in rows]
        return [t for t in tasks if bot_id is None or t["bot_id"] == bot_id]

    def create(self, bot_id, name, prompt, run_at, interval_seconds=None):
        if not any(b["id"] == bot_id for b in self.storage.get_bots()):
            raise ValueError("Agente no encontrado.")
        if len(self.list()) >= 100:
            raise ValueError("Máximo 100 rutinas. Elimina una para continuar.")
        item = {"id": f"routine-{uuid.uuid4().hex}", "bot_id": bot_id, "name": name, "prompt": prompt,
                "run_at": run_at.astimezone(timezone.utc).isoformat(), "interval_seconds": interval_seconds,
                "status": "queued", "last_result": "", "created_at": now().isoformat()}
        with self.storage.database.connect() as c:
            c.execute("INSERT INTO tasks(id, thread_id, status, owner_id, payload) VALUES (?, ?, ?, ?, ?)",
                      (item["id"], bot_id, "queued", self.storage.owner_id, json.dumps(item)))
        self.storage.add_audit_event({"event": "routine.created", "bot_id": bot_id, "task_id": item["id"]})
        return item

    def change(self, task_id, action):
        with self.storage.database.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT payload FROM tasks WHERE id = ? AND owner_id = ?", (task_id, self.storage.owner_id)).fetchone()
            if not row:
                return None
            item = json.loads(row[0])
            if item["status"] == "running":
                raise ValueError("La rutina se está ejecutando; espera a que termine antes de cambiarla.")
            if action == "delete":
                c.execute("DELETE FROM tasks WHERE id = ? AND owner_id = ?", (task_id, self.storage.owner_id))
            else:
                item["status"] = "paused" if action == "pause" else "queued"
                if action == "run":
                    item["run_at"] = now().isoformat()
                c.execute("UPDATE tasks SET status = ?, payload = ? WHERE id = ? AND owner_id = ?",
                          (item["status"], json.dumps(item), task_id, self.storage.owner_id))
        self.storage.add_audit_event({"event": f"routine.{action}", "bot_id": item["bot_id"], "task_id": task_id})
        return item

    def claim_due(self):
        with self.storage.database.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute("SELECT payload FROM tasks WHERE status = 'queued' AND owner_id = ? AND id LIKE 'routine-%' ORDER BY rowid", (self.storage.owner_id,)).fetchall()
            for row in rows:
                item = json.loads(row[0])
                if datetime.fromisoformat(item["run_at"]) > now():
                    continue
                item["status"] = "running"
                c.execute("UPDATE tasks SET status = 'running', payload = ? WHERE id = ? AND owner_id = ?",
                          (json.dumps(item), item["id"], self.storage.owner_id))
                return item
        return None

    async def execute(self, item):
        result = ""
        ok = False
        self.storage.add_audit_event({"event": "routine.started", "bot_id": item["bot_id"], "task_id": item["id"]})
        try:
            bot = next((b for b in self.storage.get_bots() if b["id"] == item["bot_id"]), None)
            if bot is None:
                raise ValueError("El agente de esta rutina ya no existe.")
            async with asyncio.timeout(600):
                async for event in run_agent(bot["id"], bot["model"], [{"role": "user", "content": item["prompt"]}],
                                             bot["system_prompt"] + f"\nHora UTC: {now().isoformat()}", background=True):
                    if event["type"] == "content.delta":
                        result += event["delta"]
                    elif event["type"] == "turn.completed":
                        ok = event.get("ok", False)
        except asyncio.CancelledError:
            self._finish(item, "El servidor se detuvo durante esta ejecución. Puedes volver a lanzarla.", False)
            raise
        except Exception as exc:
            result = f"La rutina no pudo completarse ({type(exc).__name__})."
        self._finish(item, result, ok)

    def _finish(self, item, result, ok):
        item["last_result"] = result
        item["last_run_at"] = now().isoformat()
        # Failures pause recurrence to avoid repeated billed requests.
        item["status"] = "queued" if ok and item["interval_seconds"] else "completed" if ok else "failed"
        if ok and item["interval_seconds"]:
            item["run_at"] = (now() + timedelta(seconds=item["interval_seconds"])).isoformat()
        with self.storage.database.connect() as c:
            c.execute("UPDATE tasks SET status = ?, payload = ? WHERE id = ? AND owner_id = ?", (item["status"], json.dumps(item), item["id"], self.storage.owner_id))
        self.storage.add_message({"id": f"msg-{uuid.uuid4().hex}", "thread_id": item["bot_id"], "bot_id": item["bot_id"],
                                  "sender": "bot", "text": f"**{'Resultado' if ok else 'Error'} · {item['name']}**\n\n{result}",
                                  "created_at": now().isoformat(), "item_type": "assistant_text"})
        self.storage.add_audit_event({"event": "routine.completed" if ok else "routine.failed", "bot_id": item["bot_id"], "task_id": item["id"]})

    async def tick(self):
        item = self.claim_due()
        if item:
            await self.execute(item)

    async def _loop(self):
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.storage.add_audit_event({"event": "routine.worker_error", "error": type(exc).__name__})
            await asyncio.sleep(3)

    async def start(self):
        # An interrupted operation is reported; never silently repeat it.
        for item in self.list():
            if item["status"] == "running":
                self._finish(item, "Ejecución interrumpida por un reinicio. Vuelve a lanzarla si lo necesitas.", False)
        self.worker = asyncio.create_task(self._loop())

    async def stop(self):
        if self.worker:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
            self.worker = None


routine_service = RoutineService()
