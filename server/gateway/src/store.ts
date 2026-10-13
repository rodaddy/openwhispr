import { DatabaseSync } from "node:sqlite";

export type VoiceSession = Readonly<{
  id: string;
  owner: string;
  room: string;
  status: string;
  createdAt: number;
  expiresAt: number;
}>;
export type SessionRepository = Pick<SessionStore, "create" | "find" | "close" | "listExpiredOpen">;

export class SessionStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS voice_sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, room TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('open','closed')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
    );
  }

  create(session: VoiceSession): void {
    this.#db
      .prepare(
        "INSERT INTO voice_sessions(id, owner, room, status, created_at, expires_at) VALUES(?,?,?,?,?,?)"
      )
      .run(
        session.id,
        session.owner,
        session.room,
        session.status,
        session.createdAt,
        session.expiresAt
      );
  }

  find(id: string): VoiceSession | undefined {
    const row = this.#db
      .prepare(
        "SELECT id, owner, room, status, created_at AS createdAt, expires_at AS expiresAt FROM voice_sessions WHERE id=?"
      )
      .get(id);
    return row as VoiceSession | undefined;
  }

  close(id: string): void {
    this.#db.prepare("UPDATE voice_sessions SET status='closed' WHERE id=?").run(id);
  }

  listExpiredOpen(nowSeconds: number): VoiceSession[] {
    const rows = this.#db
      .prepare(
        "SELECT id, owner, room, status, created_at AS createdAt, expires_at AS expiresAt FROM voice_sessions WHERE status='open' AND expires_at<=? ORDER BY expires_at, id"
      )
      .all(nowSeconds);
    return rows as VoiceSession[];
  }

  closeDb(): void {
    this.#db.close();
  }
}
