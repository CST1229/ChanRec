import db from "./sqlitedb.js";

console.log("Doing...");

const msgRegex = /^\[[\d:]+\] <[+@]?([a-zA-Z0-9{}\[\]_-]+?)> (.+)$/;

db.prepare(`BEGIN TRANSACTION;`).run();
db.exec(`
	DELETE FROM regurgitator;
	DELETE FROM regurgitatorTypes;
`);

const lines = db.prepare(
	`SELECT text FROM transcripts ORDER BY start ASC`
).pluck().all().join("\n").toLowerCase().split("\n");

const insert = db.prepare(`
	INSERT INTO regurgitator (current, next, type) VALUES (?, ?, ?)
`);
const insertUser = db.prepare(`
	INSERT INTO regurgitatorTypes (type) VALUES (?)
		ON CONFLICT DO UPDATE SET messages = messages + 1;
`);

for (const line of lines) {
	const match = line.match(msgRegex);
	if (!match) continue;
	
	const user = match[1];
	let current = "<START>";
	for (const word of match[2].split(" ")) {
		insert.run(current, word, user);
		current = word;
	}
	insert.run(current, "<END>", user);
	insertUser.run(user);
}
db.prepare(`END TRANSACTION;`).run();

console.log("Done");