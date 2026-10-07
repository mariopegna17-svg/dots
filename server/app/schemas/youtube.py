from typing import Literal
from pydantic import BaseModel, Field, field_validator


class YouTubeMetadata(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=5000)
    privacy: Literal["private", "unlisted", "public"] = "private"
    made_for_kids: bool

    @field_validator("title")
    @classmethod
    def clean_title(cls, value):
        value = value.strip()
        if not value or "<" in value or ">" in value:
            raise ValueError("Escribe un título sin los caracteres < o >.")
        return value


class YouTubeConfirmation(BaseModel):
    confirmed: Literal[True]
