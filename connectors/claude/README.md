# Kificut connector for Claude

An [MCP](https://modelcontextprotocol.io) server that lets Claude edit in the Kificut app on the same computer. It is packed as an MCP Bundle (`.mcpb`) so it installs in Claude Desktop with one click, and the same server is registered with Claude Code by Settings > Claude > Connect Claude Code.

Users do not need anything from this folder: the bundle ships inside Kificut (Settings > Claude > Install in Claude Desktop) and with every release. See [Use Kificut from Claude](../../README.md#use-kificut-from-claude).

## How it works

`src/server.ts` lists the tools from `src/shared/ai-tools.ts` and passes each call to Kificut through `src/kificut-client.ts`. The client reads `connector.json` from Kificut's user data folder, starts Kificut when it is closed, and authenticates with the token in that file. [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#assistant-connector) has the details.

## Building

```sh
npm run build:connector
```

This writes `build/` (the unpacked bundle) and `dist/Kificut-<version>-claude.mcpb`. `npm run build` runs it too.

## Trying a local change in Claude Desktop

Double-click the new `.mcpb` in `dist/`, or point Claude Desktop at the unpacked server in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kificut-dev": {
      "command": "node",
      "args": ["/absolute/path/to/kificut/connectors/claude/build/server/index.js"]
    }
  }
}
```

Start Kificut with `npm run dev` first; development builds do not record a launch command, so the connector cannot open them for you. Set `KIFICUT_CONNECTOR_FILE` to use a `connector.json` somewhere other than the default user data folder.

## Testing

`kificut-client.test.ts` runs the client against a fake Kificut and is part of `npm test`.

## Trying a local change in Claude Code

```sh
claude mcp add kificut-dev node /absolute/path/to/kificut/connectors/claude/build/server/index.js
```
