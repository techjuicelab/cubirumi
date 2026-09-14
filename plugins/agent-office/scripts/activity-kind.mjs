/** Local, bounded classification only. No input text, path or command is returned or retained. */
export const ACTIVITY_KINDS = Object.freeze(['coding', 'documents', 'research', 'testing', 'reviewing', 'planning', 'design', 'delivery', 'shipping', 'general']);
export const isActivityKind = value => typeof value === 'string' && ACTIVITY_KINDS.includes(value);
const LIMIT = 128 * 1024;
const DOC = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'doc', 'docx', 'pdf', 'csv', 'tsv', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf']);
const CODE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'swift', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'zsh', 'bash', 'sql', 'vue', 'svelte', 'html', 'css', 'scss', 'sass', 'json', 'yaml', 'yml', 'toml', 'xml', 'ipynb']);
const DESIGN = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'blend', 'fig', 'sketch']);
const combine = kinds => {
  const unique = new Set(kinds);
  return unique.size === 1 ? [...unique][0] : 'general';
};

function pathKind(path) {
  if (typeof path !== 'string' || path.length > 4096) return 'general';
  const name = path.split(/[\\/]/u).at(-1).toLowerCase();
  const extension = name.split('.').at(-1);
  if (DOC.has(extension)) return 'documents';
  if (DESIGN.has(extension)) return 'design';
  if (CODE.has(extension) || ['dockerfile', 'makefile', 'cmakelists.txt'].includes(name)) return 'coding';
  return 'general';
}

function patchKind(patch) {
  if (typeof patch !== 'string' || patch.length > LIMIT) return 'general';
  // Only patch headers identify the edited files; prose/code inside added lines is irrelevant.
  const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map(match => match[1]);
  return combine(paths.map(pathKind));
}

// A deliberately small shell lexer. It never expands variables, substitutions, or shell scripts.
function commandKind(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > LIMIT || /[`$<>\n\r]/u.test(command)) return 'general';
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|]|[^\s;|]+/gu) ?? [];
  const groups = [[]];
  for (const token of tokens) {
    if (['&&', '||', ';', '|'].includes(token)) groups.push([]);
    else groups.at(-1).push(token.replace(/^(['"])(.*)\1$/u, '$2'));
  }
  const kinds = [];
  for (let tokens of groups) {
    tokens = tokens.filter((word, index) => !(index === 0 && /^[A-Za-z_][A-Za-z0-9_]*=[^=]*$/u.test(word)));
    const [program, ...args] = tokens;
    if (!program) return 'general';
    const executable = program.split('/').at(-1);
    if (executable === 'cd' && args.length === 1) continue;
    let kind = 'general';
    if (['rg', 'grep', 'find', 'fd', 'ls'].includes(executable)) kind = 'research';
    else if (['cat', 'head', 'tail', 'sed', 'less'].includes(executable)) kind = 'reviewing';
    else if (['pytest', 'vitest', 'jest', 'tsc', 'xcodebuild'].includes(executable)) kind = 'testing';
    else if (executable === 'node' && args.includes('--test')) kind = 'testing';
    else if (['python', 'python3'].includes(executable) && args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) kind = 'testing';
    else if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
      const script = args[0] === 'run' ? args[1] : args[0];
      if (/^(?:test|build|check|lint|typecheck)(?:$|[:_-])/u.test(script ?? '')) kind = 'testing';
      else if (/^(?:deploy|publish|release)(?:$|[:_-])/u.test(script ?? '')) kind = 'shipping';
    } else if (['cargo', 'go', 'swift', 'make', 'cmake', 'dotnet'].includes(executable) && ['test', 'build', 'check', '--build'].includes(args[0])) kind = 'testing';
    else if (executable === 'git') {
      if (['diff', 'show', 'log', 'status'].includes(args[0])) kind = 'reviewing';
      else if (['push', 'commit'].includes(args[0])) kind = 'shipping';
    } else if (executable === 'gh' && args[0] === 'pr' && ['view', 'diff', 'checks', 'review'].includes(args[1])) kind = 'reviewing';
    else if (['vercel', 'netlify'].includes(executable) && args[0] === 'deploy') kind = 'shipping';
    kinds.push(kind);
  }
  return combine(kinds);
}

/** Lex literal wrapper arguments without eval/Function/VM or resolving variables. */
function wrapperTokens(source) {
  if (typeof source !== 'string' || source.length > LIMIT) return [];
  const tokens = [];
  for (let i = 0; i < source.length && tokens.length < 20000;) {
    const char = source[i];
    if (/\s/u.test(char)) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) return []; i = end + 2; continue; }
    if (["'", '"', '`'].includes(char)) {
      let value = '', valid = true, ended = false; i++;
      for (; i < source.length; i++) {
        if (source[i] === char) { i++; ended = true; break; }
        if (char === '`' && source.startsWith('${', i)) return [];
        if (source[i] !== '\\') { value += source[i]; continue; }
        const next = source[++i];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '`': '`', '/': '/' };
        if (Object.hasOwn(escapes, next)) value += escapes[next];
        else { valid = false; value += next ?? ''; }
      }
      if (!ended) return [];
      tokens.push({ kind: valid ? 'literal' : 'unknown', value }); continue;
    }
    // Regex literals and division are outside this parser's contract; never inspect them as calls.
    if (char === '/') return [];
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(source.slice(i));
    if (identifier) { tokens.push({ kind: 'identifier', value: identifier[0] }); i += identifier[0].length; continue; }
    const number = /^-?\d+(?:\.\d+)?/u.exec(source.slice(i));
    if (number) { tokens.push({ kind: 'literal', value: Number(number[0]) }); i += number[0].length; continue; }
    tokens.push({ kind: 'punctuation', value: char }); i++;
  }
  return tokens;
}

