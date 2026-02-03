import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Stat = { lines: number; hits: number };
type FileDetail = { stat: Stat; uncovered: number[] };

let statusBarItem: vscode.StatusBarItem;
let watchers: vscode.FileSystemWatcher[] = [];
let updateTimer: NodeJS.Timeout | undefined;
let coverageMap: Map<string, FileDetail> = new Map();
let aggregated: Stat = { lines: 0, hits: 0 };

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = 'Coverage';
  statusBarItem.tooltip = 'Code coverage status (per-file for active editor)';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('coverageStatus.refresh', async () => {
      await updateCoverage();
      vscode.window.showInformationMessage('Coverage status refreshed');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('coverageStatus.showFiles', async () => {
      const map = await buildCoverageMap();
      const items = Array.from(map.entries()).map(([k, d]) => ({ label: `${computePct(d.stat.hits, d.stat.lines)}%`, description: k, detail: d.uncovered.length ? `${d.uncovered.length} uncovered lines` : 'Fully covered' }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a file to inspect uncovered lines' });
      if (pick) {
        const detail = map.get(pick.description!);
        if (detail) {
          if (detail.uncovered.length === 0) {
            vscode.window.showInformationMessage(`${path.basename(pick.description!)} is fully covered`);
          } else {
            const asText = detail.uncovered.slice(0, 200).join(', ');
            vscode.window.showInformationMessage(`Uncovered lines for ${path.basename(pick.description!)}: ${asText}`);
          }
        }
      }
    })
  );

  const patterns = getLcovGlobs();
  for (const p of patterns) {
    const w = vscode.workspace.createFileSystemWatcher(p);
    w.onDidChange(() => scheduleUpdate());
    w.onDidCreate(() => scheduleUpdate());
    w.onDidDelete(() => scheduleUpdate());
    watchers.push(w);
    context.subscriptions.push(w);
  }

  // Watch active editor and saves so we update the displayed per-file coverage
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => scheduleUpdate(100)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => scheduleUpdate(100)));

  updateCoverage();
}

async function updateCoverage(): Promise<void> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    statusBarItem.text = 'Coverage: workspace not open';
    statusBarItem.color = undefined;
    return;
  }

  try {
    coverageMap = await buildCoverageMap();
    aggregated = { lines: 0, hits: 0 };
    for (const v of coverageMap.values()) {
      aggregated.lines += v.stat.lines;
      aggregated.hits += v.stat.hits;
    }

    const editor = vscode.window.activeTextEditor;
    let numericPct: number | undefined;
    let displayText = 'Coverage';
    let tooltip = `Workspace coverage: ${formatPct(aggregated.hits, aggregated.lines)}`;

    if (editor && editor.document && editor.document.uri && editor.document.uri.scheme === 'file') {
      const activeFs = path.normalize(editor.document.uri.fsPath);
      const detail = findBestMatchForPath(activeFs, coverageMap);
      if (detail) {
        const p = computePct(detail.stat.hits, detail.stat.lines);
        if (Number.isFinite(p)) numericPct = p;
        displayText = `${path.basename(activeFs)}: ${numericPct !== undefined ? numericPct + '%' : 'unknown'}`;
        tooltip = `${path.basename(activeFs)}: ${numericPct !== undefined ? numericPct + '%' : 'unknown'} • Workspace: ${formatPct(aggregated.hits, aggregated.lines)}`;
      } else if (aggregated.lines > 0) {
        const p = computePct(aggregated.hits, aggregated.lines);
        if (Number.isFinite(p)) numericPct = p;
        displayText = `Workspace: ${numericPct !== undefined ? numericPct + '%' : 'unknown'}`;
        tooltip = `Workspace coverage: ${numericPct !== undefined ? numericPct + '%' : 'unknown'}`;
      }
    } else {
      if (aggregated.lines > 0) {
        const p = computePct(aggregated.hits, aggregated.lines);
        if (Number.isFinite(p)) numericPct = p;
        displayText = `Workspace: ${numericPct !== undefined ? numericPct + '%' : 'unknown'}`;
        tooltip = `Workspace coverage: ${numericPct !== undefined ? numericPct + '%' : 'unknown'}`;
      }
    }

    statusBarItem.text = displayText;
    statusBarItem.tooltip = tooltip;
    // Do not set any colors on the status bar item; show filename only.
    statusBarItem.color = undefined;
  } catch (err) {
    statusBarItem.text = 'Coverage: unknown';
    statusBarItem.color = undefined;
  }
}

