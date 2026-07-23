import json
from typing import Any


def to_json(value: Any) -> str:
    """JSON framing byte-compatible with JS JSON.stringify (compact, non-ASCII kept)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
