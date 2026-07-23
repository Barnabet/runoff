"""Port of packages/core/src/types/catalog.ts.

catalog.ts declares only TypeScript interfaces (no zod). Ported as CamelModel
models per the task brief (`CatalogFamily`, `CatalogTable`) for validation
completeness; catalogs flow as plain dicts at runtime.
"""

from typing import Literal

from .base import CamelModel


class _CatalogColumn(CamelModel):
    name: str
    type: Literal["INTEGER", "REAL", "TEXT"]


class CatalogTable(CamelModel):
    name: str
    columns: list[_CatalogColumn]
    row_counts: dict[str, int]


class CatalogFamily(CamelModel):
    id: str
    key: str
    label: str
    kind: Literal["periodic", "constant"]
    granularity: Literal["quarter", "month", "year"] | None
    queryable: bool
    tables: list[CatalogTable]
    filed_periods: list[str]
