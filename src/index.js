(await import("dotenv")).config();

// This contains most of the bot's source code.
// I should split this into several files one day...

const ENV_VARS = ["CHANREC_CHANNEL", "CHANREC_NICK"];
const OPTIONAL_ENV_VARS = [
	"CHANREC_ADMINS",
	"CHANREC_PASSWORD",
	"CHANREC_DEV",
	"CHANREC_DEV_NICK",
	"CHANREC_URL",
	"CHANREC_REAL_NAME",
];

let URL = "https://localhost:7998";
if (process.env.REPL_OWNER && process.env.REPL_SLUG) {
	URL = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
}
if (process.env.CHANREC_URL) URL = process.env.CHANREC_URL;

for (const name of ENV_VARS) {
	if (!(name in process.env)) {
		throw new Error(`Environment variable not set: ${name}
(required variables: ${ENV_VARS.join(", ")})
(optionally, you can also set: ${OPTIONAL_ENV_VARS.join(", ")})`);
	}
}

const DEV = ["true", 1, true].includes(process.env.CHANREC_DEV) || false;
if (DEV) {
	console.log("=== Development mode ===");
}

// @todo eventually: rewrite chanrec using
// https://github.com/kiwiirc/irc-framework

const CHANNEL = process.env.CHANREC_CHANNEL;

import irc from "irc";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

import db, {getKey, setKey} from "./sqlitedb.js";

import doRegurgitator, {
	createMessage,
	types as regurgTypes,
} from "./regurgitator-server.js";
const hasGenerator = regurgTypes && regurgTypes.length;

if (process.env.CHANREC_AUTORESTART)
	setTimeout(async () => {
		throw new Error("Automatic restart");
	}, 4 * 60 * 60 * 1000);

import crypto from "crypto";

// Uncomment this to disable the bot
// return;

const IS_SASL = !!process.env.CHANREC_PASSWORD;

const firstNick = process.env.CHANREC_DEV_NICK
	? (DEV ? process.env.CHANREC_DEV_NICK : process.env.CHANREC_NICK) ||
	  "ChanRec"
	: process.env.CHANREC_NICK || "ChanRec";

const CHANREC_REAL_NAME =
	process.env.CHANREC_REAL_NAME ||
	"Instance of ChanRec, a channel recorder (and more) bot by CST1229";

const client = new irc.Client("irc.libera.chat", firstNick, {
	userName: IS_SASL ? process.env.CHANREC_NICK : firstNick,
	nick: firstNick,
	password: IS_SASL ? process.env.CHANREC_PASSWORD : undefined,
	realName: CHANREC_REAL_NAME + (DEV ? " (debug mode)" : ""),
	port: 6667,
	debug: DEV,
	showErrors: true,
	autoRejoin: false,
	autoConnect: true,
	channels: [],
	secure: false,
	selfSigned: false,
	certExpired: false,
	floodProtection: true,
	floodProtectionDelay: 300,
	sasl: IS_SASL,
	retryCount: 0,
	retryDelay: 2000,
	stripColors: false,
	channelPrefixes: "&#",
	messageSplit: 2048,
	encoding: "",
});

let joined = false;

let cmdRatelimit = 2000;
let cooldowns = {};

let editTokens = {};

const getCurrentTranscript = db.prepare(`
	SELECT * FROM transcripts WHERE current = 1;
`);

function addCurrentTranscript() {
	const start = Date.now();
	db.prepare(
		`INSERT INTO transcripts
			(id, name, text, start, current)
			VALUES (@id, 'Current transcript', '', @start, 1)`
	).run({
		id: start.toString(),
		start,
	});
}

let transcript, transcriptName, okCount, transcriptStart, transcriptEdited;
let transcriptDirty = false;
function refreshCurrentTranscript() {
	const currentTranscript = getCurrentTranscript.get();
	transcript = currentTranscript.text;
	transcriptName = currentTranscript.name;
	okCount = currentTranscript.okCount;
	transcriptStart = currentTranscript.start;
	transcriptEdited = !!currentTranscript.edited;
	transcriptDirty = false;
}

const updateCurrent = db.prepare(
	`UPDATE transcripts SET name = ?, text = ?, okCount = ? WHERE current = 1`
);
setInterval(() => {
	if (!transcriptDirty) return;
	updateCurrent.run(transcriptName, transcript, okCount);
	transcriptDirty = false;
}, 10000);

if (!getCurrentTranscript.get()) {
	addCurrentTranscript();
}
refreshCurrentTranscript();

let ignoreList = new Set(
	db
		.prepare(`SELECT * FROM ignoreList`)
		.all()
		.map(o => o.nick)
);

let names = {};

let totalOks = db
	.prepare(`SELECT total(okCount) FROM transcripts`)
	.pluck()
	.get();

let currentChannel = CHANNEL;

// let okLocked = !!getKey("okLocked");
let okLock = false;

