import db from "./sqlitedb.js";

db.prepare(`BEGIN TRANSACTION;`).run(); 
db.exec(`
	DELETE FROM regurgitator;
	DELETE FROM regurgitatorTypes;
`);
db.prepare(`END TRANSACTION;`).run();

console.log("Done");