import path from 'node:path';
import { readBlobBySha, walkRepositoryFiles } from './git.mjs';

const languageByExtension = new Map([
  ['.js', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.jsx', 'JavaScript'], ['.py', 'Python'], ['.go', 'Go'], ['.rs', 'Rust'], ['.java', 'Java'], ['.kt', 'Kotlin'],
  ['.swift', 'Swift'], ['.php', 'PHP'], ['.rb', 'Ruby'], ['.cs', 'C#'], ['.cpp', 'C++'], ['.c', 'C'], ['.h', 'C/C++'],
  ['.html', 'HTML'], ['.css', 'CSS'], ['.scss', 'SCSS'], ['.sql', 'SQL'], ['.sh', 'Shell'], ['.dart', 'Dart'],
]);

const secretPatterns = [
  { name: 'Possible hard-coded secret', regex: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["'][^"'\n]{10,}["']/gi },
  { name: 'Possible private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Possible AWS key', regex: /AKIA[0-9A-Z]{16}/g },
];

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function analyzeRepository(config, db, repo, ref = repo.default_branch || 'main') {
  const files = walkRepositoryFiles(config, repo.org_slug, repo.slug, ref);
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  const languages = new Map();
  const findings = [];
  let todoCount = 0;
  let secretCount = 0;
  let sourceLines = 0;

  for (const file of files) {
    const extension = path.extname(file.path).toLowerCase();
    const language = languageByExtension.get(extension);
    if (language) languages.set(language, (languages.get(language) ?? 0) + file.size);
    if (file.size > 5 * 1024 * 1024) {
      findings.push({ severity: 'medium', category: 'performance', title: 'Large file stored in Git', detail: `${file.path} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Consider Git LFS or object storage.` });
    }
    if (file.size > 262144) continue;
    const content = readBlobBySha(config, repo.org_slug, repo.slug, file.sha);
    if (!content) continue;
    sourceLines += content.split('\n').length;
    const todos = content.match(/\b(?:TODO|FIXME|HACK)\b/g);
    todoCount += todos?.length ?? 0;
    for (const pattern of secretPatterns) {
      pattern.regex.lastIndex = 0;
      const matches = content.match(pattern.regex);
      if (matches?.length) {
        secretCount += matches.length;
        findings.push({ severity: 'critical', category: 'security', title: pattern.name, detail: `${file.path} contains ${matches.length} suspicious pattern${matches.length > 1 ? 's' : ''}. Rotate exposed credentials and move secrets to a vault.` });
      }
    }
  }

  const hasReadme = [...byPath.keys()].some((name) => /^readme(?:\.|$)/.test(path.basename(name)));
  const hasLicense = [...byPath.keys()].some((name) => /^licen[cs]e(?:\.|$)/.test(path.basename(name)));
  const hasTests = files.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(file.path));
  const hasCi = files.some((file) => /^\.github\/workflows\/.+\.ya?ml$/i.test(file.path) || /^\.gitlab-ci\.yml$/i.test(file.path));
  const hasLock = files.some((file) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|cargo\.lock|go\.sum)$/i.test(file.path));
  const hasSecurity = files.some((file) => /(^|\/)security\.md$/i.test(file.path));
  const hasContributing = files.some((file) => /(^|\/)contributing\.md$/i.test(file.path));

  if (!hasReadme) findings.push({ severity: 'high', category: 'documentation', title: 'README is missing', detail: 'Add setup, architecture, development and deployment instructions.' });
  if (!hasLicense) findings.push({ severity: 'medium', category: 'governance', title: 'License file is missing', detail: 'Define whether the repository is proprietary or open source.' });
  if (!hasTests) findings.push({ severity: 'high', category: 'quality', title: 'Automated tests were not detected', detail: 'Add unit tests and critical-path integration tests.' });
  if (!hasCi) findings.push({ severity: 'high', category: 'devops', title: 'CI workflow is missing', detail: 'Run tests, linting and security checks on every pull request.' });
  if (!hasLock) findings.push({ severity: 'medium', category: 'supply-chain', title: 'Dependency lockfile was not detected', detail: 'Commit a lockfile for reproducible builds.' });
  if (!hasSecurity) findings.push({ severity: 'low', category: 'security', title: 'Security policy is missing', detail: 'Add SECURITY.md with private vulnerability-reporting instructions.' });
  if (!hasContributing) findings.push({ severity: 'low', category: 'collaboration', title: 'Contribution guide is missing', detail: 'Document branch, commit, review and release conventions.' });
  if (todoCount > 20) findings.push({ severity: 'medium', category: 'maintainability', title: 'High TODO/FIXME count', detail: `${todoCount} unresolved markers were found. Convert them into tracked issues.` });

  const openIssues = db.prepare("SELECT COUNT(*) AS count FROM issues WHERE repository_id = ? AND status = 'open'").get(repo.id).count;
  const openPulls = db.prepare("SELECT COUNT(*) AS count FROM pull_requests WHERE repository_id = ? AND status = 'open'").get(repo.id).count;

  const penalty = findings.reduce((sum, item) => sum + ({ critical: 18, high: 10, medium: 5, low: 2 }[item.severity] ?? 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const languageTotal = [...languages.values()].reduce((sum, value) => sum + value, 0) || 1;
  const languageBreakdown = [...languages.entries()].map(([name, bytes]) => ({ name, bytes, percentage: Math.round((bytes / languageTotal) * 1000) / 10 })).sort((a, b) => b.bytes - a.bytes);

  return {
    engine: 'KukAI Local Repository Analyzer v0.1',
    mode: 'deterministic',
    generatedAt: new Date().toISOString(),
    ref,
    score,
    grade: grade(score),
    summary: score >= 85 ? 'Repository foundations are strong.' : score >= 70 ? 'Repository is healthy but has important improvement areas.' : 'Repository needs focused security, quality and delivery improvements.',
    metrics: { files: files.length, sourceLines, totalBytes: files.reduce((sum, file) => sum + file.size, 0), todoCount, secretCount, openIssues, openPulls },
    checks: { readme: hasReadme, license: hasLicense, tests: hasTests, ci: hasCi, lockfile: hasLock, securityPolicy: hasSecurity, contributingGuide: hasContributing },
    languages: languageBreakdown,
    findings: findings.sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 }[a.severity] - ({ critical: 0, high: 1, medium: 2, low: 3 }[b.severity]))),
    recommendations: findings.slice(0, 5).map((item) => item.detail),
  };
}