const pingResponses = () => [
	"Pong!",
	"ooh",
	"I sure do exist",
	"!pong",
	"[object Object]",
	"Bump",
	"Amogus",
	"Ti-",
	"I really exist",
	`*blasts ${client.nick} klaxon*`,
	`*blows ${client.nick} whistle*`,
	`*blares ${client.nick} klaxon*`,
	`I live`,
	'When you realize that "chan" is somewhat of an an-',
	"*blares chanrec with a weird version of 0 to chanrec code*",
	"*explodes a zip into a cliff*",
	"brb gonna get some snipping scissors",
];

client.addListener("error", function (message) {
	console.error("[ERR!]", message.command, "|", message);
});

client.addListener("registered", function (message) {
	console.log("Connected!");
	client.join(CHANNEL);
	registerEvents();
	setInterval(() => {
		if (!joined) return;
		if (
			!Object.keys(client.chans).some(
				n => n.toLowerCase() === CHANNEL.toLowerCase()
			)
		) {
			throw "Disconnected from channel";
		}
	}, 1000);
});

const pfpCtcp =
	"PFP https://assets.scratch.mit.edu/1dde9e5d39d14f6b646090f0e0d69756.svg";

let time;
function calcTime() {
	time = `[${new Date().toLocaleTimeString("en-US", {
		timeZone: "UTC",
		hour12: false,
	})}]`;
}

client.addListener("topic", function (channel, topic, nick, message) {
	if (channel !== CHANNEL) return;
	calcTime();
	log(`${time} (i) Topic: ${topic}`);
});

function whois(user) {
	return new Promise(r => client.whois(user, r));
}

const crAdmins = process.env.CHANREC_ADMINS || [];
async function isAdmin(user, channel) {
	const isPM = !channel.startsWith("#");

	if (!isPM && names[channel][user].includes("@")) return true;
	const info = await whois(user);
	if (!info.host) return false;
	if (!info.account) return false;
	if (crAdmins.includes(info.account)) return true;
	return false;
}

