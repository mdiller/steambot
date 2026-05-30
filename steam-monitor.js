const SteamUser = require("steam-user");
const axios = require("axios");
const mqtt = require("mqtt");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

const MEMORY_PATH = path.join("data", "memory.json");

function loadMemory() {
	try {
		return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
	} catch {
		return {};
	}
}

function saveMemory(data) {
	fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
	fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2), "utf8");
}

// ── MQTT ─────────────────────────────────────────

const DEVICE = {
	identifiers: ["steam_monitor"],
	name: "Steam Monitor",
	manufacturer: "dillerm",
	model: "steambot",
};

const DISCOVERIES = [
	{
		type: "sensor",
		id: "persona_state",
		cfg: {
			name: "Steam Status",
			unique_id: "steam_persona_state",
			state_topic: "steam/persona_state",
			availability_topic: "steam/availability",
			icon: "mdi:steam",
			device_class: "enum",
			options: ["Online", "Offline", "Away", "Busy", "Snooze", "Looking to Trade", "Looking to Play"],
			device: DEVICE,
		},
	},
	{
		type: "binary_sensor",
		id: "in_game",
		cfg: {
			name: "In Game",
			unique_id: "steam_in_game",
			state_topic: "steam/in_game",
			availability_topic: "steam/availability",
			icon: "mdi:gamepad-variant",
			device_class: "running",
			device: DEVICE,
		},
	},
	{
		type: "sensor",
		id: "game_name",
		cfg: {
			name: "Current Game",
			unique_id: "steam_game_name",
			state_topic: "steam/game/name",
			availability_topic: "steam/availability",
			icon: "mdi:controller",
			device: DEVICE,
		},
	},
	{
		type: "sensor",
		id: "game_appid",
		cfg: {
			name: "Game App ID",
			unique_id: "steam_game_appid",
			state_topic: "steam/game/appid",
			availability_topic: "steam/availability",
			icon: "mdi:identifier",
			entity_category: "diagnostic",
			device: DEVICE,
		},
	},
	{
		type: "sensor",
		id: "rich_presence",
		cfg: {
			name: "Rich Presence",
			unique_id: "steam_rich_presence",
			state_topic: "steam/game/rich_presence",
			availability_topic: "steam/availability",
			icon: "mdi:information-outline",
			device: DEVICE,
		},
	},
];

let mqttClient = null;

function mqttPublish(topic, payload) {
	if (!mqttClient?.connected) return;
	mqttClient.publish(topic, String(payload), { retain: true });
}

function connectMqtt() {
	mqttClient = mqtt.connect(`mqtt://${config.MQTT_HOST}:${config.MQTT_PORT}`, {
		username: config.MQTT_USERNAME,
		password: config.MQTT_PASSWORD,
		will: {
			topic: "steam/availability",
			payload: "offline",
			retain: true,
		},
	});

	mqttClient.on("connect", () => {
		console.log(`[${timestamp()}] 📡 MQTT connected to ${config.MQTT_HOST}:${config.MQTT_PORT}`);

		for (const { type, id, cfg } of DISCOVERIES) {
			mqttClient.publish(`homeassistant/${type}/steam/${id}/config`, JSON.stringify(cfg), { retain: true });
		}

		mqttClient.publish("steam/availability", "online", { retain: true });
	});

	mqttClient.on("error", (err) => {
		console.error(`[${timestamp()}] ❌ MQTT error:`, err.message);
	});

	mqttClient.on("disconnect", () => {
		console.warn(`[${timestamp()}] ⚠️  MQTT disconnected`);
	});
}

// ── Steam client ──────────────────────────────────

const client = new SteamUser();

let lastLocalizedString = null;
let lastGameName = null;
let lastPersonaState = null;
let pollTimer = null;

// ── Helpers ──────────────────────────────────────

function timestamp() {
	return new Date().toLocaleTimeString();
}

