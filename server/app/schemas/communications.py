import re
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CommunicationSettings(BaseModel):
    communications_enabled: bool = False
    twilio_account_sid: str = ""
    twilio_auth_token: str = Field(default="", max_length=256, json_schema_extra={"writeOnly": True})
    owner_phone_number: str = ""
    twilio_voice_number: str = ""
    twilio_whatsapp_number: str = ""
    communication_bot_id: str = ""
    communication_public_url: str = ""
    twilio_auth_token_configured: bool = False

    @field_validator("owner_phone_number", "twilio_voice_number", "twilio_whatsapp_number")
    @classmethod
    def phone_number(cls, value):
        value = value.strip().removeprefix("whatsapp:")
        if value and not re.fullmatch(r"\+[1-9][0-9]{6,14}", value):
            raise ValueError("Usa el formato internacional, por ejemplo +34612345678, sin espacios.")
        return value

    @field_validator("twilio_account_sid")
    @classmethod
    def account_sid(cls, value):
        value = value.strip()
        if value and not re.fullmatch(r"AC[0-9a-fA-F]{32}", value):
            raise ValueError("El Account SID debe empezar por AC y tener 34 caracteres.")
        return value

    @field_validator("communication_public_url")
    @classmethod
    def public_url(cls, value):
        value = value.strip().rstrip("/")
        if value:
            url = urlsplit(value)
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path:
                raise ValueError("Introduce la URL HTTPS pública de tu aplicación, sin rutas ni parámetros.")
        return value


class CommunicationMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bot_id: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1500)

    @field_validator("message")
    @classmethod
    def message_text(cls, value):
        if not value.strip():
            raise ValueError("Escribe el mensaje que quieres enviar.")
        return value.strip()
