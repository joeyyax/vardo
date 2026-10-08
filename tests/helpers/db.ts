// Shared drizzle fake. Mock the module once, then script results per test:
//
//   vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
//   import { dbMock } from "@/tests/helpers/db";
//   beforeEach(() => dbMock.reset());
//
//   dbMock.query.apps.findFirst.mockResolvedValue({ id: "a1" });
//   dbMock.insertReturns([{ id: "new" }]);
//   dbMock.updateReturns([{ id: "a1" }]);
//   expect(dbMock.updates[0].set).toEqual({ name: "x" });
import { vi, type Mock } from "vitest";

type Fn = Mock<(...args: unknown[]) => unknown>;
type Chain = {
  returning: Mock<() => Promise<unknown[]>>;
  onConflictDoNothing: Mock<() => Chain>;
  onConflictDoUpdate: Mock<() => Chain>;
  then: PromiseLike<unknown[]>["then"];
};
export type QueryTable = { findFirst: Fn; findMany: Fn };
export type Write = { table: unknown; values?: unknown; set?: unknown; where?: unknown };

function createDbMock() {
  const tables = new Map<string, QueryTable>();
  const inserts: Write[] = [];
  const updates: Write[] = [];
  const deletes: Write[] = [];
  let insertRows: unknown[] = [];
  let updateRows: unknown[] = [];
  let deleteRows: unknown[] = [];

  // Awaitable, and chainable through returning / onConflict*.
  const settle = (rows: () => unknown[]): Chain => {
    const chain: Chain = {
      returning: vi.fn(async () => rows()),
      onConflictDoNothing: vi.fn(() => chain),
      onConflictDoUpdate: vi.fn(() => chain),
      then: (resolve, reject) => Promise.resolve(rows()).then(resolve, reject),
    };
    return chain;
  };

  const query = new Proxy({} as Record<string, QueryTable>, {
    get(_, name: string) {
      let t = tables.get(name);
      if (!t) {
        t = { findFirst: vi.fn() as Fn, findMany: vi.fn().mockResolvedValue([]) as unknown as Fn };
        tables.set(name, t);
      }
      return t;
    },
  });

  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      inserts.push({ table, values });
      return settle(() => insertRows);
    }),
  }));
  const update = vi.fn((table: unknown) => ({
    set: vi.fn((set: unknown) => ({
      where: vi.fn((where: unknown) => {
        updates.push({ table, set, where });
        return settle(() => updateRows);
      }),
    })),
  }));
  const del = vi.fn((table: unknown) => ({
    where: vi.fn((where: unknown) => {
      deletes.push({ table, where });
      return settle(() => deleteRows);
    }),
  }));

  return {
    db: { query, insert, update, delete: del },
    query,
    insert,
    update,
    delete: del,
    inserts,
    updates,
    deletes,
    insertReturns: (rows: unknown[]) => void (insertRows = rows),
    updateReturns: (rows: unknown[]) => void (updateRows = rows),
    deleteReturns: (rows: unknown[]) => void (deleteRows = rows),
    reset() {
      for (const t of tables.values()) {
        t.findFirst.mockReset();
        t.findMany.mockReset().mockResolvedValue([]);
      }
      insert.mockClear();
      update.mockClear();
      del.mockClear();
      inserts.length = updates.length = deletes.length = 0;
      insertRows = updateRows = deleteRows = [];
    },
  };
}

export const dbMock = createDbMock();

/** Factory body for `vi.mock("@/lib/db", ...)`. */
export function dbModule() {
  return { db: dbMock.db };
}
