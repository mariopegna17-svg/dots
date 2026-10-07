from pydantic import BaseModel, Field, field_validator


class TeamInput(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    bot_ids: list[str] = Field(min_length=2, max_length=4)
    coordinator_id: str

    @field_validator("prompt")
    @classmethod
    def clean_prompt(cls, value):
        if not value.strip():
            raise ValueError("Escribe una tarea para tu equipo.")
        return value.strip()

    @field_validator("bot_ids")
    @classmethod
    def unique_bots(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Selecciona Dots diferentes.")
        return value
