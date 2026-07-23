"""Port of packages/core/src/bindings.ts — stored-bindings parse + boundness rule."""

import json

from pydantic import ValidationError

from .types.golden_binding import BindingInventory


def parse_bindings(raw: str | None) -> dict | None:
    """Corrupt/schema-drifted stored bindings degrade to None (v1.5 contract)."""
    if not raw:
        return None
    try:
        return BindingInventory.model_validate(json.loads(raw)).model_dump(by_alias=True, exclude_unset=True)
    except (ValidationError, ValueError):
        return None


def boundness_counts(inv: dict | None) -> dict | None:
    if inv is None:
        return None
    items = inv["items"]
    bound = sum(1 for i in items if (i.get("binding") or {}).get("status") == "bound")
    mismatch = sum(1 for i in items if (i.get("binding") or {}).get("status") == "mismatch")
    return {"bound": bound, "mismatch": mismatch, "total": len(items)}
