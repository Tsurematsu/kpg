#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { KPG_VERSION } from './version.js';

const cliArgs = process.argv.slice(2);
if (cliArgs.includes('--version') || cliArgs.includes('-v') || cliArgs.includes('-V')) {
  process.stdout.write(`kpg v${KPG_VERSION}\n`);
  process.exit(0);
}
if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  process.stdout.write(
    [
      `kpg v${KPG_VERSION} — CloudNativePG TUI Manager`,
      '',
      'Uso:',
      '  kpg              Inicia la interfaz interactiva de terminal',
      '  kpg --version    Muestra la versión instalada y sale',
      '  kpg --help       Muestra esta ayuda',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[2J\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';

function enterAltScreen() {
  if (process.stdout.isTTY) {
    process.stdout.write(ENTER_ALT_SCREEN);
  }
}

function exitAltScreen() {
  if (process.stdout.isTTY) {
    process.stdout.write(EXIT_ALT_SCREEN);
  }
}

enterAltScreen();

const instance = render(<App />, {
  exitOnCtrlC: true,
});

process.on('SIGINT', () => {
  exitAltScreen();
  process.exit(0);
});

process.on('SIGTERM', () => {
  exitAltScreen();
  process.exit(0);
});

instance.waitUntilExit().then(() => {
  exitAltScreen();
  process.exit(0);
});
