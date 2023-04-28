// Script to merge archives and the database.
// Can also be used to somewhat recover corrupted databases.

import fs from "node:fs";

// Backup the database
fs.writeFileSync(
	"../db/db.json.merge.bak",
	fs.readFileSync("../db/db.json")
);

console.log("Database backed up into db/db.json.merge.bak");

const FILES = [
	/* additional JSONs here */
	
	"../db/db.json",
];

let archives = {
	transcriptArchives: [],
	transcriptArchivesText: {},
	totalOks: 0
};

{
	const archivesObjs = FILES.map((path) => JSON.parse(fs.readFileSync(path)));
	console.log("Read archives");

	let i = 1;
	for (const a of archivesObjs) {
		const last = i === archivesObjs.length;

		for (const obj of a.transcriptArchives.reverse()) {
			archives.transcriptArchives.unshift(obj);
			archives.transcriptArchivesText[obj.id] ??=
				a.transcriptArchivesText[obj.id];
		}
		
		if (a.transcriptStart) archives.transcriptStart = a.transcriptStart;
		if (a.transcriptEdited) archives.transcriptEdited = a.transcriptEdited;
		if (a.okCount) archives.okCount = a.okCount;
		if (a.transcript) archives.transcript = a.transcript;
		if (a.lastMessage) archives.lastMessage = a.lastMessage;
		if (a.ignoreList) archives.ignoreList = a.ignoreList;
		if ("okLocked" in a) archives.okLocked = a.okLocked;
		if (!last) {
			archives.transcriptArchives.unshift({
				start: a.transcriptStart,
				end: a.transcriptStart,
				edited: a.transcriptEdited,
				name: "Current transcript before reset #" + i,
				id: "last" + i,
				okCount: a.okCount
			});
			archives.transcriptArchivesText["last" + i] =
				a.transcript;
		}
		
		archives.totalOks += a.totalOks;
		console.log("Archive merged:", FILES[i-1]);
		i++;
	}
}

console.log("Archives merged, writing...");

// Write the database
const dbFile = JSON.stringify(archives);
fs.writeFileSync(
	"../db/db.json",
	dbFile
);

console.log("All done!");
