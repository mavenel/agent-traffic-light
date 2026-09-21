#!/usr/bin/env node
'use strict';

// Claude Code hook: reports this session's state to the PI Traffic Light
// GNOME extension by writing a small JSON file per session.
//
// Wired in ~/.claude/settings.json for SessionStart, UserPromptSubmit,
// PreToolUse, Notification, Stop and SessionEnd. Reads the hook's JSON
// payload from stdin (session_id, cwd, hook_event_name, ...).

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'pi-traffic-light', 'sessions');

const STATUS_BY_HOOK = {
    SessionStart: 'finished',
    UserPromptSubmit: 'running',
    PreToolUse: 'running',
    Stop: 'finished',
    SubagentStop: 'finished',
};

// The Notification hook fires for more than just "needs your permission"
// (e.g. idle nudges, other alerts). Only those are a real "waiting" state;
// treating every Notification as waiting made the dot flash red for
// sub-second, auto-approved permission checks.
const WAITING_MESSAGE_PATTERN = /permission|confirm|approve/i;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch (e) {
        return '';
    }
}

function main() {
    let event;
    try {
        event = JSON.parse(readStdin());
    } catch (e) {
        return;
    }

    const hook = event.hook_event_name || '';
    const sessionId = event.session_id;
    if (!sessionId)
        return;

    const filePath = path.join(STATE_DIR, `claude-${sessionId}.json`);

    if (hook === 'SessionEnd') {
        fs.rmSync(filePath, { force: true });
        return;
    }

    let status = STATUS_BY_HOOK[hook];
    if (hook === 'Notification') {
        if (!WAITING_MESSAGE_PATTERN.test(event.message || ''))
            return;
        status = 'waiting';
    }
    if (!status)
        return;

    const cwd = event.cwd || '';
    const label = path.basename(cwd.replace(/\/+$/, '')) || 'claude';

    fs.mkdirSync(STATE_DIR, { recursive: true });
    const data = {
        agent: 'claude',
        session: sessionId,
        label,
        status,
        ts: Date.now() / 1000,
        // sh -c "node ..." execs node directly instead of forking, so our
        // parent is the long-lived claude process itself, not a transient
        // shell. Lets the GNOME extension drop the dot if claude got killed
        // without a clean SessionEnd (e.g. the whole desktop session died).
        pid: process.ppid,
    };
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, filePath);
}

main();