function getUsernameRegexes(channel) {
	if (!names[channel]) {
		channel = CHANNEL;
	}
	let usernameRegexes = [];
	for (const un of Object.keys(names[channel])) {
		usernameRegexes.push(
			new RegExp(un.replaceAll(/[\[\]\{\}\\\`\^]/g, "\\$&"), "g")
		);
	}
	return usernameRegexes;
}

function registerEvents() {
	client.addListener("raw", function (msg) {
		if (msg.command === "NICK") {
			if (ignoreList.has(msg.nick) || ignoreList.has(msg.args[0])) return;

			calcTime();
			log(`${time} ~ ${msg.nick} is now known as ${msg.args[0]}`);
		}
	});

	client.addListener("ctcp", function (from, to, text, type, message) {
		if (!(text.toLowerCase() === "pfp")) return;
		client.ctcp(from, "notice", pfpCtcp);
	});

	client.addListener(
		"message",
		async function (sender, channel, _text, message) {
			const text = _text.toLowerCase();
			const isPM = !channel.startsWith("#");
			// Just to be safe
			channel = isPM ? sender : channel;

			if (!isPM && text.startsWith("=")) return;

			if (!isPM && text !== "!disable") {
				channelSwitch(channel);
				logSay(sender, _text);
			}

			if (!isPM && (sender === client.nick || sender.startsWith("Chan")))
				return;

			if (Date.now() < cooldowns[sender]) return;
			cooldowns[sender] = Date.now() + cmdRatelimit;

			if (text === "!ok") {
				say(channel, `OK count: ${okCount}`);
				return;
			}

			if (text === "!clear") {
				if (!(await isAdmin(sender, channel))) {
					say(channel, "Only admins can clear!");
					return;
				}
				say(
					channel,
					"Are you ABSOLUTELY SURE you want to clear all transcripts (including past splits)? If yes, run !clear yes."
				);
			}

			if (text.startsWith("!rawsend ")) {
				if (!(await isAdmin(sender, channel))) return;
				const raw = _text.substring(9);

				console.log("RAWSEND:", raw);
				if (!client.conn.requestedDisconnect) {
					client.conn.write(raw + "\r\n");
				}
				return;
			}

			if (!isPM && (text === "!edit" || text.startsWith("!edit "))) {
				if (!DEV && !(await isAdmin(sender, channel))) {
					say(
						channel,
						`${sender}: You must be a channel operator to edit transcripts!`,
						sender
					);
					return;
				}

				const transcriptId = _text.substring(6) || "";

				const o =
					transcriptId === ""
						? getCurrentTranscript.get()
						: getTranscript.get(transcriptId);

				if (!o) {
					say(
						sender,
						`The transcript with ID ${transcriptId} doesn't exist!`
					);
					return;
				}

				const token = crypto.randomBytes(64).toString("base64url");

				const url = `${URL}/edit?token=${token}`;

				editTokens[token] = {
					transcriptId,
				};

				setTimeout(() => {
					delete editTokens[token];
				}, 10 * 60 * 1000);

				if (transcriptId === "") {
					say(
						sender,
						`One-time link to edit the current transcript: ${url}`
					);
				} else {
					say(
						sender,
						`One-time link to edit the transcript "${
							o.name
						}" (started at ${new Date(
							o.start
						).toLocaleString("en-US", {
							timeZone: "UTC",
							hour12: false,
						})}): ${url}`
					);
				}
				say(
					sender,
					"Do not share this with anyone! The link will expire in 10 minutes."
				);
			}

			if (!isPM && text === "!clear yes") {
				if (!(await isAdmin(sender, channel))) return;
				// say(sender, "This command has been disabled.");
				clearTranscript(channel);
				return;
			}

			if (text === "!regain") {
				const regainOnline = Object.keys(names[channel]).map(v =>
					v.toLowerCase()
				);
				const regainLowerNick = firstNick.toLowerCase();
				if (client.nick === firstNick) {
					say(
						channel,
						`${sender}: I already have the nickname ${firstNick} lol.`,
						sender
					);
					return;
				}
				if (IS_SASL) {
					client.send("NS", "regain");
					return;
				}
				if (regainOnline.includes(regainLowerNick)) {
					say(
						channel,
						`${sender}: A user with the name ${firstNick} is already online! Try using !leave on it if you're a channel operator.`,
						sender
					);
				}
				client.send("NICK", firstNick);
				return;
			}

			if (
				!isPM &&
				(text === "!split" || text.startsWith("!split ")) &&
				!text.includes("ticket")
			) {
				const splitText = _text.substring(7);

				if (
					transcriptStart + (DEV ? 10000 : 1000 * 60 * 60 * 2) >
						Date.now() &&
					!(await isAdmin(sender, channel))
				) {
					say(
						channel,
						`${sender}: You can only split transcripts every ${
							DEV ? "10 seconds" : "2 hours"
						}!`,
						sender
					);
					return;
				}

				if (splitText.length > 50) {
					say(
						channel,
						`${sender}: Split names can only be at most 50 characters!`,
						sender
					);
					return;
				}

				db.prepare(`BEGIN TRANSACTION`).run();

				db.prepare(
					`UPDATE transcripts SET
					current = 0,
					end = ?,
					name = ?
				WHERE current = 1`
				).run(Date.now(), splitText || transcriptName);

				addCurrentTranscript();
				refreshCurrentTranscript();

				db.prepare(`END TRANSACTION`).run();

				say(channel, "✅ Successfully split transcript.", null);
			}

			if (text === "!help") {
				doHelp(channel);
			}

			if (text === "!enable") {
				ignoreList.delete(sender);
				db.prepare(`DELETE FROM ignoreList WHERE nick = ?`).run(sender);
				say(
					sender,
					`✅ Removed you (${sender}) from the ignore list. Your messages will now be logged.`
				);
			}
			if (text === "!disable") {
				ignoreList.add(sender);
				db.prepare(
					`INSERT OR IGNORE INTO ignoreList (nick) VALUES (?)`
				).run(sender);
				say(
					sender,
					`✅ Added you (${sender}) to the ignore list. Your messages will no longer be logged.`
				);
			}
			if (text === "!enabled") {
				if (ignoreList.has(sender)) {
					say(
						sender,
						`You are in the ignore list. Your messages are not logged.`
					);
				} else {
					say(
						sender,
						`You are not in the ignore list. Your messages are logged.`
					);
				}
			}

			// if (!isPM && text === "!oklock") {
			if (false) {
				okLocked = !okLocked;
				setKey("okLocked", +okLocked);
				if (okLocked) {
					say(channel, `✅ OK lock enabled`);
				} else {
					say(channel, `✅ OK lock disabled`);
				}
			}

			if (text === "!ping") {
				const resps = pingResponses();
				say(
					channel,
					`${resps[Math.floor(Math.random() * resps.length)]}`
				);
			}

			if (text === "!message" || text.startsWith("!message ")) {
				let lastMsg = getKey("lastMessage");
				for (const r of getUsernameRegexes(channel)) {
					lastMsg = lastMsg.replaceAll(r, "99,99$&");
				}
				setKey("lastMessage", _text.substring(9));
				say(CHANNEL, `Message: "${lastMsg}"`, null);
			}

			if (text === "!generate" || text.startsWith("!generate ")) {
				if (!hasGenerator) {
					say(
						channel,
						`${sender}: The generator database hasn't been generated yet.`,
						sender
					);
					return;
				}
				const user = _text.substring(10).toLowerCase();
				if (!user) {
					say(
						channel,
						`${sender}: You must input a user to generate a message!`,
						sender
					);
					return;
				}

				const message = createMessage(user);
				if (message === null) {
					say(
						channel,
						`Could not generate message. Does the user exist?`,
						sender
					);
					return;
				}
				say(channel, `Generated: ${message}`, sender);
			}

			if (text === "!repeat" || text.startsWith("!repeat ")) {
				let lineLimit;
				if (await isAdmin(sender, channel)) {
					lineLimit = 20;
				} else {
					lineLimit = 10;
				}

				const repeatSyntax = `[start][- to count from the end, _ to count from the start][end], start and end can be omitted to use the transcript's start/end. For example: 5-2, 2_4, _2, 5-`;

				const repeatText = _text.substring(8);
				if (!repeatText) {
					say(
						channel,
						`${sender}: Repeat syntax: ${repeatSyntax}`,
						sender
					);
					return;
				}
				const parts = repeatText.match(/^(\d*)(-|_)(\d*)$/);
				if (!parts) {
					say(
						channel,
						`${sender}: Incorrect repeat syntax! The syntax: ${repeatSyntax}`,
						sender
					);
					return;
				}

				parts.shift();

				const lines = transcript.split("\n");

				let start, end;
				if (parts[0] === "") {
					start = 0;
				} else {
					start = Number(parts[0]) - 1;
				}
				if (parts[2] === "") {
					end = lines.length - 1;
				} else {
					end = Number(parts[2]) - 1;
				}

				if (parts[1] === "-") {
					if (parts[0] === "") {
						start = lines.length - 2;
					}
					if (parts[2] === "") {
						end = 0;
					}
					start = lines.length - start - 2;
					end = lines.length - end - 2;
				}
				if (
					start < 0 ||
					start >= lines.length ||
					end < 0 ||
					end >= lines.length
				) {
					say(
						channel,
						`${sender}: The lines to repeat must be in the transcript!`,
						sender
					);
					return;
				}
				if (start > end) {
					say(
						channel,
						`${sender}: The start must be before the end!`,
						sender
					);
					return;
				}
				if (end - start > lineLimit - 1) {
					say(
						channel,
						`${sender}: Repeated sections cannot be longer than ${lineLimit} lines!`,
						sender
					);
					return;
				}

				const range = lines.filter((v, i) => i >= start && i <= end);

				const usernameRegexes = getUsernameRegexes(channel);

				if (await isAdmin(sender, channel)) {
					cooldowns[sender] = Date.now() + 3 * 1000;
				} else {
					cooldowns[sender] = Date.now() + 10 * 1000;
				}
				for (let m of range) {
					for (const r of usernameRegexes) {
						m = m.replaceAll(r, "99,99$&");
					}
					say(channel, m, null);
				}
			}

			if (
				text.startsWith("!leave ") ||
				text === "!leave" ||
				text.startsWith("!bootleg ") ||
				text === "!bootleg"
			) {
				if (!(await isAdmin(sender, channel))) {
					say(
						channel,
						`${sender}: Only operators can shut the bot down!`,
						sender
					);
					return;
				}
				const leaveParam = text.split(" ")[1] || "";
				if (
					leaveParam === "" ||
					client.nick.toLowerCase() === leaveParam
				) {
					client.disconnect("Manual shutdown");
					throw "Manual shutdown";
				}
			}

			if (text.startsWith("!say ")) {
				// Operators only
				if (!(await isAdmin(sender, channel))) return;

				const sayText = _text.substring(5);
				say(channel, sayText, null);
				return;
			}

			if (!isPM && /\bok\b/i.test(text)) {
				okCount++;
				totalOks++;
				setKey("okCount", okCount);
				// if (okLocked) {
				if (false) {
					if (
						text.includes("ticket") &&
						sender.toLowerCase().includes("pkmnq")
					) {
						say(channel, `${sender}: no`, null);
						return;
					}
					if (text.startsWith("!message ")) return;
					say(channel, `OK count: ${okCount}`, null);
					return;
				}
			}
			doTicket(text, channel, sender);
		}
	);
	client.addListener("notice#", function (sender, channel, text, message) {
		if (ignoreList.has(sender)) return;
		channelSwitch(channel);

		logSay(sender, "[NOTICE] " + text);
	});

	client.addListener("join", function (channel, sender, message) {
		if (sender === client.nick) joined = true;
		if (ignoreList.has(sender)) return;
		channelSwitch(channel);

		calcTime();
		log(`${time} -> ${pnick(sender)} joined the channel`);
		// client.ctcp(sender, "privmsg", pfpCtcp);
	});

	client.addListener("part", function (channel, sender, reason, message) {
		if (ignoreList.has(sender)) return;
		channelSwitch(channel);

		calcTime();
		log(
			`${time} <- ${pnick(sender)} left the channel${
				reason === undefined ? "" : " (" + reason + ")"
			}`
		);
	});
	client.addListener("quit", function (sender, reason, channels, message) {
		if (sender === client.nick) throw new Error("Quit: " + reason);
		if (ignoreList.has(sender)) return;

		calcTime();
		log(
			`${time} <- ${pnick(sender)} left${
				reason === undefined ? "" : " (" + reason + ")"
			}`
		);
	});

	client.addListener(
		"kick",
		function (channel, nick, sender, reason, message) {
			if (ignoreList.has(sender)) return;
			channelSwitch(channel);

			calcTime();
			log(
				`${time} <<- ${pnick(sender)} kicked ${pnick(
					nick
				)} from ${channel}${
					reason === undefined ? "" : " (" + reason + ")"
				}`
			);
		}
	);

	client.addListener("nick", function (oldnick, newnick, channels, message) {
		if (!channels.includes(CHANNEL)) return;
		if (ignoreList.has(oldnick) || ignoreList.has(newnick)) return;

		calcTime();
		log(`${time} " ${oldnick} is now known as ${pnick(newnick)}`);
	});

	client.addListener("action", function (sender, channel, text, message) {
		if (ignoreList.has(sender)) return;
		channelSwitch(channel);

		calcTime();
		log(`${time} * ${pnick(sender)} ${text}`);
		doTicket(text, channel, sender);
	});

	client.addListener("names", function (channel, nicks) {
		names[channel] = nicks;
	});

	client.addListener(
		"+mode",
		function (channel, sender, mode, argument, message) {
			if (ignoreList.has(sender)) return;
			channelSwitch(channel);

			calcTime();
			switch (mode) {
				case "k":
					log(
						`${time} + ${pnick(
							sender
						)} sets a password on ${channel}`
					);
					break;
				case "v":
					log(
						`${time} + ${pnick(sender)} gives voice to ${argument}`
					);
					break;
				case "o":
					log(`${time} + ${pnick(sender)} gives ops to ${argument}`);
					break;
				case "m":
					log(
						`${time} + ${pnick(
							sender
						)} enables moderated chat on ${channel}`
					);
					break;
				case "b":
					log(
						`${time} <<<- ${pnick(sender)} banned ${pnick(
							argument
						)} from ${channel}`
					);
					break;
				default:
					log(
						`${time} + ${pnick(sender)} sets +${mode} on ${
							argument || channel
						}`
					);
					break;
			}
		}
	);
	client.addListener(
		"-mode",
		function (channel, sender, mode, argument, message) {
			if (channel !== CHANNEL) return;
			if (ignoreList.has(sender)) return;

			calcTime();
			switch (mode) {
				case "k":
					log(
						`${time} - ${pnick(
							sender
						)} removes the password on ${channel}`
					);
					break;
				case "v":
					log(
						`${time} - ${pnick(
							sender
						)} takes voice from ${argument}`
					);
					break;
				case "o":
					log(
						`${time} - ${pnick(sender)} takes ops from ${argument}`
					);
					break;
				case "m":
					log(
						`${time} - ${pnick(
							sender
						)} disables moderated chat on ${channel}`
					);
					break;
				case "b":
					log(
						`${time} ->>> ${pnick(sender)} unbanned ${pnick(
							argument
						)} from ${channel}`
					);
					break;
				default:
					log(
						`${time} - ${pnick(sender)} sets -${mode} on ${
							argument || channel
						}`
					);
					break;
			}
		}
	);
}

