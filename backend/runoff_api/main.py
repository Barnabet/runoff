from fastapi import FastAPI

from runoff_api.api import blueprints, flags, goldens, memories, projects, runs, sources
from runoff_api.core.db import open_db
from runoff_api.deps import default_db_path


def create_app(db_path: str | None = None) -> FastAPI:
    app = FastAPI(title="Runoff API", version="1")
    app.state.db = open_db(db_path or default_db_path())
    for router in (
        projects.router,
        blueprints.router,
        goldens.router,
        runs.router,
        memories.router,
        flags.router,
        sources.router,
    ):
        app.include_router(router, prefix="/api/v1")
    return app


app = create_app()
