from fastapi.routing import APIRoute

from runoff_api.main import create_app

R1_READ_ROUTES = {
    ("GET", "/api/v1/projects"),
    ("GET", "/api/v1/projects/{id}"),
    ("GET", "/api/v1/projects/{id}/sources"),
    ("GET", "/api/v1/blueprints"),
    ("GET", "/api/v1/blueprints/{id}"),
    ("GET", "/api/v1/blueprints/{id}/run-options"),
    ("GET", "/api/v1/blueprints/{id}/memories"),
    ("GET", "/api/v1/blueprints/{id}/copilot"),
    ("GET", "/api/v1/blueprints/{id}/goldens"),
    ("GET", "/api/v1/runs/{id}"),
}

R1_WRITE_ROUTES = {
    ("POST", "/api/v1/projects"),
    ("PATCH", "/api/v1/projects/{id}"),
    ("POST", "/api/v1/blueprints"),
    ("PATCH", "/api/v1/blueprints/{id}"),
    ("POST", "/api/v1/blueprints/{id}/revisions"),
    ("POST", "/api/v1/blueprints/{id}/goldens"),
    ("PATCH", "/api/v1/goldens/{id}"),
    ("DELETE", "/api/v1/goldens/{id}"),
    ("PATCH", "/api/v1/memories/{id}"),
    ("DELETE", "/api/v1/memories/{id}"),
    ("POST", "/api/v1/flags/{id}"),
    ("POST", "/api/v1/runs"),
    ("POST", "/api/v1/runs/{id}/inputs"),
}

R1_ROUTES = R1_READ_ROUTES | R1_WRITE_ROUTES


def _collect_routes(app):
    """Enumerate (method, full-path) pairs for every mounted APIRoute.

    FastAPI >=0.116 mounts `include_router` calls as lazy `_IncludedRouter`
    objects instead of flattening APIRoutes onto `app.routes`, so the R1 routes
    live on each mount's `original_router` under its `include_context.prefix`.
    Fall back to the flat form for older FastAPI.
    """
    routes: set[tuple[str, str]] = set()
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in route.methods:
                if method != "HEAD":
                    routes.add((method, route.path))
        elif type(route).__name__ == "_IncludedRouter":
            prefix = route.include_context.prefix
            for sub in route.original_router.routes:
                if isinstance(sub, APIRoute):
                    for method in sub.methods:
                        if method != "HEAD":
                            routes.add((method, prefix + sub.path))
    return routes


def test_route_manifest():
    app = create_app(db_path=":memory:")
    assert _collect_routes(app) == R1_ROUTES