function log(msg) {
	transcript += msg + "\n";
	transcriptDirty = true;
	if (DEV) {
		console.log(msg);
	}
}

function pnick(nick) {
	if (names[currentChannel]) {
		if (names[currentChannel][nick]) {
			return names[currentChannel][nick] + nick;
		}
	}
	return nick;
}

function say(channel, text, nick = "", doIgnore = false) {
	if (text === "") return;
	if (doIgnore && ignoreList.has(nick)) return;
	client.say(channel, text);
	if (!channel.startsWith("#")) return;
	if (nick === "") return;
	logSay(client.nick, text);
}

function doTicket(_text, channel, nick) {
	setTimeout(() => {
		const text = _text.toLowerCase();
		const lowerNick = client.nick.toLowerCase();

		const nickCall = channel === nick ? "" : `${nick}: `;

		if (text.includes("ticket")) {
			say(
				channel,
				`${nickCall}Copper Fish is a n g e r y right now`,
				nick,
				true
			);
			return;
		}
		if (
			text.startsWith("who's " + lowerNick) ||
			text.startsWith("who is " + lowerNick) ||
			(channel === nick && text === "who are you")
		) {
			say(channel, `${nickCall}I'm a bot`, nick, true);
		}
	}, 250);
}

function logSay(nick, text) {
	if (ignoreList.has(nick)) return;
	calcTime();
	log(`${time} <${pnick(nick)}> ${text}`);
}

