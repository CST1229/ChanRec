import db from "./sqlitedb.js";

const _getWords = db
	.prepare(`SELECT next FROM regurgitator WHERE current = ? AND type = ?`)
	.pluck();

function pickRandom(arr) {
	return arr[Math.floor(Math.random() * arr.length)];
}

function getWord(current, user) {
	return pickRandom(_getWords.all(current, user));
}

export function createMessage(user) {
	const words = [];
	let current = "<START>";
	while (true) {
		current = getWord(current, user);
		if (current === undefined || current === null) {
			return null;
		}
		if (current === "<END>") {
			break;
		}
		words.push(current);
		if (current.length > 200) break;
	}
	return `<${user}> ` + words.join(" ");
}

export const types = db
	.prepare(`SELECT type FROM regurgitatorTypes ORDER BY type ASC;`)
	.pluck()
	.all();

const regurgitatorHTML = (currentType = "chanrec", messages = 1) => `
	<form action="" method="post">
		<div>
			<label for="type">Username:</label>
			<select name="type" id="type">
				${types.map(
					t =>
						`<option ${
							t === currentType ? "selected" : ""
						} value="${t}">${t}</option>`
				)}
			</select>
		</div>
		<div>
			<label for="num">Number of messages:</label>
			<input name="num" id="num" type="number" min="1" max="100" step="1" value="${messages}"></input>
		</div>
		<div><button>Generate</button></div>
	</form>
`;

export default function doServer(wrapSite, app, filterHTML) {
	app.get("/generator", (req, res) => {
		if (types && types.length) {
			res.status(200).send(
				wrapSite(
					`
				${regurgitatorHTML()}
			`,
					"Message Generator"
				)
			);
		} else {
			res.status(200).send(
				wrapSite(
					`
				The generator hasn't been generated yet (<code>npm run generateRegurg</code>).
			`,
					"Message Generator"
				)
			);
		}
	});
	app.post("/generator", (req, res) => {
		const type = req?.body?.type || "";
		const _num = Math.floor(+req?.body?.num || 1);
		const num = Math.min(100, Math.max(1, _num));

		let generated = "";
		let i = num;
		while (i >= 1) {
			generated += createMessage(type) || "(Could not generate message.)";
			generated += "\n";
			i--;
		}
		generated = generated.trim();

		res.status(200).send(
			wrapSite(
				`
			${regurgitatorHTML(type, num)}
			<pre><code>${filterHTML(generated)}</code></pre>
		`,
				"Message Generator"
			)
		);
	});
}
