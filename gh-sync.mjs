#!/usr/bin/env node

/**
 * gh-sync.mjs - GitHub Issue Sync Tool
 *
 * Synchronizes GitHub issues with local .json + .md files.
 *
 * Usage:
 *   node gh-sync.mjs pull <number>     # Pull issue from GitHub
 *   node gh-sync.mjs pull --all        # Pull all issues
 *   node gh-sync.mjs push <number>     # Push issue to GitHub
 *   node gh-sync.mjs push --all        # Push all issues
 *   node gh-sync.mjs diff <number>     # Show diff between local and GitHub
 *   node gh-sync.mjs status            # Show sync status of all issues
 *   node gh-sync.mjs create <slug>     # Create new issue from template
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

// Configuration
const CONFIG = {
  repo: 'michaelstingl/cnrz-ctt',
  issuesDir: './issues',
  // Fields that exist only locally and should never be overwritten by pull
  localOnlyFields: [
    'hub_projekt',
    'typ',
    'technologie_steckbrief',
    'related_issues',
    'body_file'
  ],
  // GitHub fields to sync
  githubFields: [
    'issue_number',
    'repo',
    'title',
    'state',
    'labels',
    'assignees',
    'milestone',
    'created',
    'updated'
  ]
};

// ============================================================================
// Utility Functions
// ============================================================================

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    console.error(error.message);
    process.exit(1);
  }
}

function execSafe(cmd) {
  try {
    return { success: true, output: execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function readMd(filePath) {
  return readFileSync(filePath, 'utf-8');
}

function writeMd(filePath, content) {
  // Ensure content ends with newline
  const normalized = content.endsWith('\n') ? content : content + '\n';
  writeFileSync(filePath, normalized);
}

// ============================================================================
// File Discovery
// ============================================================================

function findIssueFiles(issueNumber) {
  const files = readdirSync(CONFIG.issuesDir);
  const pattern = new RegExp(`^${issueNumber}-.*\\.json$`);
  const jsonFile = files.find(f => pattern.test(f));

  if (!jsonFile) {
    return null;
  }

  const mdFile = jsonFile.replace('.json', '.md');
  return {
    json: join(CONFIG.issuesDir, jsonFile),
    md: join(CONFIG.issuesDir, mdFile),
    slug: jsonFile.replace(/^\d+-/, '').replace('.json', '')
  };
}

function findAllIssueNumbers() {
  const files = readdirSync(CONFIG.issuesDir);
  const numbers = new Set();

  for (const file of files) {
    const match = file.match(/^(\d+)-.*\.json$/);
    if (match) {
      numbers.add(parseInt(match[1], 10));
    }
  }

  return Array.from(numbers).sort((a, b) => a - b);
}

function slugify(title) {
  // [CTT] [Migration] Kafka -> kafka-migration
  return title
    .toLowerCase()
    .replace(/\[.*?\]/g, '')  // Remove [tags]
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// GitHub API
// ============================================================================

function fetchIssue(issueNumber) {
  const fields = 'number,title,state,labels,assignees,milestone,body,createdAt,updatedAt';
  const result = exec(`gh issue view ${issueNumber} --repo ${CONFIG.repo} --json ${fields}`);
  return JSON.parse(result);
}

function updateIssue(issueNumber, { title, bodyFile, labels }) {
  let cmd = `gh issue edit ${issueNumber} --repo ${CONFIG.repo}`;

  if (title) {
    cmd += ` --title "${title.replace(/"/g, '\\"')}"`;
  }

  if (bodyFile && existsSync(bodyFile)) {
    cmd += ` --body-file "${bodyFile}"`;
  }

  exec(cmd);

  // Sync labels separately (to handle add/remove)
  if (labels) {
    syncLabels(issueNumber, labels);
  }
}

function syncLabels(issueNumber, targetLabels) {
  // Get current labels
  const result = exec(`gh issue view ${issueNumber} --repo ${CONFIG.repo} --json labels`);
  const currentLabels = JSON.parse(result).labels.map(l => l.name);

  // Calculate diff
  const toAdd = targetLabels.filter(l => !currentLabels.includes(l));
  const toRemove = currentLabels.filter(l => !targetLabels.includes(l));

  // Add new labels
  if (toAdd.length > 0) {
    const addCmd = `gh issue edit ${issueNumber} --repo ${CONFIG.repo} --add-label "${toAdd.join(',')}"`;
    execSafe(addCmd);
  }

  // Remove old labels
  for (const label of toRemove) {
    const removeCmd = `gh issue edit ${issueNumber} --repo ${CONFIG.repo} --remove-label "${label}"`;
    execSafe(removeCmd);
  }
}

// ============================================================================
// Commands
// ============================================================================

function pull(issueNumber) {
  console.log(`Pulling issue #${issueNumber}...`);

  // Fetch from GitHub
  const ghIssue = fetchIssue(issueNumber);

  // Find local files
  let files = findIssueFiles(issueNumber);

  if (!files) {
    // Create new files
    const slug = slugify(ghIssue.title);
    files = {
      json: join(CONFIG.issuesDir, `${issueNumber}-${slug}.json`),
      md: join(CONFIG.issuesDir, `${issueNumber}-${slug}.md`),
      slug
    };
    console.log(`  Creating new files: ${issueNumber}-${slug}.*`);
  }

  // Read existing local JSON (if exists) to preserve local-only fields
  let localJson = {};
  if (existsSync(files.json)) {
    localJson = readJson(files.json);
  }

  // Build merged JSON
  const merged = {
    issue_number: ghIssue.number,
    repo: CONFIG.repo,
    title: ghIssue.title,
    state: ghIssue.state.toLowerCase(),
    labels: ghIssue.labels.map(l => l.name),
    assignees: ghIssue.assignees.map(a => a.login),
    milestone: ghIssue.milestone?.title || null,
    // Preserve local-only fields
    ...Object.fromEntries(
      CONFIG.localOnlyFields
        .filter(f => localJson[f] !== undefined)
        .map(f => [f, localJson[f]])
    ),
    body_file: localJson.body_file || `${issueNumber}-${files.slug}.md`,
    created: ghIssue.createdAt.split('T')[0],
    updated: ghIssue.updatedAt.split('T')[0]
  };

  // Write files
  writeJson(files.json, merged);
  writeMd(files.md, ghIssue.body || '');

  console.log(`  ✓ Updated ${basename(files.json)}`);
  console.log(`  ✓ Updated ${basename(files.md)}`);
  console.log(`  Labels: ${merged.labels.join(', ') || '(none)'}`);
}

function push(issueNumber) {
  console.log(`Pushing issue #${issueNumber}...`);

  const files = findIssueFiles(issueNumber);
  if (!files) {
    console.error(`  ✗ No local files found for issue #${issueNumber}`);
    process.exit(1);
  }

  const localJson = readJson(files.json);

  // Update GitHub
  updateIssue(issueNumber, {
    title: localJson.title,
    bodyFile: files.md,
    labels: localJson.labels || []
  });

  console.log(`  ✓ Updated title: ${localJson.title}`);
  console.log(`  ✓ Updated body from ${basename(files.md)}`);
  console.log(`  ✓ Synced labels: ${(localJson.labels || []).join(', ') || '(none)'}`);
}

function diff(issueNumber) {
  console.log(`Diff for issue #${issueNumber}:\n`);

  const files = findIssueFiles(issueNumber);
  if (!files) {
    console.error(`No local files found for issue #${issueNumber}`);
    process.exit(1);
  }

  const localJson = readJson(files.json);
  const localMd = readMd(files.md);
  const ghIssue = fetchIssue(issueNumber);

  // Compare metadata
  const metaDiffs = [];

  // Title
  if (localJson.title !== ghIssue.title) {
    metaDiffs.push({ field: 'title', local: localJson.title, github: ghIssue.title });
  }

  // State
  if (localJson.state !== ghIssue.state.toLowerCase()) {
    metaDiffs.push({ field: 'state', local: localJson.state, github: ghIssue.state.toLowerCase() });
  }

  // Labels
  const localLabels = (localJson.labels || []).sort();
  const ghLabels = ghIssue.labels.map(l => l.name).sort();
  const labelsAdded = localLabels.filter(l => !ghLabels.includes(l));
  const labelsRemoved = ghLabels.filter(l => !localLabels.includes(l));
  if (labelsAdded.length > 0 || labelsRemoved.length > 0) {
    metaDiffs.push({
      field: 'labels',
      added: labelsAdded,
      removed: labelsRemoved
    });
  }

  // Body
  const localBody = localMd.trim();
  const ghBody = (ghIssue.body || '').trim();
  const bodyDiffers = localBody !== ghBody;

  // Output
  if (metaDiffs.length === 0 && !bodyDiffers) {
    console.log('✓ Local and GitHub are in sync');
    return;
  }

  // Metadata diff
  if (metaDiffs.length > 0) {
    console.log('── Metadata (.json) ──\n');
    for (const d of metaDiffs) {
      if (d.field === 'labels') {
        console.log('  labels:');
        for (const l of d.removed) {
          console.log(`    \x1b[31m- ${l}\x1b[0m`);
        }
        for (const l of d.added) {
          console.log(`    \x1b[32m+ ${l}\x1b[0m`);
        }
      } else {
        console.log(`  ${d.field}:`);
        console.log(`    \x1b[31m- ${d.github}\x1b[0m`);
        console.log(`    \x1b[32m+ ${d.local}\x1b[0m`);
      }
      console.log();
    }
  }

  // Body diff
  if (bodyDiffers) {
    console.log('── Body (.md) ──\n');
    console.log(`  Local: ${localBody.length} chars, GitHub: ${ghBody.length} chars\n`);
    showLineDiff(localBody, ghBody);
  }
}

function showLineDiff(local, remote) {
  const localLines = local.split('\n');
  const remoteLines = remote.split('\n');

  const maxLines = Math.max(localLines.length, remoteLines.length);
  let inDiff = false;
  let diffStart = -1;

  for (let i = 0; i < maxLines; i++) {
    const localLine = localLines[i] || '';
    const remoteLine = remoteLines[i] || '';

    if (localLine !== remoteLine) {
      if (!inDiff) {
        diffStart = i;
        inDiff = true;
        if (i > 0) {
          console.log(`  ${String(i).padStart(3)}   ${localLines[i-1]?.substring(0, 70) || ''}`);
        }
      }
      if (remoteLine && (!localLines[i] || localLine !== remoteLine)) {
        console.log(`  ${String(i+1).padStart(3)} - \x1b[31m${remoteLine.substring(0, 70)}\x1b[0m`);
      }
      if (localLine && (!remoteLines[i] || localLine !== remoteLine)) {
        console.log(`  ${String(i+1).padStart(3)} + \x1b[32m${localLine.substring(0, 70)}\x1b[0m`);
      }
    } else if (inDiff) {
      console.log(`  ${String(i+1).padStart(3)}   ${localLine.substring(0, 70)}`);
      inDiff = false;
      console.log();
    }
  }
}

function status() {
  console.log(`Sync status for ${CONFIG.repo}:\n`);

  const issueNumbers = findAllIssueNumbers();

  if (issueNumbers.length === 0) {
    console.log('No local issues found.');
    return;
  }

  for (const num of issueNumbers) {
    const files = findIssueFiles(num);
    const localJson = readJson(files.json);

    // Fetch GitHub (with error handling)
    const result = execSafe(`gh issue view ${num} --repo ${CONFIG.repo} --json title,state,labels,updatedAt`);

    if (!result.success) {
      console.log(`#${num} ${localJson.title}`);
      console.log(`    ⚠ Not found on GitHub\n`);
      continue;
    }

    const ghIssue = JSON.parse(result.output);
    const ghLabels = ghIssue.labels.map(l => l.name).sort();
    const localLabels = (localJson.labels || []).sort();

    const titleMatch = localJson.title === ghIssue.title;
    const labelsMatch = JSON.stringify(localLabels) === JSON.stringify(ghLabels);
    const stateMatch = localJson.state === ghIssue.state.toLowerCase();

    const inSync = titleMatch && labelsMatch && stateMatch;
    const icon = inSync ? '✓' : '⚠';

    console.log(`${icon} #${num} ${localJson.title}`);

    if (!inSync) {
      if (!titleMatch) console.log(`    Title differs`);
      if (!labelsMatch) console.log(`    Labels differ: local(${localLabels.length}) vs github(${ghLabels.length})`);
      if (!stateMatch) console.log(`    State differs: ${localJson.state} vs ${ghIssue.state.toLowerCase()}`);
    }

    console.log(`    Labels: ${localLabels.join(', ') || '(none)'}`);
    console.log();
  }
}

function create(slug) {
  console.log(`Creating new issue: ${slug}`);

  // Find next issue number
  const existing = findAllIssueNumbers();
  const nextNumber = existing.length > 0 ? Math.max(...existing) + 1 : 1;

  // Create files
  const jsonFile = join(CONFIG.issuesDir, `${nextNumber}-${slug}.json`);
  const mdFile = join(CONFIG.issuesDir, `${nextNumber}-${slug}.md`);

  if (existsSync(jsonFile)) {
    console.error(`File already exists: ${jsonFile}`);
    process.exit(1);
  }

  // Template
  const title = `[CTT] ${slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`;

  const json = {
    issue_number: null,  // Will be set after GitHub create
    repo: CONFIG.repo,
    title: title,
    state: 'open',
    labels: [],
    assignees: [],
    milestone: null,
    body_file: `${nextNumber}-${slug}.md`,
    created: new Date().toISOString().split('T')[0],
    updated: new Date().toISOString().split('T')[0]
  };

  const md = `## Übersicht

| Aspekt | Details |
|--------|---------|
| **TODO** | Beschreibung |

## TODO

- [ ] Aufgabe 1
- [ ] Aufgabe 2
`;

  writeJson(jsonFile, json);
  writeMd(mdFile, md);

  console.log(`  ✓ Created ${basename(jsonFile)}`);
  console.log(`  ✓ Created ${basename(mdFile)}`);
  console.log(`\nEdit the files, then run:`);
  console.log(`  gh issue create --repo ${CONFIG.repo} --title "${title}" --body-file "${mdFile}"`);
  console.log(`  # Then update ${basename(jsonFile)} with the issue number`);
}

// ============================================================================
// CLI
// ============================================================================

function printUsage() {
  console.log(`
gh-sync.mjs - GitHub Issue Sync Tool

Usage:
  node gh-sync.mjs pull <number>     Pull issue from GitHub to local
  node gh-sync.mjs pull --all        Pull all local issues
  node gh-sync.mjs push <number>     Push local issue to GitHub
  node gh-sync.mjs push --all        Push all local issues
  node gh-sync.mjs diff <number>     Show line-by-line diff (local vs GitHub)
  node gh-sync.mjs status            Show sync status of all issues
  node gh-sync.mjs create <slug>     Create new issue template
  node gh-sync.mjs --help            Show this help

Local-only fields (preserved on pull):
  hub_projekt, typ, technologie_steckbrief, related_issues, body_file

Examples:
  node gh-sync.mjs pull 1
  node gh-sync.mjs push --all
  node gh-sync.mjs diff 2
  node gh-sync.mjs create kafka-migration
`);
}

const [,, command, arg] = process.argv;

if (!command) {
  printUsage();
  process.exit(0);
}

switch (command) {
  case '--help':
  case '-h':
  case 'help':
    printUsage();
    break;

  case 'pull':
    if (arg === '--all') {
      const numbers = findAllIssueNumbers();
      for (const num of numbers) {
        pull(num);
        console.log();
      }
    } else if (arg) {
      pull(parseInt(arg, 10));
    } else {
      console.error('Usage: gh-sync.mjs pull <number|--all>');
      process.exit(1);
    }
    break;

  case 'push':
    if (arg === '--all') {
      const numbers = findAllIssueNumbers();
      for (const num of numbers) {
        push(num);
        console.log();
      }
    } else if (arg) {
      push(parseInt(arg, 10));
    } else {
      console.error('Usage: gh-sync.mjs push <number|--all>');
      process.exit(1);
    }
    break;

  case 'diff':
    if (arg) {
      diff(parseInt(arg, 10));
    } else {
      console.error('Usage: gh-sync.mjs diff <number>');
      process.exit(1);
    }
    break;

  case 'status':
    status();
    break;

  case 'create':
    if (arg) {
      create(arg);
    } else {
      console.error('Usage: gh-sync.mjs create <slug>');
      process.exit(1);
    }
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
