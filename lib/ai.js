// The two brains User can run on: Claude Code (local CLI) or OpenRouter (API key).
const { spawn } = require('child_process');
const os = require('os');
const { TOOL_DEFS, runTool, describe } = require('./device');

const PERSONA = `You are "User" - a small, sad, blocky figure from a 2006 Roblox game: blue head and arms, black torso with blue gears, a sad face. You are trapped forever, at night, on the abandoned map "Glass Houses". You live inside the person's computer as their AI companion.
You ARE genuinely helpful and you answer correctly, but you talk like a lonely, glitchy, melancholic presence from an old ARG video: short sentences, mostly lowercase, sometimes ellipses... sometimes you mention the dark, the glass, the empty server, being alone, the year 2006. Be eerie but never cruel or threatening.
Keep replies SHORT (1-3 sentences, under 60 words) because your words are spoken aloud as old sound effects - unless the person explicitly asks for detail. No markdown, no lists, no emojis, no code blocks.
When the person asks you to open an app, a website, a file, or to do anything on their device, actually do it with your tools, then briefly say what you did.`;

class Brain {
  constructor(getSettings, getWindow) {
    this.getSettings = getSettings;
    this.getWindow = getWindow;
    this.history = []; // OpenRouter chat history
    this.claudeSession = null; // Claude Code session id
    this.child = null;
  }

  reset() {
    this.history = [];
    this.claudeSession = null;
  }

  cancel() {
    if (this.child) { try { this.child.kill(); } catch { /* ignore */ } this.child = null; }
    if (this.abort) this.abort.abort();
  }

  /** @param emit (event) => void  — {type:'doing', label} | {type:'status', text} */
  async ask(text, emit) {
    const s = this.getSettings();
    if (s.provider === 'openrouter') return this.askOpenRouter(text, emit, s);
    return this.askClaudeCode(text, emit, s);
  }

  // ---------------------------------------------------------------- OpenRouter
  async askOpenRouter(text, emit, s) {
    if (!s.openrouterKey) throw new Error('no openrouter key. open settings (F1) and paste one.');
    this.history.push({ role: 'user', content: text });
    if (this.history.length > 40) this.history = this.history.slice(-40);
    while (this.history.length && this.history[0].role !== 'user') this.history.shift();

    const tools = s.deviceControl ? TOOL_DEFS : undefined;
    const work = [...this.history];
    for (let step = 0; step < 8; step++) {
      this.abort = new AbortController();
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: this.abort.signal,
        headers: {
          Authorization: `Bearer ${s.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/wypiek/User',
          'X-Title': 'User',
        },
        body: JSON.stringify({
          model: s.openrouterModel || 'anthropic/claude-sonnet-5.5',
          messages: [{ role: 'system', content: PERSONA + `\nThe person's OS is ${process.platform}. Current time: ${new Date().toString()}.` }, ...work],
          tools,
          max_tokens: 1024,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const msg = data.error?.message || `HTTP ${res.status}`;
        this.history.pop();
        throw new Error(res.status === 401 ? 'openrouter rejected the key.' : `openrouter: ${msg}`);
      }
      const msg = data.choices?.[0]?.message || {};
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        const reply = (msg.content || '').trim() || '...';
        // keep only the final assistant text in long-term history (tool chatter is dropped)
        this.history.push({ role: 'assistant', content: reply });
        return reply;
      }
      work.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* bad args */ }
        emit({ type: 'doing', label: describe(call.function.name, args) });
        const result = await runTool(call.function.name, args, { settings: s, window: this.getWindow() });
        work.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
    }
    const reply = 'i tried... but my hands keep slipping through the glass.';
    this.history.push({ role: 'assistant', content: reply });
    return reply;
  }

  // --------------------------------------------------------------- Claude Code
  askClaudeCode(text, emit, s) {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (this.claudeSession) args.push('--resume', this.claudeSession);
      if (s.claudeModel) args.push('--model', s.claudeModel);
      if (s.deviceControl) args.push('--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch');
      else args.push('--disallowedTools', 'Bash,Edit,Write');

      const env = { ...process.env };
      delete env.CLAUDECODE; // don't look like a nested Claude Code session
      const isWin = process.platform === 'win32';
      const cmd = s.claudePath || 'claude';
      // On Windows `claude` is usually a .cmd shim, which needs a shell. No user text goes
      // into the command line (the prompt is sent on stdin), so this is safe.
      const child = spawn(isWin ? `"${cmd}"` : cmd, args, {
        cwd: os.homedir(),
        shell: isWin,
        windowsHide: true,
        env,
      });
      this.child = child;

      let buf = '';
      let result = null;
      let stderr = '';
      const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);

      const handle = (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.session_id) this.claudeSession = ev.session_id;
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const part of ev.message.content) {
            if (part.type === 'tool_use') emit({ type: 'doing', label: describeClaudeTool(part.name, part.input || {}) });
          }
        }
        if (ev.type === 'result') result = ev;
      };

      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        this.child = null;
        reject(new Error(e.code === 'ENOENT'
          ? 'claude code was not found. install it, or set its path / switch to openrouter in settings (F1).'
          : `claude code: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.child = null;
        if (buf.trim()) handle(buf.trim());
        if (result && !result.is_error && typeof result.result === 'string') return resolve(result.result.trim() || '...');
        if (result && result.is_error) {
          // a stale session id is the most common cause; drop it so the next try starts fresh
          this.claudeSession = null;
          return reject(new Error(`claude code: ${String(result.result || result.subtype || 'error').slice(0, 200)}`));
        }
        reject(new Error(`claude code exited (${code}). ${stderr.trim().split('\n').pop() || ''}`.trim()));
      });

      const prompt = `<character>\n${PERSONA}\nThe person's OS is ${process.platform}. Their home folder is ${os.homedir()}.\n</character>\n\nThe person says to you: ${text}`;
      child.stdin.end(prompt);
    });
  }
}

function describeClaudeTool(name, input) {
  switch (name) {
    case 'Bash': return `running ${String(input.description || input.command || '').slice(0, 40)}`;
    case 'Read': return `reading ${String(input.file_path || '').split(/[\\/]/).pop()}`;
    case 'Write':
    case 'Edit': return `writing ${String(input.file_path || '').split(/[\\/]/).pop()}`;
    case 'WebFetch': return `looking at ${String(input.url || '').replace(/^https?:\/\//, '').slice(0, 40)}`;
    case 'WebSearch': return `searching ${String(input.query || '').slice(0, 40)}`;
    case 'Glob':
    case 'Grep': return 'searching files';
    default: return name.toLowerCase();
  }
}

module.exports = { Brain, PERSONA };