function filterHTML(txt) {
	if (!txt) {
		return "";
	}

	let parsedValue = txt;
	parsedValue = parsedValue.replaceAll("&", "&amp;");
	parsedValue = parsedValue.replaceAll("<", "&lt;");
	parsedValue = parsedValue.replaceAll(">", "&gt;");
	parsedValue = parsedValue.replaceAll('"', "&quot;");
	parsedValue = parsedValue.replaceAll("'", "&apos;");
	return parsedValue;
}

function channelSwitch(channel) {
	if (channel != currentChannel) {
		currentChannel = channel;
		log(`[${channel}]`);
	}
}

function clearTranscript(channel) {
	db.prepare(`BEGIN TRANSACTION`).run();
	db.prepare(`DELETE FROM transcripts WHERE TRUE`).run();
	addCurrentTranscript();
	refreshCurrentTranscript();
	db.prepare(`END TRANSACTION`).run();
	say(channel, "✅ Transcript cleared.", null);
}

function doHelp(sender) {
	say(
		sender,
		`View the transcript at ${URL}, and the command list at ${URL}/help`
	);
}

function getSize(bytes) {
	let val = bytes;
	let unit = "";
	if (bytes < 1000) {
		unit = " bytes";
	} else if (bytes < 1000000) {
		val /= 1000;
		unit = "KB";
	} else {
		val /= 1000000;
		unit = "MB";
	}
	return `${Math.round(val * 100) / 100}${unit}`;
}

