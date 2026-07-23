import os

from fastapi import Request
from fastapi.responses import JSONResponse

from runoff_api.core.db import RunoffDb


def get_db(request: Request) -> RunoffDb:
    return request.app.state.db


def err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def default_db_path() -> str:
    return os.environ.get("RUNOFF_DB", "data/runoff.db")
