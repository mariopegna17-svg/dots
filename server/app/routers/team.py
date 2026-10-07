from fastapi import APIRouter, HTTPException
from app.schemas.team import TeamInput
from app.services.team_service import team_service

router = APIRouter(prefix="/api/v1/team", tags=["team"])


@router.get("/runs")
async def runs():
    return {"runs": [team_service.public(i) for i in team_service.list()]}


@router.post("/runs")
async def create_run(data: TeamInput):
    try:
        return team_service.create(data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    item = team_service.get(run_id)
    if item is None:
        raise HTTPException(404, "Tarea de equipo no encontrada.")
    return team_service.public(item)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    try:
        return await team_service.cancel(run_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
