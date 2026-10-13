import { DatabaseSync } from "node:sqlite";

export type Share = Readonly<{
  token: string;
  noteId: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ShareInput = Readonly<{
  token: string;
  noteId: string;
  title: string;
  markdown: string;
}>;

export type ShareRepository = Pick<
  ShareStore,
  "create" | "update" | "rotate" | "remove" | "findByToken"
>;

const now = (): string => new Date().toISOString();

export class ShareStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, note_id TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS shares_note_id ON shares(note_id)"
    );
  }

  /** One row per note_id: a second create for the same note replaces content and keeps the token. */
  create(input: ShareInput): Share {
    const existing = this.#findByNoteId(input.noteId);
    if (existing) {
      this.#db
        .prepare("UPDATE shares SET title=?, markdown=?, updated_at=? WHERE token=?")
        .run(input.title, input.markdown, now(), existing.token);
      return this.findByToken(existing.token)!;
    }
    const stamp = now();
    this.#db
      .prepare(
        "INSERT INTO shares(token, note_id, title, markdown, created_at, updated_at) VALUES(?,?,?,?,?,?)"
      )
      .run(input.token, input.noteId, input.title, input.markdown, stamp, stamp);
    return this.findByToken(input.token)!;
  }

  update(token: string, title: string, markdown: string): Share | undefined {
    const changes = this.#db
      .prepare("UPDATE shares SET title=?, markdown=?, updated_at=? WHERE token=?")
      .run(title, markdown, now(), token).changes;
    return changes ? this.findByToken(token) : undefined;
  }

  rotate(token: string, nextToken: string): Share | undefined {
    const changes = this.#db
      .prepare("UPDATE shares SET token=?, updated_at=? WHERE token=?")
      .run(nextToken, now(), token).changes;
    return changes ? this.findByToken(nextToken) : undefined;
  }

  remove(token: string): boolean {
    return this.#db.prepare("DELETE FROM shares WHERE token=?").run(token).changes > 0;
  }

  findByToken(token: string): Share | undefined {
    return this.#select("token", token);
  }

  #findByNoteId(noteId: string): Share | undefined {
    return this.#select("note_id", noteId);
  }

  #select(column: "token" | "note_id", value: string): Share | undefined {
    const row = this.#db
      .prepare(
        `SELECT token, note_id AS noteId, title, markdown, created_at AS createdAt, updated_at AS updatedAt FROM shares WHERE ${column}=?`
      )
      .get(value);
    return row as Share | undefined;
  }

  closeDb(): void {
    this.#db.close();
  }
}
