import Database from "better-sqlite3";
import fs from "node:fs/promises";

try {
	await fs.mkdir("db");
} catch (e) {}

const db = new Database("./db/database.sqlite", {});
db.pragma("journal_mode = WAL");
process.on("exit", () => db.close());

function init() {
	db.exec(`
		BEGIN TRANSACTION;
		CREATE TABLE IF NOT EXISTS transcripts (
			id TEXT PRIMARY KEY,
			name TEXT,
			text TEXT,
			okCount INTEGER DEFAULT 0,
			edited INTEGER DEFAULT 0,
			start INTEGER DEFAULT 0,
			end INTEGER DEFAULT 0,
			current INTEGER DEFAULT 0,
			lost INTEGER DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS ignoreList (
			nick TEXT PRIMARY KEY
		);
		CREATE TABLE IF NOT EXISTS keys (
			key TEXT PRIMARY KEY,
			value ANY
		);
		
		CREATE TABLE IF NOT EXISTS regurgitator (
			current TEXT,
			next TEXT,
			type TEXT
		);
		CREATE TABLE IF NOT EXISTS regurgitatorTypes (
			type TEXT PRIMARY KEY,
			messages INTEGER DEFAULT 1
		);
		CREATE INDEX IF NOT EXISTS typeIndex ON regurgitator (type);
		
		INSERT OR IGNORE INTO keys 
			(key, value)
			VALUES ('lastMessage', 'This is the first !message!');
		INSERT OR IGNORE INTO keys 
			(key, value)
			VALUES ('okLocked', 0);
	`);
	try {
		db.prepare(
			`ALTER TABLE regurgitatorTypes
				ADD COLUMN messages INTEGER DEFAULT 1;`
		).run();
	} catch (e) {}
	db.prepare(`END TRANSACTION;`).run();
}

init();

const _getKey = db.prepare(`SELECT value FROM keys WHERE key = ?`).pluck();
const _setKey = db.prepare(`UPDATE keys SET value = ? WHERE key = ?`);

// Simply exporting statement.get will throw an error when calling it
export const getKey = k => _getKey.get(k);
// Reverse parameters because ?2 and ?1 won't work for some reason
export const setKey = (k, v) => _setKey.run(v, k);

export default db;
