"""Port of apps/web/lib/goldens.ts (all except scaffoldDigestFor, which is R3).

Golden row access + the single resolve accessor (spec §8). A corrupt stored
document degrades to document=None (inert to agents); corrupt/schema-drifted
bindings degrade to inventory=None. Never raises.
"""

import json

from runoff_api.core.bindings import parse_bindings
from runoff_api.core.db import RunoffDb

SELECT = (
    "SELECT id, blueprint_id AS blueprintId, kind, run_id AS runId, section_key AS sectionKey, "
    "name, mime, stored_filename AS storedFilename, note, period, document, "
    "unify_error AS unifyError, bindings, created_at AS createdAt FROM goldens"
)


def list_goldens(db: RunoffDb, blueprint_id: str) -> list[dict]:
    rows = db.execute(f"{SELECT} WHERE blueprint_id = ? ORDER BY rowid DESC", (blueprint_id,)).fetchall()
    return [dict(r) for r in rows]


def get_golden_row(db: RunoffDb, id: str) -> dict | None:
    """The shared SELECT by id — used by the pipeline and routes."""
    row = db.execute(f"{SELECT} WHERE id = ?", (id,)).fetchone()
    return dict(row) if row is not None else None


def golden_label(g: dict) -> str:
    if g["kind"] == "exemplar":
        return g["name"] if g["name"] is not None else "exemplar"
    section = f" §{g['sectionKey']}" if g["kind"] == "section" else ""
    return f"run {g['runId']}{section}"


def resolve_golden(db: RunoffDb, golden_id: str) -> dict | None:
    """The single golden accessor (spec §8). document: None ⇒ the golden is inert to agents."""
    row = db.execute(f"{SELECT} WHERE id = ?", (golden_id,)).fetchone()
    if row is None:
        return None
    g = dict(row)
    # A corrupt/unparseable stored document degrades to not-unified (document:None),
    # so the golden resolves inert to agents rather than 500ing the copilot route.
    document: dict | None = None
    try:
        if g["kind"] == "exemplar":
            document = json.loads(g["document"]) if g["document"] else None
        elif g["runId"]:
            doc_row = db.execute("SELECT document FROM runs WHERE id = ?", (g["runId"],)).fetchone()
            if doc_row is not None and doc_row["document"]:
                doc = json.loads(doc_row["document"])
                if g["kind"] == "section":
                    sections = [s for s in doc["sections"] if s["key"] == g["sectionKey"]]
                    document = {**doc, "sections": sections}
                else:
                    document = doc
                if len(document["sections"]) == 0:
                    document = None
    except Exception:  # noqa: BLE001 — any parse/shape error degrades to inert
        document = None
    # Corrupt/schema-drifted bindings on an otherwise-good document degrade to
    # None (renders "not yet bound") rather than throwing.
    inventory = parse_bindings(g["bindings"])
    return {
        "id": g["id"],
        "kind": g["kind"],
        "label": golden_label(g),
        "note": g["note"],
        "period": g["period"],
        "document": document,
        "inventory": inventory,
        "unifyError": g["unifyError"],
    }