///// SERVER /////

const app = express();
const appPort = 7998;

app.use(express.urlencoded({extended: true, limit: "100mb"}));
app.use(express.text({limit: "100mb"}));
app.use(express.static(path.resolve("./src/static/")));

const generatorLink = hasGenerator
	? `<a href="/generator">Generator</a> -`
	: "";
const wrapSite = function (html, title = null) {
	return (
		`<!DOCTYPE html>
	<html>
		<head>
			<link rel="stylesheet" href="/assets/style.css" />
			<title>${title ? title + " - ChanRec" : "ChanRec"}</title>
		</head>
		<body>
		<h1>${title ? title : "ChanRec"}</h1>
		<div id="navbar">
			<a href="/">Home</a> -
			<a href="/help">Commands</a> -
			${generatorLink}
			<a href="/transcripts">Transcripts</a>
			<form id="search" action="/search" method="get">
				<input type="search" placeholder="Search" name="q">
				<button>Go!</button>
			</form>
		</div>
` +
		html +
		`</body>
	</html>`
	);
};

const editedWm =
	'<span class="transcript-edited">(this transcript was edited)</span>';

function filterTranscript(transcript) {
	return filterHTML(transcript)
		.split("\n")
		.map(
			(v, i) =>
				`<div id="line-${(
					i + 1
				).toString()}" class="transcript-line">${v}<a href="#line-${(
					i + 1
				).toString()}" class="line-number">${(
					i + 1
				).toString()}</a></div>`
		)
		.join("");
}

function transcriptHTML(o, hasText = true) {
	const start = new Date(o.start).toLocaleString("en-US", {
		timeZone: "UTC",
		hour12: false,
	});
	let end;
	if (o.end)
		end = new Date(o.end).toLocaleString("en-US", {
			timeZone: "UTC",
			hour12: false,
		});

	return `
	<h2>${filterHTML(o.name)}</h2>
	<b>Started at:</b> ${start}<br />
	${end ? `<b>Ended at:</b> ${end}<br />` : ""}
	<b>ID:</b> ${filterHTML(o.id)}<br />
	<b>OK count:</b> ${o.okCount.toString()}<br />
	<b>Size:</b> ${getSize(o.text.length)}
	${o.edited ? "<br />" + editedWm : ""}<br /><br />
	<button 
		onclick="navigator.clipboard.writeText(document.getElementById('transcript').textContent);"
	>
		Copy Transcript
	</button>
	<button 
		onclick="navigator.clipboard.writeText('[code]\\n'+document.getElementById('transcript').textContent+'[/code]');"
	>
		Copy BBCode
	</button>
	${
		hasText
			? `<br /><pre><code id="transcript">${
					o.lost
						? "This transcript was lost."
						: filterTranscript(o.text)
			  }</code></pre>`
			: ""
	}
	`;
}

app.get("/", (req, res) => {
	res.status(200).send(
		wrapSite(`
	<b>Total OK count:</b> ${totalOks.toString()}<br />
	<b>Current channel:</b> ${CHANNEL}<br />
	<b>Current name:</b> ${client.nick || "Not connected yet"}<br />
	
	${transcriptHTML({
		name: transcriptName,
		id: transcriptStart.toString(),
		text: transcript,
		start: transcriptStart,
		edited: transcriptEdited,
		okCount,
		lost: 0,
	})}`)
	);
});

app.get("/transcripts", async (req, res) => {
	let html = "";
	const archives = db
		.prepare(
			`SELECT id, name, start, lost
			FROM transcripts WHERE current = 0
			ORDER BY start DESC`
		)
		.all();

	if (archives.length === 0) {
		html += `No archived transcripts yet. Use <code>!split</code> to move the current transcript here.`;
	} else {
		html += `<ul>`;
		for (const o of archives) {
			const start = new Date(o.start).toLocaleString("en-US", {
				timeZone: "UTC",
				hour12: false,
			});

			html += `<li>
				${o.lost ? "<del>" : ""}<a href="/transcripts/${filterHTML(o.id)}">${filterHTML(
				o.name
			)}</a> (${start})${o.lost ? "</del>" : ""}
			</li>`;
		}
		html += `</ul>`;
	}

	res.status(200).send(wrapSite(`${html}`, "Transcripts"));
});

const getTranscript = db.prepare(`SELECT * FROM transcripts WHERE id = ?`);

