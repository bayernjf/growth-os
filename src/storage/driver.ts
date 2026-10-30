/**
 * Storage driver port. The dialect boundary lives here: business code only
 * ever sees SQL with `?` placeholders and ANSI-shaped CRUD. Each driver
 * translates placeholders/connection details for its database.
 */
/**
 * Statements allowed inside a transaction. SELECTs are included so a
 * multi-statement unit of work can read its own writes on one connection.
 */
export interface StorageTxn {
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
}

export interface StorageDriver extends StorageTxn {
  readonly dialect: 'sqlite' | 'postgres';
  /** Raw multi-statement execution (migrations only). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` in one transaction: commit when it returns, roll back when it
   * throws. Nested transactions are not supported.
   */
  transaction<T>(fn: (tx: StorageTxn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