async function buildCoverageMap(): Promise<Map<string, FileDetail>> {
  const map = new Map<string, FileDetail>();
  const patterns = getLcovGlobs();
  const rootExclude = '**/node_modules/**';
  const uriSet = new Set<string>();
  for (const p of patterns) {
    const found = await vscode.workspace.findFiles(p, rootExclude);
    for (const u of found) uriSet.add(u.fsPath);
  }

  for (const filePath of uriSet) {
    let content: string | undefined;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
      try {
        const bytes = await (vscode.workspace as any).fs.readFile(vscode.Uri.file(filePath));
        content = Buffer.from(bytes).toString('utf8');
      } catch (e2) {
        continue;
      }
    }
    if (!content) continue;
    const perFile = parseLcovToMap(content, filePath);
    for (const [sf, detail] of perFile) {
      const prev = map.get(sf);
      if (prev) {
        prev.stat.lines += detail.stat.lines;
        prev.stat.hits += detail.stat.hits;
        prev.uncovered = Array.from(new Set(prev.uncovered.concat(detail.uncovered))).sort((a,b)=>a-b);
        map.set(sf, prev);
      } else {
        map.set(sf, { stat: { lines: detail.stat.lines, hits: detail.stat.hits }, uncovered: detail.uncovered });
      }
    }
  }
  return map;
}

function parseLcovToMap(content: string, lcovFilePath: string): Map<string, FileDetail> {
  const rows = content.split(/\r?\n/);
  const result = new Map<string, FileDetail>();
  let currentSF: string | undefined;
  let recLF: number | undefined;
  let recLH: number | undefined;
  let recDA_total = 0;
  let recDA_hits = 0;
  let recDA_uncovered: number[] = [];

  function flushRecord() {
    if (!currentSF) {
      recLF = undefined; recLH = undefined; recDA_total = 0; recDA_hits = 0; recDA_uncovered = []; return;
    }
    let lines = 0, hits = 0;
    if (typeof recLF === 'number' && typeof recLH === 'number') { lines = recLF; hits = recLH; }
    else if (recDA_total > 0) { lines = recDA_total; hits = recDA_hits; }

    let sfPath = currentSF;
    try {
      if (!path.isAbsolute(sfPath)) sfPath = path.normalize(path.resolve(path.dirname(lcovFilePath), sfPath));
      else sfPath = path.normalize(sfPath);
    } catch {
      sfPath = path.normalize(sfPath);
    }
    result.set(sfPath, { stat: { lines, hits }, uncovered: recDA_uncovered.slice() });
    recLF = undefined; recLH = undefined; recDA_total = 0; recDA_hits = 0; recDA_uncovered = []; currentSF = undefined;
  }

  for (const r of rows) {
    if (!r) continue;
    if (r.startsWith('SF:')) {
      currentSF = r.substring(3).trim();
    } else if (r.startsWith('LF:')) {
      const v = parseInt(r.substring(3), 10); if (!isNaN(v)) recLF = v;
    } else if (r.startsWith('LH:')) {
      const v = parseInt(r.substring(3), 10); if (!isNaN(v)) recLH = v;
    } else if (r.startsWith('DA:')) {
      const parts = r.substring(3).split(','); const lineNum = parseInt(parts[0] || '0', 10); const cnt = parseInt(parts[1] || '0', 10);
      recDA_total++; if (cnt > 0) recDA_hits++; else recDA_uncovered.push(lineNum);
    } else if (r === 'end_of_record') {
      flushRecord();
    }
  }
  flushRecord();
  return result;
}

function findBestMatchForPath(targetPath: string, map: Map<string, FileDetail>): FileDetail | undefined {
  const normTarget = path.normalize(targetPath);
  if (map.has(normTarget)) return map.get(normTarget);

  const base = path.basename(normTarget);
  const candidates: Array<{key: string; detail: FileDetail}> = [];
  for (const [k, v] of map.entries()) if (path.basename(k) === base) candidates.push({ key: k, detail: v });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].detail;

  let best: {key: string; detail: FileDetail; score: number} | undefined;
  const tParts = normTarget.split(path.sep).reverse();
  for (const c of candidates) {
    const kParts = c.key.split(path.sep).reverse();
    let score = 0; const max = Math.min(kParts.length, tParts.length);
    for (let i = 0; i < max; i++) { if (kParts[i] === tParts[i]) score++; else break; }
    if (!best || score > best.score) best = { key: c.key, detail: c.detail, score };
  }
  if (best && best.score > 0) return best.detail;
  return undefined;
}

function getLcovGlobs(): string[] {
  const cfg = vscode.workspace.getConfiguration('coverageStatus');
  const g = cfg.get<string[]>('lcovGlob');
  if (Array.isArray(g) && g.length > 0) return g;
  return ['**/lcov.info', '**/*.lcov'];
}

function computePct(hits: number, lines: number): number {
  if (lines === 0) return NaN;
  return Math.round((hits / lines) * 100);
}

function formatPct(hits: number, lines: number): string {
  if (lines === 0) return 'unknown';
  return `${computePct(hits, lines)}%`;
}

function scheduleUpdate(delay = 200) {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => { updateCoverage(); updateTimer = undefined; }, delay);
}

export function deactivate() {
  for (const w of watchers) w.dispose();
  statusBarItem?.dispose();
}