app.get("/transcripts/:id/", async (req, res) => {
	const idToFind = req.params.id;

	if (!idToFind) {
		res.status(200).send(
			wrapSite(`This transcript doesn't exist!`, "View Transcript")
		);
		return;
	}

	const o = getTranscript.get(idToFind);

	if (!o) {
		res.status(200).send(
			wrapSite(
				`This transcript (id ${filterHTML(idToFind)}) doesn't exist.`,
				"View Transcript"
			)
		);
		return;
	}

	res.status(200).send(wrapSite(`${transcriptHTML(o)}`, "View Transcript"));
});

app.get("/help", (req, res) => {
	res.status(200).send(
		wrapSite(
			`<h2>Logging</h2>
	<ul>
		<li><code>!enable</code> - Allow your messages to be logged.</li>
		<li><code>!disable</code> - Prevent your messages from being logged.</li>
		<li><code>!enabled</code> - Check if the bot logs your messages or not.</li>
		<li><code>!split</code> - Splits the transcript and moves it into <a href="/transcripts">the archives</a>.</li>
		<li><code>!repeat (lines)</code> - Repeats some part of the current transcript. Has a somewhat complex syntax; for more details run <code>!repeat</code>.</li>
		<li><code>= (message)</code> - Not really a command. Prevents this message from being responded to or logged by ChanRec, even if you are not in the ignore list.</li>
	</ul>
	<h2>Fun</h2>
	<ul>
		<li><code>!message (text)</code> - Says the previous !message.</li>
		<li><code>!ok</code> - Get the number of times someone said OK. Also viewable through the transcript page.</li>
		<!-- <li><code>!oklock</code> - Toggles OK lock (sends OK count when someone says OK). Only works in channels.</li> -->
		<li><code>!generate (user)</code> - Generates a nonexistent message from a user. See also the <a href="generator">Message Generator</a>.</li>
	</ul>
	<h2>Operator Only</h2>
	<ul>
		<li><code>!say</code> - Makes the bot say something. Only works in channels.</li>
		<li><code>!leave</code> - Stops the bot.</li>
		<li><code>!rawsend</code> - Makes the bot send a raw IRC message to the server.</li>
		<li><code>!edit (optional: id)</code> - Sends a link in DMs to edit a transcript.</li>
		<li><code>!clear</code> - Clears the transcript and transcript archives.</li>
	</ul>
	<h2>Other</h2>
	<ul>
		<li><code>!regain</code> - Runs <code>/ns REGAIN</code>, making the bot regain its nickname (e.g ChanRec1 -> ChanRec).</li>
		<li><code>!help</code> (or <code>HELP</code> in DMs) - Send the links to the transcript and this page.</li>
	</ul>`,
			"Commands"
		)
	);
});

