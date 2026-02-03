import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Stat = { lines: number; hits: number };

let statusBarItem: vscode.StatusBarItem;
let coverageMap: Map<string, Stat> = new Map();

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1000);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('coverageStatus.refresh', async () => {
      await updateCoverage();
      vscode.window.showInformationMessage('Coverage refreshed');
    })
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBar));

  updateCoverage();
}

async function updateCoverage() {
  coverageMap = await buildCoverageMap();
  updateStatusBar();
}

function updateStatusBar() {
  const editor = vscode.window.activeTextEditor;
  if (editor && (editor.document.uri.scheme === 'file' || editor.document.uri.scheme === 'vscode-remote')) {
    const filePath = path.normalize(editor.document.uri.fsPath);
    console.log('Active file path:', filePath);
    const stat = findBestMatch(filePath, coverageMap);
    console.log('Coverage stat found:', !!stat, stat ? `${stat.hits}/${stat.lines}` : '');
    const fileName = path.basename(filePath);
    if (stat) {
      const pct = stat.lines > 0 ? Math.round((stat.hits / stat.lines) * 100) : 0;
      statusBarItem.text = `${fileName}: ${pct}%`;
    } else {
      statusBarItem.text = `${fileName}: unknown`;
    }
  } else {
    statusBarItem.text = 'No file';
  }
}

async function buildCoverageMap(): Promise<Map<string, Stat>> {
  const map = new Map<string, Stat>();
  const patterns = getLcovGlobs();
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    for (const p of patterns) {
      const rel = new vscode.RelativePattern(folder, p);
      const files = await vscode.workspace.findFiles(rel, '**/node_modules/**');
      console.log(`Found ${files.length} potential LCOV files for pattern ${p}`);
      for (const file of files) {
        try {
          let content: string;
          try {
            content = await fs.promises.readFile(file.fsPath, 'utf8');
          } catch (e) {
            const bytes = await (vscode.workspace as any).fs.readFile(file);
            content = Buffer.from(bytes).toString('utf8');
          }
          if (!content.includes('SF:')) continue; // Skip non-LCOV files
          const perFile = parseLcov(content, file.fsPath);
          console.log(`Parsed ${perFile.size} files from ${file.fsPath}`);
          for (const [sf, stat] of perFile) {
            // Merge if multiple LCOV files cover the same file
            const existing = map.get(sf);
            if (existing) {
              existing.lines += stat.lines;
              existing.hits += stat.hits;
            } else {
              map.set(sf, { lines: stat.lines, hits: stat.hits });
            }
          }
        } catch (e) {
          console.warn('Error reading/parsing LCOV file:', file.fsPath, e);
        }
      }
    }
  }
  console.log('Total coverage map size:', map.size);
  if (map.size > 0) {
    console.log('Sample map keys:', Array.from(map.keys()).slice(0, 3));
  }
  return map;
}

function getLcovGlobs(): string[] {
  const cfg = vscode.workspace.getConfiguration('coverageStatus');
  const g = cfg.get<string[]>('lcovGlob');
  if (Array.isArray(g) && g.length > 0) return g;
  return ['**/lcov.info', '**/*.lcov', 'build/**/*.lcov', , 'build/coverage/*.lcov'];
}

function parseLcov(content: string, lcovPath: string): Map<string, Stat> {
  const result = new Map<string, Stat>();
  const lines = content.split(/\r?\n/);
  let currentFile: string | undefined;
  let recLF: number | undefined;
  let recLH: number | undefined;
  let recDA_total = 0;
  let recDA_hits = 0;

  function flushRecord() {
    if (!currentFile) return;
    let lines = 0, hits = 0;
    if (typeof recLF === 'number' && typeof recLH === 'number') {
      lines = recLF;
      hits = recLH;
    } else if (recDA_total > 0) {
      lines = recDA_total;
      hits = recDA_hits;
    }
    if (lines > 0 || hits > 0) {
      result.set(currentFile, { lines, hits });
    }
    recLF = undefined;
    recLH = undefined;
    recDA_total = 0;
    recDA_hits = 0;
    currentFile = undefined;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('SF:')) {
      flushRecord();
      const sfPath = trimmed.substring(3).trim();
      currentFile = path.isAbsolute(sfPath) ? path.normalize(sfPath) : path.normalize(path.resolve(path.dirname(lcovPath), sfPath));
    } else if (trimmed.startsWith('LF:')) {
      const val = parseInt(trimmed.substring(3).trim(), 10);
      if (!isNaN(val)) recLF = val;
    } else if (trimmed.startsWith('LH:')) {
      const val = parseInt(trimmed.substring(3).trim(), 10);
      if (!isNaN(val)) recLH = val;
    } else if (trimmed.startsWith('DA:')) {
      const parts = trimmed.substring(3).trim().split(',');
      if (parts.length >= 2) {
        const cnt = parseInt(parts[1].trim(), 10);
        if (!isNaN(cnt)) {
          recDA_total++;
          if (cnt > 0) recDA_hits++;
        }
      }
    } else if (trimmed === 'end_of_record') {
      flushRecord();
    }
  }
  flushRecord();
  return result;
}

function findBestMatch(targetPath: string, map: Map<string, Stat>): Stat | undefined {
  const normTarget = path.normalize(targetPath);
  if (map.has(normTarget)) return map.get(normTarget);

  const base = path.basename(normTarget);
  const candidates: Array<{ key: string; stat: Stat }> = [];
  for (const [k, v] of map.entries()) if (path.basename(k) === base) candidates.push({ key: k, stat: v });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].stat;

  let best: { key: string; stat: Stat; score: number } | undefined;
  const tParts = normTarget.split(path.sep).reverse();
  for (const c of candidates) {
    const kParts = c.key.split(path.sep).reverse();
    let score = 0; const max = Math.min(kParts.length, tParts.length);
    for (let i = 0; i < max; i++) { if (kParts[i] === tParts[i]) score++; else break; }
    if (!best || score > best.score) best = { key: c.key, stat: c.stat, score };
  }
  if (best && best.score > 0) return best.stat;
  return undefined;
}

export function deactivate() {
  statusBarItem.dispose();
}
