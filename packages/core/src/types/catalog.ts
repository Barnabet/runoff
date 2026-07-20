export interface CatalogTable {
  name: string;
  columns: { name: string; type: "INTEGER" | "REAL" | "TEXT" }[];
  rowCounts: Record<string, number>;
}

export interface CatalogFamily {
  id: string;
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: "quarter" | "month" | "year" | null;
  queryable: boolean;
  tables: CatalogTable[];
  filedPeriods: string[];
}