async function getPlayerSummary() {
	try {
		const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/`
			+ `?key=${config.webApiKey}&steamids=${config.targetSteamID}`;
		const res = await axios.get(url);
		const players = res.data?.response?.players;
		if (!players || players.length === 0) return null;
		return players[0];
	} catch (err) {
		console.error(`[${timestamp()}] ❌ Web API error:`, err.message);
		return null;
	}
}

const PERSONA_STATES = {
	0: "Offline",
	1: "Online",
	2: "Busy",
	3: "Away",
	4: "Snooze",
	5: "Looking to Trade",
	6: "Looking to Play",
};

async function poll() {
	const summary = await getPlayerSummary();
	if (!summary) return;

	const personaState = PERSONA_STATES[summary.personastate] ?? `State ${summary.personastate}`;
	const gameName = summary.gameextrainfo ?? null;
	const appId = summary.gameid ?? null;

	if (personaState !== lastPersonaState) {
		console.log(`[${timestamp()}] 👤 Status changed: ${lastPersonaState ?? "?"} → ${personaState}`);
		lastPersonaState = personaState;
		mqttPublish("steam/persona_state", personaState);
	}

	if (gameName !== lastGameName) {
		if (gameName) {
			console.log(`[${timestamp()}] 🎮 Now playing: ${gameName} (AppID: ${appId})`);
			mqttPublish("steam/in_game", "ON");
			mqttPublish("steam/game/name", gameName);
			mqttPublish("steam/game/appid", appId);
		} else {
			console.log(`[${timestamp()}] ⏹️  Stopped playing`);
			lastLocalizedString = null;
			mqttPublish("steam/in_game", "OFF");
			mqttPublish("steam/game/name", "");
			mqttPublish("steam/game/appid", "");
			mqttPublish("steam/game/rich_presence", "");
		}
		lastGameName = gameName;
	}

}

// ── Steam login ───────────────────────────────────

const memory = loadMemory();
console.log(`[startup] memory.json refreshToken present: ${!!memory.refreshToken}`);

const logOnOptions = memory.refreshToken
	? (() => { console.log(`[startup] logging in with saved refreshToken`); return { refreshToken: memory.refreshToken }; })()
	: (() => { console.log(`[startup] no saved refreshToken — logging in with password`); return { accountName: config.botUsername, password: config.botPassword }; })();

client.logOn(logOnOptions);

client.on("steamGuard", (domain, callback, lastCodeWrong) => {
	console.log(`[startup] Steam Guard requested — domain: ${domain ?? "mobile authenticator"}, lastCodeWrong: ${lastCodeWrong}`);
	process.stdout.write("Steam Guard code: ");
	process.stdin.once("data", (data) => callback(data.toString().trim()));
});

client.on("refreshToken", (token) => {
	console.log(`[startup] saving refreshToken to memory.json`);
	saveMemory({ ...loadMemory(), refreshToken: token });
});

client.on("loggedOn", () => {
	console.log(`[${timestamp()}] ✅ Bot logged in as ${config.botUsername}`);
	console.log(`[${timestamp()}] 👀 Monitoring SteamID: ${config.targetSteamID}`);
	console.log(`[${timestamp()}] 🔄 Polling every ${config.pollIntervalMs / 1000}s`);

	client.setPersona(SteamUser.EPersonaState.Online);

	connectMqtt();

	poll();
	pollTimer = setInterval(poll, config.pollIntervalMs);
});

client.on("user", (sid, persona) => {
	if (sid.getSteamID64() !== config.targetSteamID) return;

	const rpString = persona.rich_presence_string || null;
	const rawRP = persona.rich_presence ?? {};
	const validLocalized = rpString && rpString !== "Unknown" ? rpString : null;
	const displayStr = validLocalized ?? rawRP.status ?? (Object.keys(rawRP).length > 0 ? JSON.stringify(rawRP) : null);

	if (displayStr && displayStr !== lastLocalizedString) {
		console.log(`[${timestamp()}] 🟢 Rich Presence: ${lastGameName} — ${displayStr}`);
		lastLocalizedString = displayStr;
		mqttPublish("steam/game/rich_presence", displayStr);
	}
});

client.on("error", (err) => {
	console.error(`[${timestamp()}] ❌ Steam error:`, err.message, JSON.stringify(err, Object.getOwnPropertyNames(err)));
	if (pollTimer) clearInterval(pollTimer);
	if (err.eresult === 5 || err.eresult === 65) {
		const m = loadMemory();
		delete m.refreshToken;
		saveMemory(m);
		console.log(`[${timestamp()}] 🗑️  Cleared stale refreshToken, will re-authenticate next run`);
	}
});

client.on("disconnected", (eresult, msg) => {
	console.warn(`[${timestamp()}] ⚠️  Disconnected: ${msg}`);
	if (pollTimer) clearInterval(pollTimer);
});

// ── Graceful shutdown ─────────────────────────────

process.on("SIGINT", () => {
	console.log(`[${timestamp()}] 👋 Shutting down...`);
	if (pollTimer) clearInterval(pollTimer);
	if (mqttClient?.connected) {
		mqttClient.publish("steam/availability", "offline", { retain: true }, () => {
			mqttClient.end();
			client.logOff();
			process.exit(0);
		});
	} else {
		client.logOff();
		process.exit(0);
	}
});
