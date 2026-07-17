import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarDataOpenRuntime } from "@/composables/useSidebarDataOpenRuntime";
import type { QueryTab, TreeNode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  databaseType: "oceanbase" as string,
  callOrder: [] as string[],
  tabs: [] as QueryTab[],
  ensureConnected: vi.fn(),
  executeTabSql: vi.fn(),
  loadTableMetadata: vi.fn(),
  setErrorResult: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => ({ id: "connection-1", db_type: mocks.databaseType }),
    ensureConnected: mocks.ensureConnected,
    connectionIdentifierQuote: () => undefined,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    tabs: mocks.tabs,
    createTab: (connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string) => {
      const tab = {
        id: "tab-1",
        connectionId,
        database,
        title,
        mode,
        schema,
        sql: "",
        isDirty: false,
        isExecuting: false,
        isCancelling: false,
        isExplaining: false,
      } as QueryTab;
      mocks.tabs.push(tab);
      return tab.id;
    },
    switchTab: vi.fn(),
    cancelTabExecution: vi.fn(),
    setExecutingWithId: (id: string, executionId: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) {
        tab.isExecuting = true;
        tab.executionId = executionId;
      }
    },
    setTableMeta: (id: string, tableMeta: NonNullable<QueryTab["tableMeta"]>) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) tab.tableMeta = tableMeta;
    },
    updateSql: (id: string, sql: string) => {
      const tab = mocks.tabs.find((item) => item.id === id);
      if (tab) tab.sql = sql;
    },
    executeTabSql: mocks.executeTabSql,
    setErrorResult: mocks.setErrorResult,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { reuseDataTab: false, pageSize: 100 } }),
}));

vi.mock("@/lib/database/jdbcDialect", () => ({
  effectiveDatabaseTypeForConnection: () => mocks.databaseType,
  connectionObjectTreeNodeSchema: (_config: unknown, _database: string, schema?: string) => schema,
  connectionObjectTreeQuerySchema: (_config: unknown, _database: string, schema?: string) => schema ?? "",
}));

vi.mock("@/lib/metadata/tableMetadataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata/tableMetadataCache")>();
  return {
    ...actual,
    getCachedTableMetadata: () => undefined,
    loadTableMetadata: mocks.loadTableMetadata,
  };
});

vi.mock("@/lib/common/utils", () => ({ uuid: () => "open-data-id" }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/lib/sidebar/dataTabOpenPolicy", () => ({
  findExistingDataTabCandidate: () => undefined,
  canApplyDataTabMetadata: () => true,
}));
vi.mock("@/lib/sidebar/treeNodeContext", () => ({ hasTreeNodeDatabaseContext: () => true }));
vi.mock("@/lib/table/tableSelectSql", () => ({ buildTableSelectSql: async () => "SELECT * FROM users" }));
vi.mock("@/lib/table/tableEditing", () => ({ usesSyntheticRowIdKey: () => false }));
vi.mock("@/lib/table/tableOpenPageLimit", () => ({ tableOpenPageLimit: () => 100 }));
vi.mock("@/lib/tabs/dataTabActivation", () => ({ canActivateExistingDataTableTab: () => false }));

const tableNode: TreeNode = {
  id: "table-users",
  label: "users",
  type: "table",
  connectionId: "connection-1",
  database: "app",
  schema: "public",
  tableType: "TABLE",
};

describe("useSidebarDataOpenRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.databaseType = "oceanbase";
    mocks.callOrder.length = 0;
    mocks.tabs.length = 0;
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeTabSql.mockImplementation(async () => {
      mocks.callOrder.push("query");
    });
    mocks.loadTableMetadata.mockImplementation(async () => {
      mocks.callOrder.push("metadata");
      return {
        metadata: {
          schema: "public",
          tableName: "users",
          tableType: "TABLE",
          database: "app",
          columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
          indexes: [],
          primaryKeys: ["id"],
          cachedAt: Date.now(),
        },
        cacheStatus: "miss",
        ageMs: 0,
      };
    });
  });

  it("starts cold-cache OceanBase metadata before the table query", async () => {
    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => {
      expect(mocks.callOrder).toEqual(["metadata", "query"]);
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    });
  });

  it("keeps Dameng metadata deferred until after the table query", async () => {
    mocks.databaseType = "dameng";

    await useSidebarDataOpenRuntime().openData(tableNode);

    await vi.waitFor(() => {
      expect(mocks.callOrder).toEqual(["query", "metadata"]);
      expect(mocks.tabs[0]?.tableMeta?.primaryKeys).toEqual(["id"]);
    });
  });
});