function literalArgument(tokens, start, depth = 0) {
  if (depth > 12 || !tokens[start]) return null;
  const token = tokens[start];
  if (token.kind === 'literal') return { value: token.value, end: start + 1 };
  if (['true', 'false', 'null'].includes(token.value)) return { value: JSON.parse(token.value), end: start + 1 };
  if (!['{', '['].includes(token.value)) return null;
  const array = token.value === '[', close = array ? ']' : '}', value = array ? [] : Object.create(null);
  let i = start + 1;
  while (tokens[i] && tokens[i].value !== close) {
    let key;
    if (!array) {
      if (!['literal', 'identifier'].includes(tokens[i].kind) || tokens[i + 1]?.value !== ':') return null;
      key = tokens[i].value; i += 2;
    }
    const parsed = literalArgument(tokens, i, depth + 1);
    if (!parsed) return null;
    if (array) value.push(parsed.value); else value[key] = parsed.value;
    i = parsed.end;
    if (tokens[i]?.value === ',') i++;
    else if (tokens[i]?.value !== close) return null;
  }
  return tokens[i]?.value === close ? { value, end: i + 1 } : null;
}

function wrapperKind(source) {
  const tokens = wrapperTokens(source), kinds = [];
  for (let i = 0; i < tokens.length - 4; i++) {
    if (tokens[i].kind !== 'identifier' || tokens[i].value !== 'tools' || tokens[i - 1]?.value === '.'
      || tokens[i + 1].value !== '.' || tokens[i + 2].kind !== 'identifier' || tokens[i + 3].value !== '(') continue;
    const name = tokens[i + 2].value;
    if (name === 'exec') { kinds.push('general'); continue; }
    const parsed = literalArgument(tokens, i + 4);
    if (!parsed || tokens[parsed.end]?.value !== ')') kinds.push('general');
    else { kinds.push(classifyActivity(name, parsed.value, false)); i = parsed.end; }
  }
  return combine(kinds);
}

export function classifyActivity(toolName, input, allowWrapper = true) {
  if (typeof toolName !== 'string' || toolName.length > 200) return 'general';
  const name = toolName.replace(/^(?:functions|collaboration|web|image_gen)\./u, '');
  // Freeform source is source, including its string literals. JSON-unwrapping it could turn an
  // inert quoted string into a fake tools call that was never part of the executable wrapper.
  if (name === 'exec') return allowWrapper ? wrapperKind(typeof input === 'string' ? input : input?.code) : 'general';
  let args = input;
  if (typeof input === 'string' && input.length <= LIMIT) {
    try { args = JSON.parse(input); } catch { /* Freeform patch/exec bodies are handled below. */ }
  }
  if (['apply_patch'].includes(name)) return patchKind(typeof args === 'string' ? args : args?.patch ?? args?.input);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return pathKind(args?.file_path ?? args?.path ?? args?.notebook_path);
  if (['Read', 'read_file', 'view_image'].includes(name)) return 'reviewing';
  if (['Bash', 'exec_command'].includes(name)) return commandKind(args?.command ?? args?.cmd);
  if (['Grep', 'Glob', 'WebSearch', 'WebFetch', 'web__run'].includes(name) || name === 'run' && toolName.startsWith('web.')) return 'research';
  if (['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'update_plan', 'create_goal'].includes(name)) return 'planning';
  if (['Agent', 'Task', 'SendMessage', 'spawn_agent', 'send_message', 'followup_task', 'send_message_to_thread'].includes(name)) return 'delivery';
  if (['imagegen', 'image_gen__imagegen'].includes(name)) return 'design';
  return 'general';
}

/** Consistent stale-state handling for snapshots and the browser reducer. */
export function nextActivityKind(previous, event, status) {
  if (['idle', 'done', 'waiting'].includes(status) || ['agent.completed', 'agent.retired', 'session.ended'].includes(event.type)
    || event.retired === true || event.sessionEnded === true) return undefined;
  if (isActivityKind(event.activityKind)) return event.activityKind;
  if (event.toolName || ['agent.started', 'task.created', 'user.instruction'].includes(event.type)) return 'general';
  return isActivityKind(previous) ? previous : undefined;
}
