import type { ColumnInfo, DatabaseType, IndexInfo, QueryTab } from "@/types/database";
import * as api from "@/lib/backend/api";
import { editableRowIdentifierColumns } from "@/lib/table/tableEditing";
import { createMetadataLoadTrace, logMetadataLoadTrace, MetadataLoadCoordinator, type MetadataLoadCacheStatus, type MetadataLoadTraceLogger } from "./metadataLoadCoordinator";
import type { MetadataScopeInput } from "./metadataLoadScope";
import { MetadataResultCache, type MetadataCacheInvalidation } from "./metadataResultCache";

export const TABLE_METADATA_CACHE_TTL_MS = 30_000;
const TABLE_METADATA_CACHE_MAX_ENTRIES = 120;

export interface TableMetadata {
  schema?: string;
  tableName: string;
  tableType?: string;
  catalog?: string;
  database?: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKeys: string[];
  cachedAt: number;
}

export interface TableMetadataRequest {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  databaseType: DatabaseType | string;
  driverProfile?: string;
  catalog?: string;
  force?: boolean;
  traceLogger?: MetadataLoadTraceLogger;
}

export interface TableMetadataLoadResult {
  metadata: TableMetadata;
  cacheStatus: MetadataLoadCacheStatus;
  ageMs: number;
}

const tableMetadataCache = new MetadataResultCache<TableMetadata>({
  ttlMs: TABLE_METADATA_CACHE_TTL_MS,
  maxEntries: TABLE_METADATA_CACHE_MAX_ENTRIES,
});

const tableMetadataCoordinator = new MetadataLoadCoordinator((event) => {
  console.debug("[DBX][metadata-load:table-coordinator]", event);
});

// 失效代数：跨越失效边界的旧加载完成后不得写缓存——结构变更后 force 拉到的
// 新值可能被保存前启动、最后返回的在途加载回填覆盖
let tableMetadataInvalidationStamp = 0;

export function tableMetadataScope(request: Pick<TableMetadataRequest, "connectionId" | "database" | "schema" | "tableName" | "tableType" | "driverProfile" | "databaseType" | "catalog">): MetadataScopeInput {
  return {
    kind: "table-metadata",
    connectionId: request.connectionId,
    database: request.database,
    schema: request.schema ?? "",
    tableName: request.tableName,
    tableType: request.tableType,
    driverProfile: request.driverProfile || request.databaseType,
    extra: request.catalog ? { catalog: request.catalog } : undefined,
  };
}

export function getCachedTableMetadata(request: Pick<TableMetadataRequest, "connectionId" | "database" | "schema" | "tableName" | "tableType" | "driverProfile" | "databaseType" | "catalog">): TableMetadataLoadResult | undefined {
  const hit = tableMetadataCache.get(tableMetadataScope(request));
  if (!hit) return undefined;
  return { metadata: hit.value, cacheStatus: hit.stale ? "stale" : "hit", ageMs: hit.ageMs };
}

export function tableMetadataToDataTabMeta(metadata: TableMetadata, schema = metadata.schema): NonNullable<QueryTab["tableMeta"]> {
  return {
    schema,
    tableName: metadata.tableName,
    tableType: metadata.tableType,
    catalog: metadata.catalog,
    database: metadata.database,
    columns: metadata.columns,
    primaryKeys: metadata.primaryKeys,
  };
}

export async function loadTableMetadata(request: TableMetadataRequest): Promise<TableMetadataLoadResult> {
  const scope = tableMetadataScope(request);
  const trace = createMetadataLoadTrace(scope);
  if (!request.force) {
    const cached = tableMetadataCache.get(scope);
    if (cached) {
      logMetadataLoadTrace(request.traceLogger, trace, "cache-hit", {
        cacheStatus: cached.stale ? "stale" : "hit",
        resultCount: cached.value.columns.length,
        stale: cached.stale,
      });
      return { metadata: cached.value, cacheStatus: cached.stale ? "stale" : "hit", ageMs: cached.ageMs };
    }
  }

  logMetadataLoadTrace(request.traceLogger, trace, "cache-miss", { cacheStatus: request.force ? "refresh" : "miss", force: request.force === true });
  const invalidationStampAtStart = tableMetadataInvalidationStamp;
  const metadata = await tableMetadataCoordinator.run(
    scope,
    async () => {
      const columns = await api.getColumns(request.connectionId, request.database, request.schema ?? "", request.tableName, request.catalog);
      const indexes = await api.listIndexes(request.connectionId, request.database, request.schema ?? "", request.tableName, request.catalog).catch((): IndexInfo[] => []);
      const primaryKeys = editableRowIdentifierColumns(request.databaseType as DatabaseType, columns, indexes, request.tableType);
      return {
        schema: request.schema || undefined,
        tableName: request.tableName,
        tableType: request.tableType,
        catalog: request.catalog,
        database: request.database,
        columns,
        indexes,
        primaryKeys,
        cachedAt: Date.now(),
      };
    },
    { force: request.force, kind: scope.kind },
  );

  if (invalidationStampAtStart === tableMetadataInvalidationStamp) {
    tableMetadataCache.set(scope, metadata);
  }
  logMetadataLoadTrace(request.traceLogger, trace, "done", {
    cacheStatus: request.force ? "refresh" : "miss",
    resultCount: metadata.columns.length,
    force: request.force === true,
  });
  return { metadata, cacheStatus: request.force ? "refresh" : "miss", ageMs: 0 };
}

export function invalidateTableMetadataCache(match: MetadataCacheInvalidation): number {
  tableMetadataInvalidationStamp++;
  // 同时甩掉在途登记：否则失效后启动的 non-force 调用会加入失效前的旧加载，
  // 且其失效代数取自失效之后，完成时会把旧结果重新写入缓存
  tableMetadataCoordinator.clear();
  return tableMetadataCache.invalidate(match);
}

export function clearTableMetadataCache(): void {
  tableMetadataInvalidationStamp++;
  tableMetadataCoordinator.clear();
  tableMetadataCache.clear();
}
