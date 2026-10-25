import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validTitle } from './review-gate-core.mjs';

// 사용자가 명시적으로 실행하는 병합 도구. workflow에서는 호출하지 않는다.
const [repo, number, method = 'squash'] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !/^[1-9][0-9]*$/.test(number ?? '') || !['squash', 'merge'].includes(method)) {
  console.error('사용법: node .github/scripts/merge-pr.mjs owner/repo PR번호 squash|merge');
  process.exit(1);
}
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
let merged = false;
let messageDirectory;
try {
  const pr = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  if (pr.state !== 'open' || pr.draft || !validTitle(pr.title)) throw new Error('PR 상태 또는 제목 규칙 오류');
  gh(['pr', 'checks', number, '--repo', repo, '--required']);
  const statuses = JSON.parse(gh(['api', `repos/${repo}/commits/${pr.head.sha}/status`]));
  const gate = statuses.statuses.find(status => status.context === 'independent-review');
  if (gate?.state !== 'success') throw new Error('최신 independent-review 통과 확인 필요');
  // 셸 문자열을 생성하지 않고 Unicode 인수 배열을 사용한다.
  // UTF-8 파일로 PR 본문과 Issue 자동 종료 키워드를 그대로 보존한다.
  messageDirectory = mkdtempSync(join(tmpdir(), 'starter-merge-'));
  const bodyFile = join(messageDirectory, 'body.txt');
  writeFileSync(bodyFile, pr.body ?? '', { encoding: 'utf8', mode: 0o600 });
  gh(['pr', 'merge', number, '--repo', repo, `--${method}`, '--match-head-commit', pr.head.sha, '--subject', pr.title, '--body-file', bodyFile]);
  merged = true;
  const after = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  if (!after.merged || !after.merge_commit_sha) throw new Error('병합 결과 조회 실패');
  const commit = JSON.parse(gh(['api', `repos/${repo}/commits/${after.merge_commit_sha}`]));
  const subject = commit.commit.message.split('\n')[0];
  if (subject !== pr.title || !validTitle(subject)) throw new Error('저장된 병합 제목 불일치');
  console.log(`병합과 실제 제목 검증 완료: ${after.merge_commit_sha}`);
  console.log(subject);
} catch {
  console.error(merged
    ? '병합 명령은 완료됐지만 사후 검증이 실패했습니다. PR과 실제 병합 커밋을 사람이 확인하세요. 재병합·이력 재작성은 하지 않습니다.'
    : '병합 조건 확인 또는 병합 명령이 실패했습니다. GitHub PR 상태를 확인하세요. 원시 오류·인증값은 출력하지 않습니다.');
  process.exitCode = 1;
} finally {
  if (messageDirectory) rmSync(messageDirectory, { recursive: true, force: true });
}
