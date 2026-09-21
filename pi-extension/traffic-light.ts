/**
 * PI Traffic Light Extension
 *
 * Reports this session's activity to the PI Traffic Light GNOME extension
 * by writing a small JSON file per session under
 * ~/.local/state/pi-traffic-light/sessions/. The GNOME extension polls that
 * directory and shows one colored dot per active session in the top bar.
 *
 * Pi has no generic "waiting for user confirmation" lifecycle event, but its
 * built-in `ask_question` tool (and any custom tool named similarly) blocks
 * the agent run on user input, so it's treated as "waiting" for as long as
 * that tool call is in flight.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATE_DIR = path.join(os.homedir(), ".local", "state", "pi-traffic-light", "sessions");

type Status = "running" | "waiting" | "finished";

function sessionKey(ctx: any): string {
	return ctx.sessionManager?.getSessionId?.() ?? String(process.pid);
}

function sessionLabel(ctx: any): string {
	const cwd: string = ctx.cwd ?? process.cwd();
	return path.basename(cwd.replace(/\/+$/, "")) || "pi";
}

function writeState(ctx: any, status: Status) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const key = sessionKey(ctx);
	const filePath = path.join(STATE_DIR, `pi-${key}.json`);
	const data = {
		agent: "pi",
		session: key,
		label: sessionLabel(ctx),
		status,
		ts: Date.now() / 1000,
		pid: process.pid,
	};
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(data));
	fs.renameSync(tmpPath, filePath);
}

function clearState(ctx: any) {
	fs.rmSync(path.join(STATE_DIR, `pi-${sessionKey(ctx)}.json`), { force: true });
}

const WAITING_TOOL_PATTERN = /ask|question|confirm/i;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		writeState(ctx, "finished");
	});

	pi.on("agent_start", async (_event, ctx) => {
		writeState(ctx, "running");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		writeState(ctx, "finished");
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (WAITING_TOOL_PATTERN.test(event.toolName))
			writeState(ctx, "waiting");
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (WAITING_TOOL_PATTERN.test(event.toolName))
			writeState(ctx, "running");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearState(ctx);
	});
}
