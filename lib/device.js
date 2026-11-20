// Device-control tools User can use when powered by OpenRouter.
// (When powered by Claude Code, Claude Code's own tools are used instead.)
const { shell, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const os = require('os');

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open / launch an application installed on the user\'s computer, by its name (e.g. "Spotify", "Notepad", "Calculator", "firefox").',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Application name' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a web page in the user\'s default browser. Also use for searches, e.g. https://www.google.com/search?q=...',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_path',
      description: 'Open a file or folder on the user\'s computer with its default program. "~" means the home folder.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: `Run a shell command on the user's computer and get its output. OS: ${process.platform} (${os.release()}). Shell: ${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}. Use for controlling the device (volume, files, system info, closing apps, etc).`,
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
];

function describe(name, args) {
  switch (name) {
    case 'open_app': return `opening ${args.name}`;
    case 'open_url': return `opening ${String(args.url).replace(/^https?:\/\//, '').slice(0, 40)}`;
    case 'open_path': return `opening ${args.path}`;
    case 'run_command': return `running ${String(args.command).slice(0, 40)}`;
    default: return name;
  }
}

function expandHome(p) {
  return String(p || '').replace(/^~(?=$|[\\/])/, os.homedir());
}

function launchApp(name) {
  return new Promise((resolve) => {
    let child;
    if (process.platform === 'win32') {
      // `start` resolves App Paths registrations (spotify, chrome, notepad, ...)
      const safe = name.replace(/["&|<>^%]/g, '');
      child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" "${safe}""`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', ['-a', name], { detached: true, stdio: 'ignore' });
    } else {
      const bin = name.toLowerCase().replace(/\s+/g, '-');
      child = spawn(bin, [], { detached: true, stdio: 'ignore' });
      child.on('error', () => {
        const g = spawn('gtk-launch', [bin], { detached: true, stdio: 'ignore' });
        g.on('error', () => resolve(`could not find an app called "${name}"`));
        g.on('exit', (c) => resolve(c === 0 ? `opened ${name}` : `could not find an app called "${name}"`));
      });
    }
    child.on('exit', (code) => {
      if (process.platform !== 'linux') resolve(code === 0 ? `opened ${name}` : `could not open "${name}" (exit ${code})`);
    });
    child.on('spawn', () => {
      child.unref();
      if (process.platform === 'linux') setTimeout(() => resolve(`opened ${name}`), 400);
    });
    if (process.platform !== 'linux') child.on('error', (e) => resolve(`could not open "${name}": ${e.message}`));
  });
}

async function runTool(name, args, ctx) {
  const settings = ctx.settings;
  if (!settings.deviceControl) return 'Device control is disabled in settings. Tell the user they can enable it.';
  try {
    switch (name) {
      case 'open_app':
        return await launchApp(String(args.name || ''));
      case 'open_url': {
        let url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        await shell.openExternal(url);
        return `opened ${url}`;
      }
      case 'open_path': {
        const err = await shell.openPath(expandHome(args.path));
        return err ? `error: ${err}` : `opened ${args.path}`;
      }
      case 'run_command': {
        const command = String(args.command || '');
        if (settings.confirmCommands) {
          const { response } = await dialog.showMessageBox(ctx.window, {
            type: 'warning',
            buttons: ['Allow', 'Deny'],
            defaultId: 1,
            cancelId: 1,
            title: 'User wants to run a command',
            message: 'User wants to run this command on your computer:',
            detail: command,
          });
          if (response !== 0) return 'The user denied running this command.';
        }
        return await new Promise((resolve) => {
          exec(command, { timeout: 30000, maxBuffer: 1024 * 1024, cwd: os.homedir(), windowsHide: true }, (err, stdout, stderr) => {
            let out = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
            if (err && !out.trim()) out = `error: ${err.message}`;
            resolve(out.trim().slice(0, 4000) || '(no output)');
          });
        });
      }
      default:
        return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${e.message}`;
  }
}

module.exports = { TOOL_DEFS, runTool, describe };
