# ChanRec

An IRC **chan**nel **rec**order (and other miscellaneous stuff) bot, made using <a href="https://nodejs.org/">node.js</a> and the <a href="https://www.npmjs.com/package/irc/">node-irc</a> library.

## Features
- Logs most actions in channels
- Users can disable logging individual messages (`= message`) and their messages (`!enable`, `!disable`)
- OK counter and OK lock (sends the OK count each time someone says OK) (`!ok`, `!oklock`)
- Transcript splitting and editing (`!split`, `!edit`, `!clear`)
- `!message` command, stolen shamelessly from [RoboTop](https://robotop.xyz)
- Can generate messages from transcripts using a Markov chain. Why not?
- """Emergency moderation""" (`!rawsend`)
- Mineral Fish references (because this bot was made for the MineralFish libera.chat channel)

For a list of all commands, see the `/help/` page when running the bot.

## Usage

Each instance of ChanRec is only for logging one channel.

- Clone the repo, `npm install`
- Set some required environment variables (can be done in a .env file):
	- `CHANREC_NICK` - The bot's nickname.
	- `CHANREC_CHANNEL` - The channel the bot should join and log.
- Set some optional environment variables:
	- `CHANREC_PASSWORD` - Set a password for the bot to log into
		(with the username being `CHANREC_NICK`'s value).
	- `CHANREC_DEV` - Boolean to enable debug mode (for debugging).
	- `CHANREC_DEV_NICK` - Nickname to use when in debug mode.
	- `CHANREC_ADMINS` - An array of usernames that are considered "admins" -
		these users can edit transcripts, have some limitations removed
		and can use some admin commands like !leave and !rawsend.
		Additionally, all channel operators are considered admins.
	- `CHANREC_URL` - A URL to the bot's site (used for commands like !help).
		Should not have a trailing slash.
- `npm start`
- Send `!help` in the bot's channel or DMs in order to get a link to the site.

## Additional Scripts
- `npm run format` - Formats the source code.
- `npm run loop` - Runs `npm start` repeatedly, restarting the bot every few hours. Probably will only work on Windows.
- `npm run generateRegurg` - Generates the regurgitator (Markov chain) database. This will multiply the database's size by ~3x, if you haven't generated it yet.
- `npm run clearRegurg` - Clears the regurgitator database.
- `npm run mergeArchives` - Merges several JSON-based databases into one. The files to merge are hardcoded. You probably won't need this.
- `npm run convertJSON` - Converts an old JSON-based database into an SQLite-based database. You probably won't need this.