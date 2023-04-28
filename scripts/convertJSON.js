import db, {setKey} from "../sqlitedb.js";
import fs from "node:fs";

const json = JSON.parse(fs.readFileSync("./db/db.json"));

db.prepare("BEGIN TRANSACTION").run();

// Set keys
setKey("lastMessage", json.lastMessage);
setKey("okLocked", json.lastMessage);

// Migrate ignore list
const addUser = db.prepare(`
	INSERT INTO ignoreList (nick) VALUES (?)
`);
json.ignoreList.forEach(addUser.run);

// Migrate transcripts
const addTranscript = db.prepare(`
	INSERT INTO transcripts
		(id, name, text, okCount, edited, start, end, current, lost)
		VALUES (@id, @name, @text, @okCount, @edited, @start, @end, @current, @lost)
`);
for (const transcript of json.transcriptArchives) {
	const text = json.transcriptArchivesText[transcript.id];
	addTranscript.run({
		...transcript,
		edited: +transcript.edited,
		text: text ?? "This transcript was lost.",
		current: 0,
		lost: +(text === null || text === undefined)
	});
}
// Also the current transcript too
addTranscript.run({
	id: json.transcriptStart.toString(),
	name: "Current transcript",
	text: json.transcript,
	okCount: json.okCount,
	edited: +json.transcriptEdited,
	start: json.transcriptStart,
	end: 0,
	current: 1,
	lost: 0,
});

db.prepare("END TRANSACTION").run();