app.get("/edit", async (req, res) => {
	let token = req.query.token;

	if (!editTokens[token]) {
		res.status(200).send(
			wrapSite(
				`You aren't allowed to edit this transcript!`,
				"Edit Transcript"
			)
		);
		return;
	}

	let isCurrentTranscript = editTokens[token].transcriptId === "";
	const o = isCurrentTranscript
		? getCurrentTranscript.get()
		: getTranscript.get(editTokens[token].transcriptId);
	isCurrentTranscript = !!o.current;

	if (!o) {
		res.status(200).send(
			wrapSite(`This transcript doesn't exist.`, "Edit Transcript")
		);
		return;
	}

	const transcriptText = isCurrentTranscript ? transcript : o.text;
	const name = isCurrentTranscript ? transcriptName : o.name;
	const ok = isCurrentTranscript ? okCount : o.okCount;

	res.status(200).send(
		wrapSite(
			`<link rel="stylesheet" href="/assets/editts.css" />
		<form action="/edit" method="post">
			<b>Name:</b> <input type="text" name="transcriptname" value="${filterHTML(
				name
			).replaceAll('"', '\\"')}"><br />
			<b>Started at:</b> ${new Date(o.start).toLocaleString("en-US", {
				timeZone: "UTC",
				hour12: false,
			})}<br />
			${
				isCurrentTranscript
					? ""
					: `<b>Ended at:</b> ${new Date(o.end).toLocaleString(
							"en-US",
							{timeZone: "UTC", hour12: false}
					  )}<br />`
			}
			<b>OK count:</b> ${ok.toString()}
			${o.edited ? "<br />" + editedWm : ""}<br /><br />
			<input type="hidden" name="edittoken" value="${filterHTML(token)}">
			<div><button onclick='{
				event.preventDefault();
				event.stopPropagation();
				
				const t = document.getElementById("edit-textarea");
				
				const lines = t.value.split("\\n");
				const newLines = [];
				let lastLine, deduped = false;
				for (const line of lines) {
					if (lastLine !== line || deduped) {
						newLines.push(line);
						if (lastLine !== line) deduped = false;
					} else {
						deduped = true;
					}
					lastLine = line;
				}
				
				t.value = newLines.join("\\n");
			}'>Deduplicate</button></div>
			<textarea name="transcript" id="edit-textarea">${filterHTML(
				transcriptText
			)}</textarea><br />
			${
				isCurrentTranscript
					? `<input type="hidden" name="delete" value="">`
					: `
				<div>
					<input type="checkbox" id="delete" name="delete">
					<label class="redtext" for="delete">Clear this transcript (permanent!!)</label>			
				</div><br />
			`
			}
			<button>Submit</button>
		</form>`,
			"Edit Transcript"
		)
	);
});
app.post("/edit", async (req, res) => {
	if (req.body.transcript === undefined) {
		res.status(401).end(
			wrapSite(
				`You need to specify something to edit the transcript to!`,
				"Edit Transcript"
			)
		);
		return;
	}

	const token = req.body.edittoken;
	const text = req.body.transcript;
	const name = req.body.transcriptname;

	if (!editTokens[token]) {
		res.status(401).end(
			wrapSite(
				`You aren't allowed to edit this transcript!`,
				"Edit Transcript"
			)
		);
		return;
	}

	let isCurrentTranscript = editTokens[token].transcriptId === "";
	const o = isCurrentTranscript
		? getCurrentTranscript.get()
		: getTranscript.get(editTokens[token].transcriptId);
	isCurrentTranscript = !!o.current;

	if (!o) {
		res.status(404).end(
			wrapSite(`This transcript doesn't exist!`, "Edit Transcript")
		);
		return;
	}

	if (req.body.delete) {
		if (isCurrentTranscript) {
			res.status(400).end(wrapSite(`whar`, "whar"));
			return;
		}

		db.prepare(`DELETE FROM transcripts WHERE id = ?`).run(o.id);

		delete editTokens[token];
		res.status(200).end(wrapSite(`Transcript deleted.`, "Edit Transcript"));
		return;
	}

	delete editTokens[token];

	db.prepare(
		`UPDATE transcripts
			SET name = @name, text = @text, edited = 0, lost = 0
			WHERE id = @id`
	).run({
		...o,
		text,
		name,
	});

	if (isCurrentTranscript) {
		refreshCurrentTranscript();
	}

	res.status(200).send(
		wrapSite(`Transcript edited successfully.`, "Edit Transcript")
	);
});
app.get("/search", async (req, res) => {
	// this is a really inefficient way to do it but eh
	const archives = db.prepare(`SELECT * FROM transcripts`).all();

	let q = req.query?.q?.toLowerCase() ?? "";

	let results = [];
	for (const o of archives) {
		const occurrences =
			o.name.toLowerCase().split(q).length -
			1 +
			(o.text || "").toLowerCase().split(q).length -
			1;
		if (occurrences > 0) {
			results.push(Object.assign(o, {occurrences}));
		}
	}

	const sort = function (arr) {
		const newArr = [{occurrences: Infinity}];
		for (const item of arr) {
			for (const i in newArr) {
				const item2 = newArr[i];
				if (item.occurrences <= item2.occurrences) {
					newArr.splice(i, 0, item);
					break;
				}
			}
		}
		newArr.pop();
		return newArr.reverse();
	};
	results = sort(results);

	let html = "";
	const l = results.length;
	const resultsText = `(${l.toString()} result${l === 1 ? "" : "s"})`;

	html += `<h2>${filterHTML(req.query.q)} ${resultsText}</h2>`;
	if (results.length === 0) {
		html += `<p>No results found.</p>`;
	} else {
		html += `<ul>`;
		for (const o of results) {
			const occurrences = `${o.occurrences.toString()} occurrence${
				o.occurrences === 1 ? "" : "s"
			}`;
			if (!o.current) {
				const start = new Date(o.start).toLocaleString("en-US", {
					timeZone: "UTC",
					hour12: false,
				});
				const id = o.id.toString();
				html += `<li>
					<a href="/transcripts/${filterHTML(id)}">${filterHTML(
					o.name
				)}</a> (${start}; ${occurrences})
				</li>`;
			} else {
				const start = new Date(transcriptStart).toLocaleString(
					"en-US",
					{timeZone: "UTC", hour12: false}
				);
				html += `<li>
					<a href="/">${transcriptName}</a> (current transcript) (${start}; ${occurrences})
				</li>`;
			}
		}
		html += `</ul>`;
	}

	res.status(200).send(wrapSite(html, "Search Results"));
});
app.get("/db", async (req, res) => {
	res.status(400).send(
		wrapSite(
			`This endpoint no longer exists; use <a href="/db-sqlite">/db-sqlite</a> instead.`,
			"Error"
		)
	);
});
app.get("/db-sqlite", async (req, res) => {
	try {
		res.status(200).send(await fs.readFile("./db/database.sqlite"));
	} catch(e) {
		res.status(500).send("error!!!");
	}
});

doRegurgitator(wrapSite, app, filterHTML);

app.get("/ping", (req, res) => {
	res.status(200).send(`Pong!`);
});

app.listen(appPort, () => {
	console.log("Website up");
});
