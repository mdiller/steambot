# steambot

A Steam account monitor that polls the Steam Web API and rich presence for a target user and logs status/game changes to the console.

## Running

```
npm start
```

## Config

Fill in `config.json` at the repo root before running:

| Key | Description |
|---|---|
| `botUsername` | Steam account username for the bot |
| `botPassword` | Steam account password for the bot |
| `targetSteamID` | SteamID64 of the account to monitor (find at steamid.io) |
| `webApiKey` | Steam Web API key (steamcommunity.com/dev/apikey) |
| `pollIntervalMs` | How often to poll for changes, in milliseconds |

`config.json` is not committed — keep secrets out of git.

## Entry point

`steam-monitor.js` — logs in the bot account, polls `GetPlayerSummaries` on an interval, and fetches rich presence data when the target is in a game.
